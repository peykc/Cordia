use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use thiserror::Error;

#[derive(Error, Debug)]
pub enum AccountError {
    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),
    #[error("Serialization error: {0}")]
    Serialization(#[from] serde_json::Error),
    #[error("Account not found: {0}")]
    NotFound(String),
    #[error("No active session")]
    NoSession,
}

/// Session state for auto-login behavior
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionState {
    pub current_account_id: Option<String>,
    pub last_login: Option<String>,
}

impl Default for SessionState {
    fn default() -> Self {
        Self {
            current_account_id: None,
            last_login: None,
        }
    }
}

/// Account metadata stored in each account directory
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AccountInfo {
    pub account_id: String,
    pub display_name: String,
    pub created_at: String,
    #[serde(default)]
    pub signaling_server_url: Option<String>,
}

/// Cached profile data for a remote user (display name, etc.) persisted per account and in .key export
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KnownProfile {
    pub display_name: String,
    #[serde(default)]
    pub secondary_name: Option<String>,
    #[serde(default)]
    pub show_secondary: bool,
    #[serde(default)]
    pub rev: Option<u64>,
    #[serde(default)]
    pub account_created_at: Option<String>,
}

/// Manages account containers and session state
pub struct AccountManager {
    data_dir: PathBuf,
}

impl AccountManager {
    pub fn new() -> Result<Self, AccountError> {
        let data_dir = Self::get_data_dir()?;
        fs::create_dir_all(data_dir.join("accounts"))?;
        Ok(Self { data_dir })
    }

    /// Get the base data directory (respects ROOMMATE_DATA_DIR env var)
    fn get_data_dir() -> Result<PathBuf, AccountError> {
        // Check for custom data directory (for testing with multiple instances)
        if let Ok(custom_dir) = std::env::var("ROOMMATE_DATA_DIR") {
            let path = PathBuf::from(custom_dir);
            if !path.exists() {
                fs::create_dir_all(&path)?;
            }
            return Ok(path);
        }

        #[cfg(target_os = "windows")]
        {
            let app_data = std::env::var("APPDATA").map_err(|_| {
                AccountError::Io(std::io::Error::new(
                    std::io::ErrorKind::NotFound,
                    "APPDATA not found",
                ))
            })?;
            Ok(PathBuf::from(app_data).join("Roommate"))
        }

        #[cfg(target_os = "macos")]
        {
            let home = std::env::var("HOME").map_err(|_| {
                AccountError::Io(std::io::Error::new(
                    std::io::ErrorKind::NotFound,
                    "HOME not found",
                ))
            })?;
            Ok(PathBuf::from(home)
                .join("Library")
                .join("Application Support")
                .join("Roommate"))
        }

        #[cfg(target_os = "linux")]
        {
            let home = std::env::var("HOME").map_err(|_| {
                AccountError::Io(std::io::Error::new(
                    std::io::ErrorKind::NotFound,
                    "HOME not found",
                ))
            })?;
            Ok(PathBuf::from(home).join(".config").join("cordia"))
        }

        #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
        {
            Err(AccountError::Io(std::io::Error::new(
                std::io::ErrorKind::Unsupported,
                "Unsupported platform",
            )))
        }
    }

    /// Get the path to an account's directory
    pub fn get_account_dir(&self, account_id: &str) -> PathBuf {
        self.data_dir.join("accounts").join(account_id)
    }

    /// Get the path to the session.json file
    fn get_session_path(&self) -> PathBuf {
        self.data_dir.join("session.json")
    }

    /// List all account IDs by scanning the accounts directory
    pub fn list_accounts(&self) -> Result<Vec<String>, AccountError> {
        let accounts_dir = self.data_dir.join("accounts");

        if !accounts_dir.exists() {
            return Ok(Vec::new());
        }

        let mut accounts = Vec::new();
        for entry in fs::read_dir(accounts_dir)? {
            let entry = entry?;
            if entry.path().is_dir() {
                if let Some(name) = entry.file_name().to_str() {
                    // Only include directories that have a keys.dat file (valid accounts)
                    let keys_path = entry.path().join("keys.dat");
                    if keys_path.exists() {
                        accounts.push(name.to_string());
                    }
                }
            }
        }

        Ok(accounts)
    }

