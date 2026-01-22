use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::fs;
use thiserror::Error;
use uuid::Uuid;
use chrono::{DateTime, Utc};
use ed25519_dalek::{SigningKey, VerifyingKey, Signature, Signer, Verifier};
use chacha20poly1305::{XChaCha20Poly1305, aead::{Aead, KeyInit, AeadCore}};
use x25519_dalek::{EphemeralSecret, PublicKey as X25519PublicKey, StaticSecret};
use rand::rngs::OsRng;
use zeroize::Zeroize;

use crate::account_manager::AccountManager;

#[derive(Error, Debug)]
pub enum HouseError {
    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),
    #[error("Serialization error: {0}")]
    Serialization(#[from] serde_json::Error),
    #[error("House not found: {0}")]
    NotFound(String),
    #[error("Invalid invite code")]
    InvalidInviteCode,
    #[error("Account error: {0}")]
    Account(String),
    #[error("Missing signing key")]
    MissingSigningKey,
    #[error("Missing symmetric key")]
    MissingSymmetricKey,
    #[error("Encryption failed")]
    EncryptionFailed,
    #[error("Decryption failed")]
    DecryptionFailed,
    #[error("Invalid invite blob")]
    InvalidInviteBlob,
    #[error("Invalid ciphertext")]
    InvalidCiphertext,
    #[error("Invalid signature")]
    InvalidSignature,
    #[error("Base64 decode error: {0}")]
    Base64Decode(String),
    #[error("Key conversion error")]
    KeyConversion,
    #[error("Invalid invite URI")]
    InvalidInviteUri,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub enum ConnectionMode {
    Signaling,  // Full featured with signaling server
    DHT,        // P2P only, no room persistence
    Manual,     // Direct/LAN connections
}

impl Default for ConnectionMode {
    fn default() -> Self {
        ConnectionMode::Signaling
    }
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Room {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct HouseMember {
    pub user_id: String,       // User's public key hash
    pub display_name: String,
    pub joined_at: DateTime<Utc>,
    #[serde(default)]
    pub x25519_pubkey: Option<String>,  // Base64-encoded X25519 public key for key exchange
}

/// Stored house state with encrypted secrets
/// The symmetric key and signing secret are stored encrypted separately
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct HouseStorage {
    pub id: String,
    pub name: String,
    pub created_at: DateTime<Utc>,
    pub rooms: Vec<Room>,
    pub members: Vec<HouseMember>,

    // Signing (Ed25519) - public only in storage
    pub signing_pubkey: String,  // Base64-encoded Ed25519 verifying key

    // Encrypted secrets (encrypted with device key, stored locally)
    #[serde(default)]
    pub encrypted_signing_secret: Option<String>,  // Base64-encoded encrypted Ed25519 signing key
    #[serde(default)]
    pub encrypted_symmetric_key: Option<String>,   // Base64-encoded encrypted XChaCha20 key

    pub invite_uri: String,
    #[serde(default)]
    pub connection_mode: ConnectionMode,
    #[serde(default)]
    pub signaling_url: Option<String>,

    // Deprecated field - keep for backward compatibility
    #[serde(default = "HouseStorage::generate_legacy_invite_code")]
    pub invite_code: String,

    // Temporary invite (Option B): stored/displayed to members, expires client-side (server enforces too)
    #[serde(default)]
    pub active_invite_uri: Option<String>,
    #[serde(default)]
    pub active_invite_expires_at: Option<DateTime<Utc>>,

    // Legacy field for backwards compatibility
    #[serde(default)]
    pub public_key: String,
}

impl HouseStorage {
    fn generate_legacy_invite_code() -> String {
        use rand::Rng;
        const CHARSET: &[u8] = b"ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
        let mut rng = rand::thread_rng();
        (0..8)
            .map(|_| {
                let idx = rng.gen_range(0..CHARSET.len());
                CHARSET[idx] as char
            })
            .collect()
    }
}

/// Public house info for frontend serialization
/// Does not contain any secrets
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct HouseInfo {
    pub id: String,
    pub name: String,
    pub created_at: DateTime<Utc>,
    pub rooms: Vec<Room>,
    pub members: Vec<HouseMember>,
    pub signing_pubkey: String,
    pub invite_uri: String,
    pub connection_mode: ConnectionMode,
    pub signaling_url: Option<String>,
    pub invite_code: String,
    #[serde(default)]
    pub active_invite_uri: Option<String>,
    #[serde(default)]
    pub active_invite_expires_at: Option<DateTime<Utc>>,
    pub public_key: String,
    pub has_symmetric_key: bool,
    pub has_signing_key: bool,
}

/// Runtime house struct with decrypted secrets in memory
/// Secrets are zeroized on drop
#[derive(Clone)]
pub struct House {
    pub id: String,
    pub name: String,
    pub created_at: DateTime<Utc>,
    pub rooms: Vec<Room>,
    pub members: Vec<HouseMember>,

    // === SIGNING (Ed25519) - for authentication ===
    pub signing_pubkey: String,  // Base64-encoded Ed25519 verifying key
    signing_secret: Option<Vec<u8>>,  // Ed25519 signing key (local only, zeroized on drop)

    // === ENCRYPTION (XChaCha20-Poly1305) - THE shared secret ===
    house_symmetric_key: Option<Vec<u8>>,  // 256-bit symmetric key (local only, zeroized on drop)

    pub invite_uri: String,
    pub connection_mode: ConnectionMode,
    pub signaling_url: Option<String>,

    // Legacy fields for backwards compatibility
    pub invite_code: String,
    pub active_invite_uri: Option<String>,
    pub active_invite_expires_at: Option<DateTime<Utc>>,
    pub public_key: String,
}

impl Drop for House {
    fn drop(&mut self) {
        // Securely clear secrets from memory
        if let Some(ref mut key) = self.signing_secret {
            key.zeroize();
        }
        if let Some(ref mut key) = self.house_symmetric_key {
            key.zeroize();
        }
    }
}

impl House {
    /// Create a new house with fresh cryptographic keys
    pub fn new(
        name: String,
        creator_user_id: String,
        creator_display_name: String,
        signaling_url: Option<String>,
    ) -> Result<Self, HouseError> {
        let id = Uuid::new_v4().to_string();
        let now = Utc::now();

        // Generate Ed25519 signing keypair
        let signing_key = SigningKey::generate(&mut OsRng);
        let verifying_key = signing_key.verifying_key();

        let signing_pubkey = base64::encode(verifying_key.as_bytes());
        let signing_secret = signing_key.to_bytes().to_vec();

        // Generate XChaCha20 symmetric key (THE thing members share)
        let mut symmetric_key = vec![0u8; 32];
        use rand::RngCore;
        OsRng.fill_bytes(&mut symmetric_key);

        // Generate invite URI
        let server = signaling_url.as_deref().unwrap_or("signal.roommate.app");
        let invite_uri = format!("rmmt://{}@{}", signing_pubkey, server);

        // Create default "General" room
        let general_room = Room {
            id: Uuid::new_v4().to_string(),
            name: "General".to_string(),
            description: Some("Default room".to_string()),
        };

        let creator = HouseMember {
            user_id: creator_user_id,
            display_name: creator_display_name,
            joined_at: now,
            x25519_pubkey: None,
        };

        // Legacy invite code for backwards compatibility
        let invite_code = HouseStorage::generate_legacy_invite_code();

        Ok(House {
            id,
            name,
            created_at: now,
            rooms: vec![general_room],
            members: vec![creator],
            signing_pubkey: signing_pubkey.clone(),
            signing_secret: Some(signing_secret),
            house_symmetric_key: Some(symmetric_key),
            invite_uri,
            connection_mode: ConnectionMode::Signaling,
            signaling_url,
            invite_code,
            active_invite_uri: None,
            active_invite_expires_at: None,
            public_key: signing_pubkey,  // Legacy field
        })
    }

    /// Check if this house has the symmetric key (can encrypt/decrypt)
    pub fn has_symmetric_key(&self) -> bool {
        self.house_symmetric_key.is_some()
    }

    /// Check if this house has the signing key (can sign events)
    pub fn has_signing_key(&self) -> bool {
        self.signing_secret.is_some()
    }

    /// Generate a sealed invite blob for a new member
    /// Uses X25519 key exchange to encrypt the symmetric key
    pub fn generate_invite(&self, recipient_x25519_pubkey: &[u8; 32]) -> Result<String, HouseError> {
        let symmetric_key = self.house_symmetric_key.as_ref()
            .ok_or(HouseError::MissingSymmetricKey)?;

        // Generate ephemeral X25519 keypair for this invite
        let ephemeral_secret = EphemeralSecret::random_from_rng(OsRng);
        let ephemeral_public = X25519PublicKey::from(&ephemeral_secret);

        // Perform X25519 key exchange
        let recipient_pubkey = X25519PublicKey::from(*recipient_x25519_pubkey);
        let shared_secret = ephemeral_secret.diffie_hellman(&recipient_pubkey);

        // Derive encryption key from shared secret using SHA256
        use sha2::{Sha256, Digest};
        let mut hasher = Sha256::new();
        hasher.update(shared_secret.as_bytes());
        let derived_key: [u8; 32] = hasher.finalize().into();

        // Encrypt symmetric key
        let cipher = XChaCha20Poly1305::new((&derived_key).into());
        let nonce = XChaCha20Poly1305::generate_nonce(&mut OsRng);
        let ciphertext = cipher.encrypt(&nonce, symmetric_key.as_ref())
            .map_err(|_| HouseError::EncryptionFailed)?;

        // Pack: ephemeral_pubkey (32) || nonce (24) || ciphertext
        let mut sealed = Vec::new();
        sealed.extend_from_slice(ephemeral_public.as_bytes());
        sealed.extend_from_slice(&nonce);
        sealed.extend_from_slice(&ciphertext);

        Ok(base64::encode(&sealed))
    }

    /// Decrypt a sealed invite blob to obtain the symmetric key
    pub fn decrypt_invite(
        sealed_blob: &str,
        recipient_x25519_secret: &[u8; 32],
    ) -> Result<Vec<u8>, HouseError> {
        let sealed = base64::decode(sealed_blob)
            .map_err(|e| HouseError::Base64Decode(e.to_string()))?;

        // Unpack: ephemeral_pubkey (32) || nonce (24) || ciphertext (32 + 16 tag)
        if sealed.len() < 32 + 24 + 32 + 16 {
            return Err(HouseError::InvalidInviteBlob);
        }

        let ephemeral_pubkey_bytes: [u8; 32] = sealed[0..32].try_into()
            .map_err(|_| HouseError::KeyConversion)?;
        let ephemeral_pubkey = X25519PublicKey::from(ephemeral_pubkey_bytes);
        let nonce: [u8; 24] = sealed[32..56].try_into()
            .map_err(|_| HouseError::KeyConversion)?;
        let ciphertext = &sealed[56..];

        // Perform X25519 key exchange
        let recipient_secret = StaticSecret::from(*recipient_x25519_secret);
        let shared_secret = recipient_secret.diffie_hellman(&ephemeral_pubkey);

        // Derive decryption key from shared secret using SHA256
        use sha2::{Sha256, Digest};
        let mut hasher = Sha256::new();
        hasher.update(shared_secret.as_bytes());
        let derived_key: [u8; 32] = hasher.finalize().into();

        // Decrypt symmetric key
        let cipher = XChaCha20Poly1305::new((&derived_key).into());
        let plaintext = cipher.decrypt((&nonce).into(), ciphertext)
            .map_err(|_| HouseError::DecryptionFailed)?;

        Ok(plaintext)
    }

    /// Sign data with house signing key (Ed25519)
    pub fn sign(&self, data: &[u8]) -> Result<String, HouseError> {
        let secret = self.signing_secret.as_ref()
            .ok_or(HouseError::MissingSigningKey)?;

        let secret_bytes: [u8; 32] = secret.as_slice().try_into()
            .map_err(|_| HouseError::KeyConversion)?;
        let signing_key = SigningKey::from_bytes(&secret_bytes);
        let signature = signing_key.sign(data);

        Ok(base64::encode(signature.to_bytes()))
    }

    /// Verify signature with house signing pubkey (Ed25519)
    pub fn verify(&self, data: &[u8], signature_b64: &str) -> Result<bool, HouseError> {
        let pubkey_bytes = base64::decode(&self.signing_pubkey)
            .map_err(|e| HouseError::Base64Decode(e.to_string()))?;

        let pubkey_array: [u8; 32] = pubkey_bytes.as_slice().try_into()
            .map_err(|_| HouseError::KeyConversion)?;
        let verifying_key = VerifyingKey::from_bytes(&pubkey_array)
            .map_err(|_| HouseError::InvalidSignature)?;

        let signature_bytes = base64::decode(signature_b64)
            .map_err(|e| HouseError::Base64Decode(e.to_string()))?;
        let sig_array: [u8; 64] = signature_bytes.as_slice().try_into()
            .map_err(|_| HouseError::KeyConversion)?;
        let signature = Signature::from_bytes(&sig_array);

        Ok(verifying_key.verify(data, &signature).is_ok())
    }

    /// Encrypt data with house symmetric key (XChaCha20-Poly1305)
    pub fn encrypt(&self, plaintext: &[u8]) -> Result<Vec<u8>, HouseError> {
        let key = self.house_symmetric_key.as_ref()
            .ok_or(HouseError::MissingSymmetricKey)?;

        let key_array: [u8; 32] = key.as_slice().try_into()
            .map_err(|_| HouseError::KeyConversion)?;
        let cipher = XChaCha20Poly1305::new((&key_array).into());
        let nonce = XChaCha20Poly1305::generate_nonce(&mut OsRng);
        let ciphertext = cipher.encrypt(&nonce, plaintext)
            .map_err(|_| HouseError::EncryptionFailed)?;

        // Prepend nonce to ciphertext
        let mut result = nonce.to_vec();
        result.extend(ciphertext);
        Ok(result)
    }

    /// Decrypt data with house symmetric key (XChaCha20-Poly1305)
    pub fn decrypt(&self, ciphertext: &[u8]) -> Result<Vec<u8>, HouseError> {
        let key = self.house_symmetric_key.as_ref()
            .ok_or(HouseError::MissingSymmetricKey)?;

        if ciphertext.len() < 24 {
            return Err(HouseError::InvalidCiphertext);
        }

        let nonce: [u8; 24] = ciphertext[..24].try_into()
            .map_err(|_| HouseError::KeyConversion)?;
        let encrypted = &ciphertext[24..];

        let key_array: [u8; 32] = key.as_slice().try_into()
            .map_err(|_| HouseError::KeyConversion)?;
        let cipher = XChaCha20Poly1305::new((&key_array).into());
        cipher.decrypt((&nonce).into(), encrypted)
            .map_err(|_| HouseError::DecryptionFailed)
    }

    pub fn add_member(&mut self, user_id: String, display_name: String) {
        let member = HouseMember {
            user_id,
            display_name,
            joined_at: Utc::now(),
            x25519_pubkey: None,
        };
        self.members.push(member);
    }

    pub fn add_room(&mut self, name: String, description: Option<String>) -> Room {
        let room = Room {
            id: Uuid::new_v4().to_string(),
            name,
            description,
        };
        self.rooms.push(room.clone());
        room
    }

    pub fn remove_room(&mut self, room_id: &str) -> bool {
        if let Some(pos) = self.rooms.iter().position(|r| r.id == room_id) {
            self.rooms.remove(pos);
            true
        } else {
            false
        }
    }

    /// Convert to storage format for serialization
    /// Encrypts secrets with device key before storage
    pub fn to_storage(&self, device_key: &[u8; 32]) -> Result<HouseStorage, HouseError> {
        // Encrypt signing secret if present
        let encrypted_signing_secret = if let Some(ref secret) = self.signing_secret {
            let cipher = XChaCha20Poly1305::new(device_key.into());
            let nonce = XChaCha20Poly1305::generate_nonce(&mut OsRng);
            let ciphertext = cipher.encrypt(&nonce, secret.as_ref())
                .map_err(|_| HouseError::EncryptionFailed)?;
            let mut result = nonce.to_vec();
            result.extend(ciphertext);
            Some(base64::encode(&result))
        } else {
            None
        };

        // Encrypt symmetric key if present
        let encrypted_symmetric_key = if let Some(ref key) = self.house_symmetric_key {
            let cipher = XChaCha20Poly1305::new(device_key.into());
            let nonce = XChaCha20Poly1305::generate_nonce(&mut OsRng);
            let ciphertext = cipher.encrypt(&nonce, key.as_ref())
                .map_err(|_| HouseError::EncryptionFailed)?;
            let mut result = nonce.to_vec();
            result.extend(ciphertext);
            Some(base64::encode(&result))
        } else {
            None
        };

        Ok(HouseStorage {
            id: self.id.clone(),
            name: self.name.clone(),
            created_at: self.created_at,
            rooms: self.rooms.clone(),
            members: self.members.clone(),
            signing_pubkey: self.signing_pubkey.clone(),
            encrypted_signing_secret,
            encrypted_symmetric_key,
            invite_uri: self.invite_uri.clone(),
            connection_mode: self.connection_mode.clone(),
            signaling_url: self.signaling_url.clone(),
            invite_code: self.invite_code.clone(),
            active_invite_uri: self.active_invite_uri.clone(),
            active_invite_expires_at: self.active_invite_expires_at,
            public_key: self.public_key.clone(),
        })
    }

    /// Create from storage format, decrypting secrets with device key
    pub fn from_storage(storage: HouseStorage, device_key: &[u8; 32]) -> Result<Self, HouseError> {
        // Decrypt signing secret if present
        let signing_secret = if let Some(ref encrypted) = storage.encrypted_signing_secret {
            let data = base64::decode(encrypted)
                .map_err(|e| HouseError::Base64Decode(e.to_string()))?;
            if data.len() < 24 {
                return Err(HouseError::InvalidCiphertext);
            }
            let nonce: [u8; 24] = data[..24].try_into()
                .map_err(|_| HouseError::KeyConversion)?;
            let ciphertext = &data[24..];
            let cipher = XChaCha20Poly1305::new(device_key.into());
            let plaintext = cipher.decrypt((&nonce).into(), ciphertext)
                .map_err(|_| HouseError::DecryptionFailed)?;
            Some(plaintext)
        } else {
            None
        };

        // Decrypt symmetric key if present
        let house_symmetric_key = if let Some(ref encrypted) = storage.encrypted_symmetric_key {
            let data = base64::decode(encrypted)
                .map_err(|e| HouseError::Base64Decode(e.to_string()))?;
            if data.len() < 24 {
                return Err(HouseError::InvalidCiphertext);
            }
            let nonce: [u8; 24] = data[..24].try_into()
                .map_err(|_| HouseError::KeyConversion)?;
            let ciphertext = &data[24..];
            let cipher = XChaCha20Poly1305::new(device_key.into());
            let plaintext = cipher.decrypt((&nonce).into(), ciphertext)
                .map_err(|_| HouseError::DecryptionFailed)?;
            Some(plaintext)
        } else {
            None
        };

        Ok(House {
            id: storage.id,
            name: storage.name,
            created_at: storage.created_at,
            rooms: storage.rooms,
            members: storage.members,
            signing_pubkey: storage.signing_pubkey.clone(),
            signing_secret,
            house_symmetric_key,
            invite_uri: storage.invite_uri,
            connection_mode: storage.connection_mode,
            signaling_url: storage.signaling_url,
            invite_code: storage.invite_code,
            active_invite_uri: storage.active_invite_uri,
            active_invite_expires_at: storage.active_invite_expires_at,
            public_key: storage.public_key.clone(),
        })
    }

    /// Create from storage format without decrypting secrets (read-only view)
    pub fn from_storage_readonly(storage: HouseStorage) -> Self {
        House {
            id: storage.id,
            name: storage.name,
            created_at: storage.created_at,
            rooms: storage.rooms,
            members: storage.members,
            signing_pubkey: storage.signing_pubkey.clone(),
            signing_secret: None,
            house_symmetric_key: None,
            invite_uri: storage.invite_uri,
            connection_mode: storage.connection_mode,
            signaling_url: storage.signaling_url,
            invite_code: storage.invite_code,
            active_invite_uri: storage.active_invite_uri,
            active_invite_expires_at: storage.active_invite_expires_at,
            public_key: storage.public_key.clone(),
        }
    }

    /// Set the symmetric key (used when joining via invite)
    pub fn set_symmetric_key(&mut self, key: Vec<u8>) {
        self.house_symmetric_key = Some(key);
    }

    pub fn get_symmetric_key(&self) -> Option<Vec<u8>> {
        self.house_symmetric_key.clone()
    }

    pub fn get_signing_secret(&self) -> Option<Vec<u8>> {
        self.signing_secret.clone()
    }

    /// Convert to HouseInfo for frontend serialization
    pub fn to_info(&self) -> HouseInfo {
        fn derive_simple_invite_code(signing_pubkey: &str) -> String {
            signing_pubkey
                .chars()
                .filter(|c| c.is_ascii_alphanumeric())
                .map(|c| c.to_ascii_uppercase())
                .take(18)
                .collect()
        }

        HouseInfo {
            id: self.id.clone(),
            name: self.name.clone(),
            created_at: self.created_at,
            rooms: self.rooms.clone(),
            members: self.members.clone(),
            signing_pubkey: self.signing_pubkey.clone(),
            invite_uri: self.invite_uri.clone(),
            connection_mode: self.connection_mode.clone(),
            signaling_url: self.signaling_url.clone(),
            // Use a deterministic, short invite code derived from signing_pubkey.
            // This is what the signaling server resolves for network-backed joins.
            invite_code: derive_simple_invite_code(&self.signing_pubkey),
            active_invite_uri: self.active_invite_uri.clone(),
            active_invite_expires_at: self.active_invite_expires_at,
            public_key: self.public_key.clone(),
            has_symmetric_key: self.house_symmetric_key.is_some(),
            has_signing_key: self.signing_secret.is_some(),
        }
    }
}

pub struct HouseManager {
    data_dir: PathBuf,
    account_id: Option<String>,
    device_key: [u8; 32],
}

impl HouseManager {
    /// Create a HouseManager for the current session's account
    /// Falls back to legacy mode if no session exists (for backwards compatibility)
    pub fn new() -> Result<Self, HouseError> {
        let account_manager = AccountManager::new()
            .map_err(|e| HouseError::Account(e.to_string()))?;

        // Get device key for encrypting secrets
        let device_key = Self::get_device_key()?;

        // Check if there's an active session
        let session = account_manager.get_session()
            .map_err(|e| HouseError::Account(e.to_string()))?;

        if let Some(account_id) = session.current_account_id {
            // Account mode: use account container
            let data_dir = account_manager.get_account_dir(&account_id);
            let houses_dir = data_dir.join("houses");
            fs::create_dir_all(&houses_dir)?;
            Ok(Self {
                data_dir,
                account_id: Some(account_id),
                device_key,
            })
        } else {
            // Legacy mode: use base data directory
            let data_dir = Self::get_legacy_data_dir()?;
            let houses_dir = data_dir.join("houses");
            fs::create_dir_all(&houses_dir)?;
            Ok(Self {
                data_dir,
                account_id: None,
                device_key,
            })
        }
    }

    /// Create a HouseManager for a specific account
    pub fn for_account(account_id: &str) -> Result<Self, HouseError> {
        let account_manager = AccountManager::new()
            .map_err(|e| HouseError::Account(e.to_string()))?;

        let device_key = Self::get_device_key()?;

        let data_dir = account_manager.get_account_dir(account_id);
        let houses_dir = data_dir.join("houses");
        fs::create_dir_all(&houses_dir)?;

        Ok(Self {
            data_dir,
            account_id: Some(account_id.to_string()),
            device_key,
        })
    }

    fn get_device_key() -> Result<[u8; 32], HouseError> {
        // Derive a device-specific key from machine identifier
        // This mirrors the approach used in identity.rs
        use sha2::{Sha256, Digest};

        let device_id = Self::get_device_id()?;
        let mut hasher = Sha256::new();
        hasher.update(device_id.as_bytes());
        hasher.update(b"roommate-house-encryption-v1");
        let hash = hasher.finalize();

        Ok(hash.into())
    }

    fn get_device_id() -> Result<String, HouseError> {
        #[cfg(target_os = "windows")]
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

            // Fallback: use computer name + username
            let computer = std::env::var("COMPUTERNAME").unwrap_or_else(|_| "unknown".to_string());
            let user = std::env::var("USERNAME").unwrap_or_else(|_| "unknown".to_string());
            Ok(format!("{}-{}", computer, user))
        }

        #[cfg(target_os = "macos")]
        {
            use std::process::Command;
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

            let hostname = std::env::var("HOSTNAME").unwrap_or_else(|_| "unknown".to_string());
            Ok(hostname)
        }

        #[cfg(target_os = "linux")]
        {
            if let Ok(machine_id) = fs::read_to_string("/etc/machine-id") {
                return Ok(machine_id.trim().to_string());
            }

            let hostname = std::env::var("HOSTNAME").unwrap_or_else(|_| "unknown".to_string());
            Ok(hostname)
        }

        #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
        {
            Err(HouseError::Io(std::io::Error::new(
                std::io::ErrorKind::Unsupported,
                "Unsupported platform"
            )))
        }
    }

    fn get_legacy_data_dir() -> Result<PathBuf, HouseError> {
        // Check for custom data directory (for testing with multiple instances)
        if let Ok(custom_dir) = std::env::var("ROOMMATE_DATA_DIR") {
            let path = PathBuf::from(custom_dir);
            if !path.exists() {
                fs::create_dir_all(&path)
                    .map_err(|e| HouseError::Io(e))?;
            }
            return Ok(path);
        }

        #[cfg(target_os = "windows")]
        {
            let app_data = std::env::var("APPDATA")
                .map_err(|_| HouseError::Io(std::io::Error::new(
                    std::io::ErrorKind::NotFound,
                    "APPDATA not found"
                )))?;
            Ok(PathBuf::from(app_data).join("Roommate"))
        }

        #[cfg(target_os = "macos")]
        {
            let home = std::env::var("HOME")
                .map_err(|_| HouseError::Io(std::io::Error::new(
                    std::io::ErrorKind::NotFound,
                    "HOME not found"
                )))?;
            Ok(PathBuf::from(home).join("Library").join("Application Support").join("Roommate"))
        }

        #[cfg(target_os = "linux")]
        {
            let home = std::env::var("HOME")
                .map_err(|_| HouseError::Io(std::io::Error::new(
                    std::io::ErrorKind::NotFound,
                    "HOME not found"
                )))?;
            Ok(PathBuf::from(home).join(".config").join("roommate"))
        }

        #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
        {
            Err(HouseError::Io(std::io::Error::new(
                std::io::ErrorKind::Unsupported,
                "Unsupported platform"
            )))
        }
    }

    fn get_house_path(&self, house_id: &str) -> PathBuf {
        self.data_dir.join("houses").join(format!("{}.json", house_id))
    }

    /// Get the account ID if in account mode
    pub fn get_account_id(&self) -> Option<&str> {
        self.account_id.as_deref()
    }

    pub fn create_house(&self, name: String, user_id: String, display_name: String) -> Result<House, HouseError> {
        let house = House::new(name, user_id, display_name, None)?;

        // Save house file (no list.json needed - we scan the directory)
        self.save_house(&house)?;

        Ok(house)
    }

    pub fn save_house(&self, house: &House) -> Result<(), HouseError> {
        let house_path = self.get_house_path(&house.id);
        let storage = house.to_storage(&self.device_key)?;
        let json = serde_json::to_string_pretty(&storage)?;
        fs::write(house_path, json)?;
        Ok(())
    }

    /// Restore a house from exported data (plaintext keys will be encrypted with device key)
    pub fn restore_house_from_export(
        &self,
        house_data: &serde_json::Value,
        plaintext_symmetric_key: Vec<u8>,
        plaintext_signing_secret: Option<Vec<u8>>,
    ) -> Result<(), HouseError> {
        // Ensure houses directory exists
        let houses_dir = self.data_dir.join("houses");
        fs::create_dir_all(&houses_dir)?;
        use chacha20poly1305::{XChaCha20Poly1305, aead::{Aead, KeyInit}};
        use rand::rngs::OsRng;
        
        // Encrypt symmetric key with device key
        let encrypted_symmetric_key = {
            let cipher = XChaCha20Poly1305::new((&self.device_key).into());
            let nonce = XChaCha20Poly1305::generate_nonce(&mut OsRng);
            let ciphertext = cipher.encrypt(&nonce, plaintext_symmetric_key.as_ref())
                .map_err(|_| HouseError::EncryptionFailed)?;
            let mut result = nonce.to_vec();
            result.extend(ciphertext);
            Some(base64::encode(&result))
        };
        
        // Encrypt signing secret if present
        let encrypted_signing_secret = if let Some(ref secret) = plaintext_signing_secret {
            let cipher = XChaCha20Poly1305::new((&self.device_key).into());
            let nonce = XChaCha20Poly1305::generate_nonce(&mut OsRng);
            let ciphertext = cipher.encrypt(&nonce, secret.as_ref())
                .map_err(|_| HouseError::EncryptionFailed)?;
            let mut result = nonce.to_vec();
            result.extend(ciphertext);
            Some(base64::encode(&result))
        } else {
            None
        };
        
        // Parse house data from export (minimal - rooms/members come from signaling server)
        let house_id: String = house_data.get("id")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
            .expect("Missing house id in export");
        
        // Use empty name - signaling server will provide the real name when syncing
        // Don't use "Imported House" or any default - let server sync populate it
        let name: String = house_data.get("name")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
            .unwrap_or_else(|| String::new());
        
        let created_at: DateTime<Utc> = house_data.get("created_at")
            .and_then(|v| v.as_str())
            .and_then(|s| DateTime::parse_from_rfc3339(s).ok())
            .map(|dt| dt.with_timezone(&Utc))
            .unwrap_or_else(Utc::now);
        
        // Rooms and members start empty - signaling server will populate them
        let rooms: Vec<Room> = house_data.get("rooms")
            .and_then(|v| serde_json::from_value(v.clone()).ok())
            .unwrap_or_default();
        
        let members: Vec<HouseMember> = house_data.get("members")
            .and_then(|v| serde_json::from_value(v.clone()).ok())
            .unwrap_or_default();
        
        let signing_pubkey: String = house_data.get("signing_pubkey")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
            .expect("Missing signing_pubkey in export");
        
        let invite_uri: String = house_data.get("invite_uri")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
            .unwrap_or_default();
        
        let connection_mode: ConnectionMode = house_data.get("connection_mode")
            .and_then(|v| serde_json::from_value(v.clone()).ok())
            .unwrap_or(ConnectionMode::Signaling);
        
        let signaling_url: Option<String> = house_data.get("signaling_url")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());
        
        let invite_code: String = house_data.get("invite_code")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
            .unwrap_or_default();
        
        let active_invite_uri: Option<String> = house_data.get("active_invite_uri")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());
        
        let active_invite_expires_at: Option<DateTime<Utc>> = house_data.get("active_invite_expires_at")
            .and_then(|v| v.as_str())
            .and_then(|s| DateTime::parse_from_rfc3339(s).ok())
            .map(|dt| dt.with_timezone(&Utc));
        
        let public_key: String = house_data.get("public_key")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
            .unwrap_or_default();
        
        // Create HouseStorage with encrypted keys
        let storage = HouseStorage {
            id: house_id.clone(),
            name,
            created_at,
            rooms,
            members,
            signing_pubkey,
            encrypted_signing_secret,
            encrypted_symmetric_key,
            invite_uri,
            connection_mode,
            signaling_url,
            invite_code,
            active_invite_uri,
            active_invite_expires_at,
            public_key,
        };
        
        // Write to disk
        let house_path = self.get_house_path(&house_id);
        let json = serde_json::to_string_pretty(&storage)?;
        fs::write(house_path, json)?;
        
        Ok(())
    }

    pub fn load_house(&self, house_id: &str) -> Result<House, HouseError> {
        let house_path = self.get_house_path(house_id);

        if !house_path.exists() {
            return Err(HouseError::NotFound(house_id.to_string()));
        }

        let content = fs::read_to_string(&house_path)?;
        let storage: HouseStorage = serde_json::from_str(&content)?;
        House::from_storage(storage, &self.device_key)
    }

    /// Load house without decrypting secrets (for listing)
    pub fn load_house_readonly(&self, house_id: &str) -> Result<House, HouseError> {
        let house_path = self.get_house_path(house_id);

        if !house_path.exists() {
            return Err(HouseError::NotFound(house_id.to_string()));
        }

        let content = fs::read_to_string(&house_path)?;
        let storage: HouseStorage = serde_json::from_str(&content)?;
        Ok(House::from_storage_readonly(storage))
    }

    /// List all house IDs by scanning the houses directory
    /// No list.json needed - each house is a separate .json file
    pub fn list_houses(&self) -> Result<Vec<String>, HouseError> {
        let houses_dir = self.data_dir.join("houses");

        if !houses_dir.exists() {
            return Ok(Vec::new());
        }

        let mut house_ids = Vec::new();
        for entry in fs::read_dir(houses_dir)? {
            let entry = entry?;
            let path = entry.path();

            // Only include .json files (skip list.json for backwards compat)
            if path.extension().and_then(|s| s.to_str()) == Some("json") {
                if let Some(stem) = path.file_stem().and_then(|s| s.to_str()) {
                    // Skip the legacy list.json file
                    if stem != "list" {
                        house_ids.push(stem.to_string());
                    }
                }
            }
        }

        Ok(house_ids)
    }

    pub fn load_all_houses(&self) -> Result<Vec<House>, HouseError> {
        let house_ids = self.list_houses()?;
        let mut houses = Vec::new();

        for house_id in house_ids {
            // Load with decryption to get full access to keys
            if let Ok(house) = self.load_house(&house_id) {
                houses.push(house);
            }
        }

        Ok(houses)
    }

    pub fn delete_house(&self, house_id: &str) -> Result<(), HouseError> {
        // Simply delete the house file (no list.json to update)
        let house_path = self.get_house_path(house_id);
        if house_path.exists() {
            fs::remove_file(house_path)?;
        }

        Ok(())
    }

    pub fn find_house_by_invite(&self, invite_code: &str) -> Result<Option<House>, HouseError> {
        let house_ids = self.list_houses()?;

        for house_id in house_ids {
            if let Ok(house) = self.load_house_readonly(&house_id) {
                if house.invite_code == invite_code {
                    // Load with decryption for full access
                    return Ok(Some(self.load_house(&house_id)?));
                }
            }
        }

        Ok(None)
    }

    pub fn add_member_to_house(&self, house_id: &str, user_id: String, display_name: String) -> Result<House, HouseError> {
        let mut house = self.load_house(house_id)?;

        // Check if user is already a member
        if house.members.iter().any(|m| m.user_id == user_id) {
            return Ok(house); // Already a member, just return the house
        }

        house.add_member(user_id, display_name);
        self.save_house(&house)?;

        Ok(house)
    }

    pub fn add_room_to_house(&self, house_id: &str, name: String, description: Option<String>) -> Result<House, HouseError> {
        let mut house = self.load_house(house_id)?;
        house.add_room(name, description);
        self.save_house(&house)?;
        Ok(house)
    }

    pub fn set_active_invite(
        &self,
        house_id: &str,
        active_invite_uri: Option<String>,
        active_invite_expires_at: Option<DateTime<Utc>>,
    ) -> Result<(), HouseError> {
        let mut house = self.load_house(house_id)?;
        house.active_invite_uri = active_invite_uri;
        house.active_invite_expires_at = active_invite_expires_at;
        self.save_house(&house)?;
        Ok(())
    }

    pub fn find_house_id_by_signing_pubkey(&self, signing_pubkey: &str) -> Result<Option<String>, HouseError> {
        let house_ids = self.list_houses()?;
        for house_id in house_ids {
            if let Ok(house) = self.load_house_readonly(&house_id) {
                if house.signing_pubkey == signing_pubkey {
                    return Ok(Some(house_id));
                }
            }
        }
        Ok(None)
    }

    pub fn remove_room_from_house(&self, house_id: &str, room_id: &str) -> Result<House, HouseError> {
        let mut house = self.load_house(house_id)?;

        if !house.remove_room(room_id) {
            return Err(HouseError::NotFound(format!("Room {} not found", room_id)));
        }

        self.save_house(&house)?;
        Ok(house)
    }

    /// Import a house "hint" (metadata-only) into this account's local storage.
    /// This persists the house so it can show up in lists and be joined/used.
    ///
    /// NOTE: This intentionally does NOT import any secrets. The encrypted secret fields
    /// are left as None. Key exchange / secret distribution is handled elsewhere.
    pub fn import_house_hint(&self, info: HouseInfo) -> Result<(), HouseError> {
        // Find existing house by signing_pubkey (not by id, since id can differ)
        // This handles the case where we imported a house with a new UUID, but server provides different UUID
        let (existing_house_id, preserve_encrypted_signing_secret, preserve_encrypted_symmetric_key) = 
            match self.find_house_id_by_signing_pubkey(&info.signing_pubkey)? {
                Some(existing_id) => {
                    // House exists - preserve its encrypted secrets
                    let house_path = self.get_house_path(&existing_id);
                    let (signing_secret, symmetric_key) = if house_path.exists() {
                        match fs::read_to_string(&house_path)
                            .ok()
                            .and_then(|s| serde_json::from_str::<HouseStorage>(&s).ok())
                        {
                            Some(existing) => (existing.encrypted_signing_secret, existing.encrypted_symmetric_key),
                            None => (None, None),
                        }
                    } else {
                        (None, None)
                    };
                    (existing_id, signing_secret, symmetric_key)
                }
                None => {
                    // New house - use the id from the server
                    (info.id.clone(), None, None)
                }
            };
        
        let house_path = self.get_house_path(&existing_house_id);

        let storage = HouseStorage {
            id: existing_house_id.clone(),
            name: info.name,
            created_at: info.created_at,
            rooms: info.rooms,
            members: info.members,
            signing_pubkey: info.signing_pubkey,
            encrypted_signing_secret: preserve_encrypted_signing_secret,
            encrypted_symmetric_key: preserve_encrypted_symmetric_key,
            invite_uri: info.invite_uri,
            connection_mode: info.connection_mode,
            signaling_url: info.signaling_url,
            invite_code: info.invite_code,
            active_invite_uri: info.active_invite_uri,
            active_invite_expires_at: info.active_invite_expires_at,
            public_key: info.public_key,
        };

        let json = serde_json::to_string_pretty(&storage)?;
        fs::write(house_path, json)?;
        Ok(())
    }

    /// Import a house from an invite token that contains the house symmetric key.
    /// This lets a new member decrypt future Option-B hints.
    /// Returns the actual house ID used (may differ from info.id if house already existed).
    pub fn import_house_invite(&self, info: HouseInfo, house_symmetric_key: Vec<u8>) -> Result<String, HouseError> {
        // Check if house already exists by signing_pubkey
        let existing_house_id_opt = self.find_house_id_by_signing_pubkey(&info.signing_pubkey)?;
        
        // Encrypt symmetric key with device key for local storage
        let encrypted_symmetric_key = {
            let cipher = XChaCha20Poly1305::new((&self.device_key).into());
            let nonce = XChaCha20Poly1305::generate_nonce(&mut OsRng);
            let ciphertext = cipher.encrypt(&nonce, house_symmetric_key.as_ref())
                .map_err(|_| HouseError::EncryptionFailed)?;
            let mut result = nonce.to_vec();
            result.extend(ciphertext);
            Some(base64::encode(&result))
        };

        // Use existing house ID if found, otherwise use the ID from info
        let house_id = existing_house_id_opt.clone().unwrap_or(info.id.clone());
        
        // If house exists, preserve its encrypted_signing_secret
        let preserve_encrypted_signing_secret = if let Some(ref existing_id) = existing_house_id_opt {
            let house_path = self.get_house_path(existing_id);
            if house_path.exists() {
                match fs::read_to_string(&house_path)
                    .ok()
                    .and_then(|s| serde_json::from_str::<HouseStorage>(&s).ok())
                {
                    Some(existing) => existing.encrypted_signing_secret,
                    None => None,
                }
            } else {
                None
            }
        } else {
            None
        };

        let storage = HouseStorage {
            id: house_id.clone(),
            name: info.name,
            created_at: info.created_at,
            rooms: info.rooms,
            members: info.members,
            signing_pubkey: info.signing_pubkey,
            encrypted_signing_secret: preserve_encrypted_signing_secret,
            encrypted_symmetric_key,
            invite_uri: info.invite_uri,
            connection_mode: info.connection_mode,
            signaling_url: info.signaling_url,
            invite_code: info.invite_code,
            active_invite_uri: info.active_invite_uri,
            active_invite_expires_at: info.active_invite_expires_at,
            public_key: info.public_key,
        };

        let house_path = self.get_house_path(&storage.id);
        let json = serde_json::to_string_pretty(&storage)?;
        fs::write(house_path, json)?;
        Ok(house_id)  // Return the actual house ID used
    }
}
