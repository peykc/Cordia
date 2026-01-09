// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod identity;
mod audio_settings;
mod house;
mod signaling;

use identity::{IdentityManager, UserIdentity};
use audio_settings::{AudioSettingsManager, AudioSettings};
use house::{HouseManager, House};
use signaling::{check_signaling_health, get_default_signaling_url};

#[tauri::command]
fn has_identity() -> Result<bool, String> {
    let manager = IdentityManager::new()
        .map_err(|e| format!("Failed to initialize identity manager: {}", e))?;
    Ok(manager.has_identity())
}

#[tauri::command]
fn create_identity(display_name: String) -> Result<UserIdentity, String> {
    IdentityManager::create_identity(display_name)
        .map_err(|e| format!("Failed to create identity: {}", e))
}

#[tauri::command]
fn load_identity() -> Result<UserIdentity, String> {
    let manager = IdentityManager::new()
        .map_err(|e| format!("Failed to initialize identity manager: {}", e))?;
    manager.load_identity()
        .map_err(|e| format!("Failed to load identity: {}", e))
}

#[tauri::command]
fn export_identity() -> Result<Vec<u8>, String> {
    let manager = IdentityManager::new()
        .map_err(|e| format!("Failed to initialize identity manager: {}", e))?;
    manager.export_identity()
        .map_err(|e| format!("Failed to export identity: {}", e))
}

#[tauri::command]
fn import_identity(data: Vec<u8>) -> Result<UserIdentity, String> {
    let manager = IdentityManager::new()
        .map_err(|e| format!("Failed to initialize identity manager: {}", e))?;
    manager.import_identity(&data)
        .map_err(|e| format!("Failed to import identity: {}", e))
}

#[tauri::command]
fn load_audio_settings() -> Result<AudioSettings, String> {
    let manager = AudioSettingsManager::new()
        .map_err(|e| format!("Failed to initialize audio settings manager: {}", e))?;
    manager.load_settings()
        .map_err(|e| format!("Failed to load audio settings: {}", e))
}

#[tauri::command]
fn save_audio_settings(settings: AudioSettings) -> Result<(), String> {
    let manager = AudioSettingsManager::new()
        .map_err(|e| format!("Failed to initialize audio settings manager: {}", e))?;
    manager.save_settings(&settings)
        .map_err(|e| format!("Failed to save audio settings: {}", e))
}

#[tauri::command]
fn create_house(name: String, user_id: String, display_name: String) -> Result<House, String> {
    let manager = HouseManager::new()
        .map_err(|e| format!("Failed to initialize house manager: {}", e))?;
    manager.create_house(name, user_id, display_name)
        .map_err(|e| format!("Failed to create house: {}", e))
}

#[tauri::command]
fn list_houses() -> Result<Vec<House>, String> {
    let manager = HouseManager::new()
        .map_err(|e| format!("Failed to initialize house manager: {}", e))?;
    manager.load_all_houses()
        .map_err(|e| format!("Failed to load houses: {}", e))
}

#[tauri::command]
fn load_house(house_id: String) -> Result<House, String> {
    let manager = HouseManager::new()
        .map_err(|e| format!("Failed to initialize house manager: {}", e))?;
    manager.load_house(&house_id)
        .map_err(|e| format!("Failed to load house: {}", e))
}

#[tauri::command]
fn delete_house(house_id: String) -> Result<(), String> {
    let manager = HouseManager::new()
        .map_err(|e| format!("Failed to initialize house manager: {}", e))?;
    manager.delete_house(&house_id)
        .map_err(|e| format!("Failed to delete house: {}", e))
}

#[tauri::command]
fn find_house_by_invite(invite_code: String) -> Result<Option<House>, String> {
    let manager = HouseManager::new()
        .map_err(|e| format!("Failed to initialize house manager: {}", e))?;
    manager.find_house_by_invite(&invite_code)
        .map_err(|e| format!("Failed to find house: {}", e))
}

#[tauri::command]
fn join_house(house_id: String, user_id: String, display_name: String) -> Result<House, String> {
    let manager = HouseManager::new()
        .map_err(|e| format!("Failed to initialize house manager: {}", e))?;
    manager.add_member_to_house(&house_id, user_id, display_name)
        .map_err(|e| format!("Failed to join house: {}", e))
}

#[tauri::command]
fn add_room(house_id: String, name: String, description: Option<String>) -> Result<House, String> {
    let manager = HouseManager::new()
        .map_err(|e| format!("Failed to initialize house manager: {}", e))?;
    manager.add_room_to_house(&house_id, name, description)
        .map_err(|e| format!("Failed to add room: {}", e))
}

#[tauri::command]
fn remove_room(house_id: String, room_id: String) -> Result<House, String> {
    let manager = HouseManager::new()
        .map_err(|e| format!("Failed to initialize house manager: {}", e))?;
    manager.remove_room_from_house(&house_id, &room_id)
        .map_err(|e| format!("Failed to remove room: {}", e))
}

#[tauri::command]
async fn check_signaling_server(url: Option<String>) -> Result<bool, String> {
    let server_url = url.unwrap_or_else(get_default_signaling_url);
    check_signaling_health(&server_url)
        .await
        .map_err(|e| format!("Signaling check failed: {}", e))
}

#[tauri::command]
fn get_default_signaling_server() -> String {
    get_default_signaling_url()
}

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            has_identity,
            create_identity,
            load_identity,
            export_identity,
            import_identity,
            load_audio_settings,
            save_audio_settings,
            create_house,
            list_houses,
            load_house,
            delete_house,
            find_house_by_invite,
            join_house,
            add_room,
            remove_room,
            check_signaling_server,
            get_default_signaling_server
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