    /// Get account info for a specific account
    pub fn get_account_info(&self, account_id: &str) -> Result<Option<AccountInfo>, AccountError> {
        let info_path = self.get_account_dir(account_id).join("account_info.json");

        if !info_path.exists() {
            return Ok(None);
        }

        let content = fs::read_to_string(info_path)?;
        let info: AccountInfo = serde_json::from_str(&content)?;
        Ok(Some(info))
    }

    /// Save account info
    pub fn save_account_info(&self, info: &AccountInfo) -> Result<(), AccountError> {
        let account_dir = self.get_account_dir(&info.account_id);
        fs::create_dir_all(&account_dir)?;

        let info_path = account_dir.join("account_info.json");
        let json = serde_json::to_string_pretty(info)?;
        fs::write(info_path, json)?;

        Ok(())
    }

    /// Get the current session state
    pub fn get_session(&self) -> Result<SessionState, AccountError> {
        let session_path = self.get_session_path();

        if !session_path.exists() {
            return Ok(SessionState::default());
        }

        let content = fs::read_to_string(session_path)?;
        let session: SessionState = serde_json::from_str(&content)?;
        Ok(session)
    }

    /// Set the current session (for auto-login)
    pub fn set_session(&self, account_id: &str) -> Result<(), AccountError> {
        // Verify account exists
        let account_dir = self.get_account_dir(account_id);
        if !account_dir.exists() {
            return Err(AccountError::NotFound(account_id.to_string()));
        }

        let session = SessionState {
            current_account_id: Some(account_id.to_string()),
            last_login: Some(chrono::Utc::now().to_rfc3339()),
        };

        let session_path = self.get_session_path();
        let json = serde_json::to_string_pretty(&session)?;
        fs::write(session_path, json)?;

        Ok(())
    }

    /// Clear the current session (logout)
    /// This only removes the session pointer, NOT the account data
    pub fn clear_session(&self) -> Result<(), AccountError> {
        let session_path = self.get_session_path();

        if session_path.exists() {
            fs::remove_file(session_path)?;
        }

        Ok(())
    }

    /// Get the currently active account ID (if any)
    pub fn get_current_account_id(&self) -> Result<Option<String>, AccountError> {
        let session = self.get_session()?;
        Ok(session.current_account_id)
    }

    /// Create a new account directory structure
    pub fn create_account(&self, account_id: &str, display_name: &str) -> Result<(), AccountError> {
        let account_dir = self.get_account_dir(account_id);

        // Create account directory and subdirectories
        fs::create_dir_all(&account_dir)?;
        fs::create_dir_all(account_dir.join("houses"))?;

        // Save account info
        let info = AccountInfo {
            account_id: account_id.to_string(),
            display_name: display_name.to_string(),
            created_at: chrono::Utc::now().to_rfc3339(),
            signaling_server_url: None,
        };
        self.save_account_info(&info)?;

        Ok(())
    }

    /// Check if an account exists
    pub fn account_exists(&self, account_id: &str) -> bool {
        let keys_path = self.get_account_dir(account_id).join("keys.dat");
        keys_path.exists()
    }

    /// Delete an account and all its data
    /// This permanently removes the account directory
    pub fn delete_account(&self, account_id: &str) -> Result<(), AccountError> {
        let account_dir = self.get_account_dir(account_id);

        // Verify account exists
        if !account_dir.exists() {
            return Err(AccountError::NotFound(account_id.to_string()));
        }

        // If this account is the current session, clear the session first
        let session = self.get_session()?;
        if session.current_account_id.as_deref() == Some(account_id) {
            self.clear_session()?;
        }

        // Remove the entire account directory
        if account_dir.exists() {
            fs::remove_dir_all(&account_dir)?;
        }

        Ok(())
    }

