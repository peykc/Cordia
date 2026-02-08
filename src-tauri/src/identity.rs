use ed25519_dalek::{SigningKey, VerifyingKey};
use sha2::{Sha256, Digest};
use aes_gcm::{
    aead::{Aead, AeadCore, KeyInit, OsRng},
    Aes256Gcm, Nonce,
};
use chacha20poly1305::XChaCha20Poly1305;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::fs;
use thiserror::Error;

use crate::account_manager::AccountManager;

#[derive(Error, Debug)]
pub enum IdentityError {
    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),
    #[error("Encryption error: {0}")]
    Encryption(String),
    #[error("Decryption error: {0}")]
    Decryption(String),
    #[error("Invalid identity file")]
    InvalidIdentity,
    #[error("Serialization error: {0}")]
    Serialization(#[from] serde_json::Error),
    #[error("Hex decoding error: {0}")]
    HexDecode(String),
    #[error("Account error: {0}")]
    Account(String),
}

#[derive(Serialize, Deserialize, Clone)]
pub struct UserIdentity {
    pub user_id: String,        // Public key hash
    pub display_name: String,
    pub public_key: String,     // Hex-encoded public key
    #[serde(skip_serializing)]
    pub private_key: Option<String>, // Hex-encoded private key (only in memory; not in exports)
}

/// Format stored in keys.dat (encrypted). Includes private_key so it survives save/load.
#[derive(Serialize, Deserialize)]
struct StoredIdentity {
    pub user_id: String,
    pub display_name: String,
    pub public_key: String,
    pub private_key: Option<String>,
}

#[derive(Serialize, Deserialize)]
struct EncryptedIdentity {
    nonce: String,
    ciphertext: String,
    salt: String,
}

pub struct IdentityManager {
    data_dir: PathBuf,
    account_id: Option<String>,
}

impl IdentityManager {
    /// Create an IdentityManager for the current session's account
    /// REQUIRES an active session - no fallback behavior
    pub fn new() -> Result<Self, IdentityError> {
        let account_manager = AccountManager::new()
            .map_err(|e| IdentityError::Account(e.to_string()))?;

        // Check if there's an active session
        let session = account_manager.get_session()
            .map_err(|e| IdentityError::Account(e.to_string()))?;

        if let Some(account_id) = session.current_account_id {
            // Account mode: use account container
            let data_dir = account_manager.get_account_dir(&account_id);
            fs::create_dir_all(&data_dir)?;
            Ok(Self {
                data_dir,
                account_id: Some(account_id),
            })
        } else {
            // NO SESSION - refuse to operate
            // The presence of identity files does NOT imply an active session
            Err(IdentityError::Account("No active session - login required".to_string()))
        }
    }

    /// Create an IdentityManager for a specific account
    /// Used for account operations that don't require an active session
    pub fn for_account(account_id: &str) -> Result<Self, IdentityError> {
        let account_manager = AccountManager::new()
            .map_err(|e| IdentityError::Account(e.to_string()))?;

        let data_dir = account_manager.get_account_dir(account_id);
        fs::create_dir_all(&data_dir)?;

        Ok(Self {
            data_dir,
            account_id: Some(account_id.to_string()),
        })
    }

    /// Check if a specific account has an identity (keys.dat exists)
    /// This does NOT require an active session - used for account listing/selection
    pub fn account_has_identity(account_id: &str) -> Result<bool, IdentityError> {
        let account_manager = AccountManager::new()
            .map_err(|e| IdentityError::Account(e.to_string()))?;
        
        let data_dir = account_manager.get_account_dir(account_id);
        let keys_path = data_dir.join("keys.dat");
        Ok(keys_path.exists())
    }

