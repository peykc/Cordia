use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::fs;
use thiserror::Error;
use uuid::Uuid;
use chrono::{DateTime, Utc};
use sha2::{Digest, Sha256};

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
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct House {
    pub id: String,
    pub name: String,
    pub created_at: DateTime<Utc>,
    pub rooms: Vec<Room>,
    pub members: Vec<HouseMember>,

    // New P2P fields
    pub public_key: String,
    pub invite_uri: String,                         // rmmt://pubkey@server format
    #[serde(default)]
    pub connection_mode: ConnectionMode,
    #[serde(default)]
    pub signaling_url: Option<String>,

    // Deprecated field - keep for backward compatibility
    #[serde(default = "House::generate_invite_code")]
    pub invite_code: String,
}

impl House {
    pub fn new(name: String, creator_user_id: String, creator_display_name: String) -> Self {
        Self::new_with_mode(name, creator_user_id, creator_display_name, ConnectionMode::Signaling, None)
    }

    pub fn new_with_mode(
        name: String,
        creator_user_id: String,
        creator_display_name: String,
        connection_mode: ConnectionMode,
        signaling_url: Option<String>,
    ) -> Self {
        let id = Uuid::new_v4().to_string();
        let invite_code = Self::generate_invite_code();
        let now = Utc::now();

        // Generate house public key from creator's public key + house id
        let public_key = Self::generate_house_public_key(&creator_user_id, &id);

        // Generate invite URI based on connection mode
        let invite_uri = Self::generate_invite_uri(&public_key, &connection_mode, signaling_url.as_deref());

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
        };

        Self {
            id,
            name,
            created_at: now,
            rooms: vec![general_room],
            members: vec![creator],
            public_key,
            invite_uri,
            connection_mode,
            signaling_url,
            invite_code,
        }
    }

    fn generate_house_public_key(creator_pubkey: &str, house_id: &str) -> String {
        let mut hasher = Sha256::new();
        hasher.update(creator_pubkey.as_bytes());
        hasher.update(house_id.as_bytes());
        let result = hasher.finalize();
        hex::encode(result)
    }

    fn generate_invite_uri(public_key: &str, mode: &ConnectionMode, signaling_url: Option<&str>) -> String {
        match mode {
            ConnectionMode::Signaling => {
                let server = signaling_url.unwrap_or("signal.roommate.app");
                format!("rmmt://{}@{}", public_key, server)
            }
            ConnectionMode::DHT => {
                // Use first 16 chars of pubkey as DHT hash for now
                let dht_hash = &public_key[..16.min(public_key.len())];
                format!("rmmt://{}@dht:{}", public_key, dht_hash)
            }
            ConnectionMode::Manual => {
                format!("rmmt://{}@manual", public_key)
            }
        }
    }

    fn generate_invite_code() -> String {
        use rand::Rng;
        const CHARSET: &[u8] = b"ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // Exclude similar chars (I, O, 0, 1)
        let mut rng = rand::thread_rng();

        (0..8)
            .map(|_| {
                let idx = rng.gen_range(0..CHARSET.len());
                CHARSET[idx] as char
            })
            .collect()
    }

    pub fn add_member(&mut self, user_id: String, display_name: String) {
        let member = HouseMember {
            user_id,
            display_name,
            joined_at: Utc::now(),
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
}

pub struct HouseManager {
    data_dir: PathBuf,
}

impl HouseManager {
    pub fn new() -> Result<Self, HouseError> {
        let data_dir = Self::get_data_dir()?;
        fs::create_dir_all(&data_dir)?;

        // Create houses subdirectory
        let houses_dir = data_dir.join("houses");
        fs::create_dir_all(&houses_dir)?;

        Ok(Self { data_dir })
    }

    fn get_data_dir() -> Result<PathBuf, HouseError> {
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

    fn get_house_list_path(&self) -> PathBuf {
        self.data_dir.join("houses").join("list.json")
    }

    pub fn create_house(&self, name: String, user_id: String, display_name: String) -> Result<House, HouseError> {
        let house = House::new(name, user_id, display_name);

        // Save house file
        self.save_house(&house)?;

        // Update house list
        self.add_to_house_list(&house.id)?;

        Ok(house)
    }

    pub fn save_house(&self, house: &House) -> Result<(), HouseError> {
        let house_path = self.get_house_path(&house.id);
        let json = serde_json::to_string_pretty(house)?;
        fs::write(house_path, json)?;
        Ok(())
    }

    pub fn load_house(&self, house_id: &str) -> Result<House, HouseError> {
        let house_path = self.get_house_path(house_id);

        if !house_path.exists() {
            return Err(HouseError::NotFound(house_id.to_string()));
        }

        let content = fs::read_to_string(&house_path)?;
        let house: House = serde_json::from_str(&content)?;
        Ok(house)
    }

    pub fn list_houses(&self) -> Result<Vec<String>, HouseError> {
        let list_path = self.get_house_list_path();

        if !list_path.exists() {
            return Ok(Vec::new());
        }

        let content = fs::read_to_string(&list_path)?;
        let house_ids: Vec<String> = serde_json::from_str(&content)?;
        Ok(house_ids)
    }

    pub fn load_all_houses(&self) -> Result<Vec<House>, HouseError> {
        let house_ids = self.list_houses()?;
        let mut houses = Vec::new();

        for house_id in house_ids {
            if let Ok(house) = self.load_house(&house_id) {
                houses.push(house);
            }
        }

        Ok(houses)
    }

    fn add_to_house_list(&self, house_id: &str) -> Result<(), HouseError> {
        let mut house_ids = self.list_houses()?;

        if !house_ids.contains(&house_id.to_string()) {
            house_ids.push(house_id.to_string());
            let list_path = self.get_house_list_path();
            let json = serde_json::to_string_pretty(&house_ids)?;
            fs::write(list_path, json)?;
        }

        Ok(())
    }

    pub fn delete_house(&self, house_id: &str) -> Result<(), HouseError> {
        // Remove from list
        let mut house_ids = self.list_houses()?;
        house_ids.retain(|id| id != house_id);
        let list_path = self.get_house_list_path();
        let json = serde_json::to_string_pretty(&house_ids)?;
        fs::write(list_path, json)?;

        // Delete house file
        let house_path = self.get_house_path(house_id);
        if house_path.exists() {
            fs::remove_file(house_path)?;
        }

        Ok(())
    }

    pub fn find_house_by_invite(&self, invite_code: &str) -> Result<Option<House>, HouseError> {
        let house_ids = self.list_houses()?;

        for house_id in house_ids {
            if let Ok(house) = self.load_house(&house_id) {
                if house.invite_code == invite_code {
                    return Ok(Some(house));
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

    pub fn remove_room_from_house(&self, house_id: &str, room_id: &str) -> Result<House, HouseError> {
        let mut house = self.load_house(house_id)?;

        if !house.remove_room(room_id) {
            return Err(HouseError::NotFound(format!("Room {} not found", room_id)));
        }

        self.save_house(&house)?;
        Ok(house)
    }
}
