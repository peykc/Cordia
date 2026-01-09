use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::fs;
use thiserror::Error;

#[derive(Error, Debug)]
pub enum AudioSettingsError {
    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),
    #[error("Serialization error: {0}")]
    Serialization(#[from] serde_json::Error),
}

#[derive(Serialize, Deserialize, Clone)]
pub struct AudioSettings {
    pub input_device_id: Option<String>,
    pub output_device_id: Option<String>,
    pub input_volume: f32,  // 0.0 to 1.0+ - input gain (affects actual audio)
    #[serde(alias = "input_volume")]
    pub input_sensitivity: f32,  // 0.0 to 1.0 - voice activity threshold
    pub output_volume: f32, // 0.0 to 1.0
    #[serde(default = "default_input_mode")]
    pub input_mode: String, // "voice_activity" or "push_to_talk"
    #[serde(default)]
    pub push_to_talk_key: Option<String>, // Key binding for PTT
}

fn default_input_mode() -> String {
    "voice_activity".to_string()
}

impl Default for AudioSettings {
    fn default() -> Self {
        Self {
            input_device_id: None,
            output_device_id: None,
            input_volume: 1.0, // Default gain (no amplification)
            input_sensitivity: 0.2, // Discord-style default (0.15-0.25 range)
            output_volume: 1.0,
            input_mode: "voice_activity".to_string(),
            push_to_talk_key: None,
        }
    }
}

pub struct AudioSettingsManager {
    data_dir: PathBuf,
}

impl AudioSettingsManager {
    pub fn new() -> Result<Self, AudioSettingsError> {
        let data_dir = Self::get_data_dir()?;
        fs::create_dir_all(&data_dir)?;
        Ok(Self { data_dir })
    }

    fn get_data_dir() -> Result<PathBuf, AudioSettingsError> {
        #[cfg(target_os = "windows")]
        {
            let app_data = std::env::var("APPDATA")
                .map_err(|_| AudioSettingsError::Io(std::io::Error::new(
                    std::io::ErrorKind::NotFound,
                    "APPDATA not found"
                )))?;
            Ok(PathBuf::from(app_data).join("Roommate"))
        }
        
        #[cfg(target_os = "macos")]
        {
            let home = std::env::var("HOME")
                .map_err(|_| AudioSettingsError::Io(std::io::Error::new(
                    std::io::ErrorKind::NotFound,
                    "HOME not found"
                )))?;
            Ok(PathBuf::from(home).join("Library").join("Application Support").join("Roommate"))
        }
        
        #[cfg(target_os = "linux")]
        {
            let home = std::env::var("HOME")
                .map_err(|_| AudioSettingsError::Io(std::io::Error::new(
                    std::io::ErrorKind::NotFound,
                    "HOME not found"
                )))?;
            Ok(PathBuf::from(home).join(".config").join("roommate"))
        }
        
        #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
        {
            Err(AudioSettingsError::Io(std::io::Error::new(
                std::io::ErrorKind::Unsupported,
                "Unsupported platform"
            )))
        }
    }

    fn get_settings_path(&self) -> PathBuf {
        self.data_dir.join("audio_settings.json")
    }

    pub fn load_settings(&self) -> Result<AudioSettings, AudioSettingsError> {
        let settings_path = self.get_settings_path();
        
        if !settings_path.exists() {
            return Ok(AudioSettings::default());
        }

        let content = fs::read_to_string(&settings_path)?;
        let mut settings: AudioSettings = serde_json::from_str(&content)?;
        
        // Migrate old input_volume to input_sensitivity if needed
        // (serde alias handles deserialization, but we ensure it's saved with new name)
        
        Ok(settings)
    }

    pub fn save_settings(&self, settings: &AudioSettings) -> Result<(), AudioSettingsError> {
        let settings_path = self.get_settings_path();
        let json = serde_json::to_string_pretty(settings)?;
        fs::write(settings_path, json)?;
        Ok(())
    }
}