    fn get_legacy_data_dir() -> Result<PathBuf, IdentityError> {
        // Check for custom data directory (for testing with multiple instances)
        if let Ok(custom_dir) = std::env::var("ROOMMATE_DATA_DIR") {
            let path = PathBuf::from(custom_dir);
            if !path.exists() {
                fs::create_dir_all(&path)
                    .map_err(|e| IdentityError::Io(e))?;
            }
            return Ok(path);
        }

        #[cfg(target_os = "windows")]
        {
            let app_data = std::env::var("APPDATA")
                .map_err(|_| IdentityError::Io(std::io::Error::new(
                    std::io::ErrorKind::NotFound,
                    "APPDATA not found"
                )))?;
            Ok(PathBuf::from(app_data).join("Cordia"))
        }

        #[cfg(target_os = "macos")]
        {
            let home = std::env::var("HOME")
                .map_err(|_| IdentityError::Io(std::io::Error::new(
                    std::io::ErrorKind::NotFound,
                    "HOME not found"
                )))?;
            Ok(PathBuf::from(home).join("Library").join("Application Support").join("Cordia"))
        }

        #[cfg(target_os = "linux")]
        {
            let home = std::env::var("HOME")
                .map_err(|_| IdentityError::Io(std::io::Error::new(
                    std::io::ErrorKind::NotFound,
                    "HOME not found"
                )))?;
            Ok(PathBuf::from(home).join(".config").join("cordia"))
        }

        #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
        {
            Err(IdentityError::Io(std::io::Error::new(
                std::io::ErrorKind::Unsupported,
                "Unsupported platform"
            )))
        }
    }

    fn get_keys_path(&self) -> PathBuf {
        self.data_dir.join("keys.dat")
    }

    pub fn has_identity(&self) -> bool {
        self.get_keys_path().exists()
    }

    /// Get the account ID if in account mode
    pub fn get_account_id(&self) -> Option<&str> {
        self.account_id.as_deref()
    }

    pub fn generate_keypair() -> (SigningKey, VerifyingKey) {
        let signing_key = SigningKey::generate(&mut OsRng);
        let verifying_key = signing_key.verifying_key();
        (signing_key, verifying_key)
    }

    pub fn create_identity(display_name: String) -> Result<UserIdentity, IdentityError> {
        // Validate display name
        if display_name.trim().is_empty() {
            return Err(IdentityError::Encryption("Display name cannot be empty".to_string()));
        }

        let (signing_key, verifying_key) = Self::generate_keypair();

        // Encode keys as hex
        let private_key_hex = hex::encode(signing_key.to_bytes());
        let public_key_hex = hex::encode(verifying_key.to_bytes());

        // Generate user ID from public key hash (first 16 bytes as hex = 32 chars)
        let mut hasher = Sha256::new();
        hasher.update(verifying_key.as_bytes());
        let hash = hasher.finalize();
        let user_id = hex::encode(&hash[..16]); // Use first 16 bytes for shorter ID

        let identity = UserIdentity {
            user_id: user_id.clone(),
            display_name: display_name.trim().to_string(),
            public_key: public_key_hex,
            private_key: Some(private_key_hex),
        };

        // Create account container and set session
        let account_manager = AccountManager::new()
            .map_err(|e| IdentityError::Account(e.to_string()))?;

        // Create account directory structure
        account_manager.create_account(&user_id, display_name.trim())
            .map_err(|e| IdentityError::Account(e.to_string()))?;

        // Set this as the current session
        account_manager.set_session(&user_id)
            .map_err(|e| IdentityError::Account(e.to_string()))?;

        // Save encrypted identity to the account directory
        let manager = Self::for_account(&user_id)
            .map_err(|e| IdentityError::Encryption(format!("Failed to initialize identity manager: {}", e)))?;
        manager.save_identity(&identity)
            .map_err(|e| IdentityError::Encryption(format!("Failed to save identity: {}", e)))?;

        Ok(identity)
    }

    pub fn load_identity(&self) -> Result<UserIdentity, IdentityError> {
        let keys_path = self.get_keys_path();
        let encrypted_data = fs::read_to_string(&keys_path)?;
        let encrypted: EncryptedIdentity = serde_json::from_str(&encrypted_data)
            .map_err(|_| IdentityError::InvalidIdentity)?;
        
        // Derive encryption key from device (passwordless)
        let device_key = Self::get_device_key()?;
        let salt = hex::decode(&encrypted.salt)
            .map_err(|e| IdentityError::Decryption(format!("Invalid salt: {}", e)))?;
        let key = Self::derive_key_from_device(&device_key, &salt)?;
        
        // Decrypt
        let cipher = Aes256Gcm::new(&key.into());
        let nonce_bytes = hex::decode(&encrypted.nonce)
            .map_err(|e| IdentityError::Decryption(format!("Invalid nonce: {}", e)))?;
        let nonce = Nonce::from_slice(&nonce_bytes);
        
        let ciphertext = hex::decode(&encrypted.ciphertext)
            .map_err(|e| IdentityError::Decryption(format!("Invalid ciphertext: {}", e)))?;
        
        let plaintext = cipher.decrypt(nonce, ciphertext.as_ref())
            .map_err(|_| IdentityError::InvalidIdentity)?;
        
        let stored: StoredIdentity = serde_json::from_slice(&plaintext)
            .map_err(|_| IdentityError::InvalidIdentity)?;
        let identity = UserIdentity {
            user_id: stored.user_id,
            display_name: stored.display_name,
            public_key: stored.public_key,
            private_key: stored.private_key,
        };
        Ok(identity)
    }