    /// Get the base data directory (for use by other modules)
    pub fn get_base_data_dir(&self) -> &PathBuf {
        &self.data_dir
    }

    /// Load friends list for an account (user_id strings). Returns empty vec if file missing.
    pub fn load_friends(&self, account_id: &str) -> Result<Vec<String>, AccountError> {
        let path = self.get_account_dir(account_id).join("friends.json");
        if !path.exists() {
            return Ok(Vec::new());
        }
        let content = fs::read_to_string(path)?;
        let list: Vec<String> = serde_json::from_str(&content)?;
        Ok(list)
    }

    /// Save friends list for an account.
    pub fn save_friends(&self, account_id: &str, friends: &[String]) -> Result<(), AccountError> {
        let account_dir = self.get_account_dir(account_id);
        fs::create_dir_all(&account_dir)?;
        let path = account_dir.join("friends.json");
        let json = serde_json::to_string_pretty(friends)?;
        fs::write(path, json)?;
        Ok(())
    }

    /// Load known profiles (user_id -> last known name etc.) for an account. Empty map if missing.
    pub fn load_known_profiles(&self, account_id: &str) -> Result<std::collections::HashMap<String, KnownProfile>, AccountError> {
        let path = self.get_account_dir(account_id).join("known_profiles.json");
        if !path.exists() {
            return Ok(std::collections::HashMap::new());
        }
        let content = fs::read_to_string(path)?;
        let map: std::collections::HashMap<String, KnownProfile> = serde_json::from_str(&content)?;
        Ok(map)
    }

    /// Save known profiles for an account.
    pub fn save_known_profiles(&self, account_id: &str, profiles: &std::collections::HashMap<String, KnownProfile>) -> Result<(), AccountError> {
        let account_dir = self.get_account_dir(account_id);
        fs::create_dir_all(&account_dir)?;
        let path = account_dir.join("known_profiles.json");
        let json = serde_json::to_string_pretty(profiles)?;
        fs::write(path, json)?;
        Ok(())
    }

    /// Load known house names (signing_pubkey -> name) for an account. Empty map if missing.
    pub fn load_known_house_names(&self, account_id: &str) -> Result<std::collections::HashMap<String, String>, AccountError> {
        let path = self.get_account_dir(account_id).join("known_house_names.json");
        if !path.exists() {
            return Ok(std::collections::HashMap::new());
        }
        let content = fs::read_to_string(path)?;
        let map: std::collections::HashMap<String, String> = serde_json::from_str(&content)?;
        Ok(map)
    }

    /// Save known house names for an account.
    pub fn save_known_house_names(&self, account_id: &str, names: &std::collections::HashMap<String, String>) -> Result<(), AccountError> {
        let account_dir = self.get_account_dir(account_id);
        fs::create_dir_all(&account_dir)?;
        let path = account_dir.join("known_house_names.json");
        let json = serde_json::to_string_pretty(names)?;
        fs::write(path, json)?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn test_session_lifecycle() {
        let temp = tempdir().unwrap();
        std::env::set_var("ROOMMATE_DATA_DIR", temp.path());

        let manager = AccountManager::new().unwrap();

        // Initially no session
        let session = manager.get_session().unwrap();
        assert!(session.current_account_id.is_none());

        // Create an account
        manager.create_account("test_user", "Test User").unwrap();

        // Create a fake keys.dat so account is valid
        let keys_path = manager.get_account_dir("test_user").join("keys.dat");
        fs::write(&keys_path, "fake_keys").unwrap();

        // Set session
        manager.set_session("test_user").unwrap();

        // Session should now be set
        let session = manager.get_session().unwrap();
        assert_eq!(session.current_account_id, Some("test_user".to_string()));

        // Clear session (logout)
        manager.clear_session().unwrap();

        // Session should be cleared
        let session = manager.get_session().unwrap();
        assert!(session.current_account_id.is_none());

        // Account should still exist
        assert!(manager.account_exists("test_user"));

        std::env::remove_var("ROOMMATE_DATA_DIR");
    }
}
