use ed25519_dalek::{SigningKey, VerifyingKey};
use sha2::{Sha256, Digest};
use aes_gcm::{
    aead::{Aead, AeadCore, KeyInit, OsRng},
    Aes256Gcm, Nonce,
};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::fs;
use thiserror::Error;

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
}

#[derive(Serialize, Deserialize, Clone)]
pub struct UserIdentity {
    pub user_id: String,        // Public key hash
    pub display_name: String,
    pub public_key: String,     // Hex-encoded public key
    #[serde(skip_serializing)]
    pub private_key: Option<String>, // Hex-encoded private key (only in memory)
}

#[derive(Serialize, Deserialize)]
struct EncryptedIdentity {
    nonce: String,
    ciphertext: String,
    salt: String,
}

pub struct IdentityManager {
    data_dir: PathBuf,
}

impl IdentityManager {
    pub fn new() -> Result<Self, IdentityError> {
        let data_dir = Self::get_data_dir()?;
        fs::create_dir_all(&data_dir)?;
        Ok(Self { data_dir })
    }

    fn get_data_dir() -> Result<PathBuf, IdentityError> {
        #[cfg(target_os = "windows")]
        {
            let app_data = std::env::var("APPDATA")
                .map_err(|_| IdentityError::Io(std::io::Error::new(
                    std::io::ErrorKind::NotFound,
                    "APPDATA not found"
                )))?;
            Ok(PathBuf::from(app_data).join("Roommate"))
        }
        
        #[cfg(target_os = "macos")]
        {
            let home = std::env::var("HOME")
                .map_err(|_| IdentityError::Io(std::io::Error::new(
                    std::io::ErrorKind::NotFound,
                    "HOME not found"
                )))?;
            Ok(PathBuf::from(home).join("Library").join("Application Support").join("Roommate"))
        }
        
        #[cfg(target_os = "linux")]
        {
            let home = std::env::var("HOME")
                .map_err(|_| IdentityError::Io(std::io::Error::new(
                    std::io::ErrorKind::NotFound,
                    "HOME not found"
                )))?;
            Ok(PathBuf::from(home).join(".config").join("roommate"))
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
            user_id,
            display_name: display_name.trim().to_string(),
            public_key: public_key_hex,
            private_key: Some(private_key_hex),
        };
        
        // Save encrypted (passwordless - uses device key)
        let manager = Self::new()
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
        
        let identity: UserIdentity = serde_json::from_slice(&plaintext)?;
        Ok(identity)
    }

    pub fn save_identity(&self, identity: &UserIdentity) -> Result<(), IdentityError> {
        // Generate salt
        let salt: [u8; 16] = rand::random();
        let device_key = Self::get_device_key()?;
        let key = Self::derive_key_from_device(&device_key, &salt)?;
        
        // Serialize identity
        let plaintext = serde_json::to_vec(identity)?;
        
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
            
            // Fallback: try PowerShell command
            #[cfg(not(feature = "windows-registry"))]
            {
                use std::process::Command;
                
                let output = Command::new("powershell")
                    .args(&["-NoProfile", "-Command", "Get-ItemProperty -Path 'HKLM:\\SOFTWARE\\Microsoft\\Cryptography' -Name MachineGuid | Select-Object -ExpandProperty MachineGuid"])
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
}