    pub fn save_identity(&self, identity: &UserIdentity) -> Result<(), IdentityError> {
        // Generate salt
        let salt: [u8; 16] = rand::random();
        let device_key = Self::get_device_key()?;
        let key = Self::derive_key_from_device(&device_key, &salt)?;
        
        // Serialize identity (use StoredIdentity so private_key is persisted in keys.dat)
        let stored = StoredIdentity {
            user_id: identity.user_id.clone(),
            display_name: identity.display_name.clone(),
            public_key: identity.public_key.clone(),
            private_key: identity.private_key.clone(),
        };
        let plaintext = serde_json::to_vec(&stored)?;
        
        // Encrypt
        let cipher = Aes256Gcm::new(&key.into());
        let nonce = Aes256Gcm::generate_nonce(&mut OsRng);
        let ciphertext = cipher.encrypt(&nonce, plaintext.as_ref())
            .map_err(|e| IdentityError::Encryption(e.to_string()))?;
        
        let encrypted = EncryptedIdentity {
            nonce: hex::encode(nonce),
            ciphertext: hex::encode(ciphertext),
            salt: hex::encode(salt),
        };
        
        // Save to file
        let keys_path = self.get_keys_path();
        let json = serde_json::to_string_pretty(&encrypted)?;
        fs::write(keys_path, json)?;
        
        Ok(())
    }

    fn get_device_key() -> Result<String, IdentityError> {
        // Derive a device-specific key from machine identifier
        // This makes the encryption device-bound (passwordless)
        // Use a combination of identifiers for better reliability
        
        #[cfg(target_os = "windows")]
        {
            #[cfg(feature = "windows-registry")]
            {
                use winreg::enums::*;
                use winreg::RegKey;
                
                // Try to read machine GUID directly from registry
                let hklm = RegKey::predef(HKEY_LOCAL_MACHINE);
                if let Ok(crypto_key) = hklm.open_subkey("SOFTWARE\\Microsoft\\Cryptography") {
                    if let Ok(guid) = crypto_key.get_value::<String, _>("MachineGuid") {
                        if !guid.is_empty() {
                            return Ok(guid);
                        }
                    }
                }
            }
            
            // Fallback: try PowerShell command (hidden window)
            #[cfg(not(feature = "windows-registry"))]
            {
                use std::process::Command;
                use std::os::windows::process::CommandExt;
                
                // CREATE_NO_WINDOW flag (0x08000000) hides the console window
                let output = Command::new("powershell")
                    .args(&["-NoProfile", "-WindowStyle", "Hidden", "-Command", "Get-ItemProperty -Path 'HKLM:\\SOFTWARE\\Microsoft\\Cryptography' -Name MachineGuid | Select-Object -ExpandProperty MachineGuid"])
                    .creation_flags(0x08000000)
                    .output();
                
                if let Ok(output) = output {
                    if output.status.success() {
                        let guid = String::from_utf8_lossy(&output.stdout);
                        let guid = guid.trim().trim_end_matches('\r').trim_end_matches('\n');
                        if !guid.is_empty() && guid.len() >= 32 {
                            return Ok(guid.to_string());
                        }
                    }
                }
            }
            
            // Final fallback: use computer name + username
            let computer = std::env::var("COMPUTERNAME").unwrap_or_else(|_| "unknown".to_string());
            let user = std::env::var("USERNAME").unwrap_or_else(|_| "unknown".to_string());
            Ok(format!("{}-{}", computer, user))
        }
        
        #[cfg(target_os = "macos")]
        {
            use std::process::Command;
            // Try to get hardware UUID
            let output = Command::new("system_profiler")
                .args(&["SPHardwareDataType"])
                .output();
            
            if let Ok(output) = output {
                let stdout = String::from_utf8_lossy(&output.stdout);
                for line in stdout.lines() {
                    if line.contains("Hardware UUID:") {
                        if let Some(uuid) = line.split(":").nth(1) {
                            return Ok(uuid.trim().to_string());
                        }
                    }
                }
            }
            
            // Fallback
            let hostname = std::env::var("HOSTNAME").unwrap_or_else(|_| "unknown".to_string());
            Ok(hostname)
        }
        
        #[cfg(target_os = "linux")]
        {
            // Use machine-id
            if let Ok(machine_id) = fs::read_to_string("/etc/machine-id") {
                return Ok(machine_id.trim().to_string());
            }
            
            // Fallback: hostname
            let hostname = std::env::var("HOSTNAME").unwrap_or_else(|_| "unknown".to_string());
            Ok(hostname)
        }
        
        #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
        {
            Err(IdentityError::Io(std::io::Error::new(
                std::io::ErrorKind::Unsupported,
                "Unsupported platform"
            )))
        }
    }

    fn derive_key_from_device(device_key: &str, salt: &[u8]) -> Result<[u8; 32], IdentityError> {
        // Derive encryption key from device identifier and salt
        let mut hasher = Sha256::new();
        hasher.update(device_key.as_bytes());
        hasher.update(salt);
        let hash = hasher.finalize();
        
        let mut key = [0u8; 32];
        key.copy_from_slice(&hash);
        Ok(key)
    }

    pub fn export_identity(&self) -> Result<Vec<u8>, IdentityError> {
        // Export decrypted identity for cross-device portability
        // User must explicitly export (this is unencrypted export)
        let identity = self.load_identity()?;
        
        // Create export format with version marker
        #[derive(Serialize)]
        struct ExportFormat {
            version: u8,
            identity: UserIdentity,
        }
        
        let export = ExportFormat {
            version: 1,
            identity,
        };
        
        let json = serde_json::to_string_pretty(&export)?;
        Ok(json.into_bytes())
    }

    pub fn import_identity(&self, data: &[u8]) -> Result<UserIdentity, IdentityError> {
        // Import identity from exported file (decrypted format)
        #[derive(Deserialize)]
        struct ExportFormat {
            version: u8,
            identity: UserIdentity,
        }
        
        let export: ExportFormat = serde_json::from_slice(data)
            .map_err(|_| IdentityError::InvalidIdentity)?;
        
        if export.version != 1 {
            return Err(IdentityError::InvalidIdentity);
        }
        
        let identity = export.identity;
        
        // Re-encrypt and save with this device's key
        self.save_identity(&identity)?;
        
        Ok(identity)
    }

    /// Export full identity with profile, server keys, friends list, known display names, and known server names in binary .key format
    pub fn export_full_identity(
        &self,
        profile_data: Option<serde_json::Value>,
        server_keys: Vec<serde_json::Value>,
        signaling_server_url: Option<String>,
        friends: Vec<String>,
        known_profiles: Option<serde_json::Value>,
        known_server_names: Option<serde_json::Value>,
    ) -> Result<Vec<u8>, IdentityError> {
        let identity = self.load_identity()?;

        // Build the full export payload
        #[derive(Serialize)]
        struct FullExportFormat {
            version: u8,
            identity: UserIdentity,
            profile: Option<serde_json::Value>,
            servers: Vec<serde_json::Value>,
            signaling_server_url: Option<String>,
            friends: Vec<String>,
            #[serde(skip_serializing_if = "Option::is_none")]
            known_profiles: Option<serde_json::Value>,
            #[serde(skip_serializing_if = "Option::is_none")]
            known_server_names: Option<serde_json::Value>,
        }

        let export = FullExportFormat {
            version: 1,
            identity,
            profile: profile_data,
            servers: server_keys,
            signaling_server_url,
            friends,
            known_profiles,
            known_server_names,
        };

        // Serialize to JSON
        let json_bytes = serde_json::to_vec(&export)?;

        // Encrypt with device key (same as stored identity encryption)
        let device_key = Self::get_device_key()?;
        let salt: [u8; 16] = rand::random();
        let key = Self::derive_key_from_device(&device_key, &salt)?;

        let cipher = XChaCha20Poly1305::new((&key).into());
        let nonce = XChaCha20Poly1305::generate_nonce(&mut OsRng);
        let ciphertext = cipher.encrypt(&nonce, json_bytes.as_ref())
            .map_err(|_| IdentityError::Encryption("Failed to encrypt export payload".to_string()))?;

        // Build binary format
        // Magic: "CORD" (4 bytes) - Cordia key file
        // Version: u16 (2 bytes)
        // Flags: u16 (2 bytes, reserved, set to 0)
        // Payload size: u32 (4 bytes)
        // Header checksum: u32 (4 bytes, CRC32 of first 12 bytes)
        let mut header = Vec::new();
        header.extend_from_slice(b"CORD");
        header.extend_from_slice(&1u16.to_le_bytes()); // version 1
        header.extend_from_slice(&0u16.to_le_bytes()); // flags (reserved)
        
        // Calculate payload size (salt + nonce + ciphertext)
        let payload = {
            let mut p = Vec::new();
            p.extend_from_slice(&salt); // 16 bytes
            p.extend_from_slice(nonce.as_slice()); // 24 bytes
            p.extend_from_slice(&ciphertext);
            p
        };
        
        header.extend_from_slice(&(payload.len() as u32).to_le_bytes());
        
        // Simple checksum: sum of first 12 bytes as u32
        let mut checksum: u32 = 0;
        for &b in &header[..12] {
            checksum = checksum.wrapping_add(b as u32);
        }
        header.extend_from_slice(&checksum.to_le_bytes());

        // Combine header + payload
        let mut result = header;
        result.extend(payload);
        
        Ok(result)
    }

    /// Decrypt and parse .key format (static, doesn't save - caller must save)
    pub fn import_key_format_static(data: &[u8]) -> Result<(UserIdentity, Option<serde_json::Value>, Vec<serde_json::Value>, Option<String>, Vec<String>, Option<serde_json::Value>, Option<serde_json::Value>), IdentityError> {
        if data.len() < 16 {
            return Err(IdentityError::InvalidIdentity);
        }
        // Cordia .key format magic
        if &data[0..4] != b"CORD" {
            return Err(IdentityError::InvalidIdentity);
        }

        // Parse header
        let version = u16::from_le_bytes([data[4], data[5]]);
        if version != 1 {
            return Err(IdentityError::InvalidIdentity);
        }

        let payload_size = u32::from_le_bytes([data[8], data[9], data[10], data[11]]) as usize;
        
        if data.len() < 16 + payload_size {
            return Err(IdentityError::InvalidIdentity);
        }

        let payload = &data[16..16 + payload_size];
        
        if payload.len() < 40 { // salt (16) + nonce (24) minimum
            return Err(IdentityError::InvalidIdentity);
        }

        // Extract salt and nonce
        let salt: [u8; 16] = payload[0..16].try_into()
            .map_err(|_| IdentityError::Decryption("Invalid salt in .key file".to_string()))?;
        let nonce_bytes: [u8; 24] = payload[16..40].try_into()
            .map_err(|_| IdentityError::Decryption("Invalid nonce in .key file".to_string()))?;
        let ciphertext = &payload[40..];

        // Decrypt with device key
        let device_key = Self::get_device_key()?;
        let key = Self::derive_key_from_device(&device_key, &salt)?;

        let cipher = XChaCha20Poly1305::new((&key).into());
        let nonce: [u8; 24] = nonce_bytes;
        let nonce = nonce.into();
        let plaintext = cipher.decrypt(&nonce, ciphertext)
            .map_err(|_| IdentityError::Decryption("Failed to decrypt .key file".to_string()))?;

        // Deserialize JSON payload
        #[derive(Deserialize)]
        struct FullExportFormat {
            version: u8,
            identity: UserIdentity,
            profile: Option<serde_json::Value>,
            #[serde(alias = "houses")]
            servers: Vec<serde_json::Value>,
            #[serde(default)]
            signaling_server_url: Option<String>,
            #[serde(default)]
            friends: Vec<String>,
            #[serde(default)]
            known_profiles: Option<serde_json::Value>,
            #[serde(default, alias = "known_house_names")]
            known_server_names: Option<serde_json::Value>,
        }

        let export: FullExportFormat = serde_json::from_slice(&plaintext)
            .map_err(|_| IdentityError::InvalidIdentity)?;

        if export.version != 1 {
            return Err(IdentityError::InvalidIdentity);
        }

        // Don't save here - caller (import_identity_auto) will save after account setup
        Ok((export.identity, export.profile, export.servers, export.signaling_server_url, export.friends, export.known_profiles, export.known_server_names))
    }

}

