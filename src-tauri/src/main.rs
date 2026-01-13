// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod identity;
mod audio_settings;
mod house;
mod signaling;
mod account_manager;

use identity::{IdentityManager, UserIdentity};
use audio_settings::{AudioSettingsManager, AudioSettings};
use house::{HouseManager, HouseInfo};
use signaling::{check_signaling_health, get_default_signaling_url};
use account_manager::{AccountManager, SessionState, AccountInfo};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use chacha20poly1305::{XChaCha20Poly1305, aead::{Aead, KeyInit, AeadCore}};
use rand::RngCore;

#[derive(Debug, Clone, Serialize, Deserialize)]
struct EncryptedHouseHint {
    signing_pubkey: String,
    encrypted_state: String,
    signature: String,
    last_updated: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct InviteTokenCreateRequest {
    code: String,
    max_uses: u32, // 0 = unlimited
    encrypted_payload: String,
    signature: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct InviteTokenRecord {
    code: String,
    signing_pubkey: String,
    encrypted_payload: String,
    signature: String,
    created_at: String,
    expires_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct InviteTokenPayload {
    house: HouseInfo,
    house_symmetric_key_b64: String,
}

fn derive_invite_key(code: &str) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(code.as_bytes());
    let out = hasher.finalize();
    let mut key = [0u8; 32];
    key.copy_from_slice(&out[..32]);
    key
}

fn encrypt_invite_payload(code: &str, payload: &InviteTokenPayload) -> Result<String, String> {
    let key = derive_invite_key(code);
    let cipher = XChaCha20Poly1305::new((&key).into());
    let mut nonce_bytes = [0u8; 24];
    rand::thread_rng().fill_bytes(&mut nonce_bytes);
    let nonce = nonce_bytes.into();
    let plaintext = serde_json::to_vec(payload).map_err(|e| format!("Failed to serialize invite payload: {}", e))?;
    let ciphertext = cipher.encrypt(&nonce, plaintext.as_ref()).map_err(|_| "Invite encryption failed".to_string())?;
    let mut out = nonce_bytes.to_vec();
    out.extend(ciphertext);
    Ok(base64::encode(&out))
}

fn decrypt_invite_payload(code: &str, encrypted_payload_b64: &str) -> Result<InviteTokenPayload, String> {
    let key = derive_invite_key(code);
    let cipher = XChaCha20Poly1305::new((&key).into());
    let data = base64::decode(encrypted_payload_b64).map_err(|e| format!("Invite payload base64 decode failed: {}", e))?;
    if data.len() < 24 {
        return Err("Invite payload too short".to_string());
    }
    let mut nonce_bytes = [0u8; 24];
    nonce_bytes.copy_from_slice(&data[..24]);
    let nonce = nonce_bytes.into();
    let ciphertext = &data[24..];
    let plaintext = cipher.decrypt(&nonce, ciphertext).map_err(|_| "Invite decryption failed".to_string())?;
    serde_json::from_slice::<InviteTokenPayload>(&plaintext).map_err(|e| format!("Invite payload JSON parse failed: {}", e))
}

fn encrypt_house_hint(symmetric_key: &[u8], house: &HouseInfo) -> Result<String, String> {
    if symmetric_key.len() != 32 {
        return Err("Invalid house symmetric key length".to_string());
    }
    let cipher = XChaCha20Poly1305::new(symmetric_key.into());
    let mut nonce_bytes = [0u8; 24];
    rand::thread_rng().fill_bytes(&mut nonce_bytes);
    let nonce = nonce_bytes.into();
    let plaintext = serde_json::to_vec(house).map_err(|e| format!("Failed to serialize house: {}", e))?;
    let ciphertext = cipher.encrypt(&nonce, plaintext.as_ref()).map_err(|_| "House hint encryption failed".to_string())?;
    let mut out = nonce_bytes.to_vec();
    out.extend(ciphertext);
    Ok(base64::encode(&out))
}

fn decrypt_house_hint(symmetric_key: &[u8], encrypted_state_b64: &str) -> Result<HouseInfo, String> {
    if symmetric_key.len() != 32 {
        return Err("Invalid house symmetric key length".to_string());
    }
    let cipher = XChaCha20Poly1305::new(symmetric_key.into());
    let data = base64::decode(encrypted_state_b64).map_err(|e| format!("House hint base64 decode failed: {}", e))?;
    if data.len() < 24 {
        return Err("House hint ciphertext too short".to_string());
    }
    let mut nonce_bytes = [0u8; 24];
    nonce_bytes.copy_from_slice(&data[..24]);
    let nonce = nonce_bytes.into();
    let ciphertext = &data[24..];
    let plaintext = cipher.decrypt(&nonce, ciphertext).map_err(|_| "House hint decryption failed".to_string())?;
    serde_json::from_slice::<HouseInfo>(&plaintext).map_err(|e| format!("House hint JSON parse failed: {}", e))
}

fn merge_house_infos(mut base: HouseInfo, other: HouseInfo) -> HouseInfo {
    // Members: union by user_id (keep first seen)
    let mut seen = std::collections::HashSet::<String>::new();
    let mut merged_members = Vec::new();
    for m in base.members.into_iter() {
        if seen.insert(m.user_id.clone()) {
            merged_members.push(m);
        }
    }
    for m in other.members.into_iter() {
        if seen.insert(m.user_id.clone()) {
            merged_members.push(m);
        }
    }
    base.members = merged_members;

    // Rooms: union by id
    let mut seen_rooms = std::collections::HashSet::<String>::new();
    let mut merged_rooms = Vec::new();
    for r in base.rooms.into_iter() {
        if seen_rooms.insert(r.id.clone()) {
            merged_rooms.push(r);
        }
    }
    for r in other.rooms.into_iter() {
        if seen_rooms.insert(r.id.clone()) {
            merged_rooms.push(r);
        }
    }
    base.rooms = merged_rooms;

    // Invite state: prefer any active value
    if base.active_invite_uri.is_none() {
        base.active_invite_uri = other.active_invite_uri;
    }
    if base.active_invite_expires_at.is_none() {
        base.active_invite_expires_at = other.active_invite_expires_at;
    }

    base
}

fn normalize_signaling_to_http(url: &str) -> Result<String, String> {
    let url = url.trim();
    if url.starts_with("wss://") {
        Ok(url.replacen("wss://", "https://", 1).trim_end_matches('/').to_string())
    } else if url.starts_with("ws://") {
        Ok(url.replacen("ws://", "http://", 1).trim_end_matches('/').to_string())
    } else if url.starts_with("https://") || url.starts_with("http://") {
        Ok(url.trim_end_matches('/').to_string())
    } else {
        // Assume TLS by default for user-hosted domains
        Ok(format!("https://{}", url.trim_end_matches('/')))
    }
}

/// Session guard: Ensures an active session exists
/// Returns the current account ID or an error if no session
fn require_session() -> Result<String, String> {
    let account_manager = AccountManager::new()
        .map_err(|e| format!("Failed to access account manager: {}", e))?;
    
    let session = account_manager.get_session()
        .map_err(|e| format!("Failed to get session: {}", e))?;
    
    session.current_account_id
        .ok_or_else(|| "No active session - please log in".to_string())
}

#[tauri::command]
fn has_identity() -> Result<bool, String> {
    // NO GUARD: Bootstrap command - can run without session
    // This is used during initial setup to check if identity exists
    
    let manager = IdentityManager::new()
        .map_err(|e| format!("Failed to initialize identity manager: {}", e))?;
    Ok(manager.has_identity())
}

#[tauri::command]
fn check_account_has_identity(account_id: String) -> Result<bool, String> {
    // Check if an account has identity without requiring active session
    // Used for account selection screen
    IdentityManager::account_has_identity(&account_id)
        .map_err(|e| format!("Failed to check account identity: {}", e))
}

#[tauri::command]
fn create_identity(display_name: String) -> Result<UserIdentity, String> {
    IdentityManager::create_identity(display_name)
        .map_err(|e| format!("Failed to create identity: {}", e))
}

#[tauri::command]
fn load_identity() -> Result<UserIdentity, String> {
    // GUARDED: Requires active session
    require_session()?;
    
    let manager = IdentityManager::new()
        .map_err(|e| format!("Failed to initialize identity manager: {}", e))?;
    manager.load_identity()
        .map_err(|e| format!("Failed to load identity: {}", e))
}

#[tauri::command]
fn export_identity() -> Result<Vec<u8>, String> {
    // GUARDED: Requires active session
    require_session()?;
    
    let manager = IdentityManager::new()
        .map_err(|e| format!("Failed to initialize identity manager: {}", e))?;
    manager.export_identity()
        .map_err(|e| format!("Failed to export identity: {}", e))
}

#[tauri::command]
fn import_identity(data: Vec<u8>) -> Result<UserIdentity, String> {
    // NO GUARD: Bootstrap command - works without session for initial setup
    
    // Parse the identity data
    #[derive(serde::Deserialize)]
    struct ExportFormat {
        version: u8,
        identity: UserIdentity,
    }
    
    let export: ExportFormat = serde_json::from_slice(&data)
        .map_err(|_| "Invalid identity file".to_string())?;
    
    if export.version != 1 {
        return Err("Unsupported identity file version".to_string());
    }
    
    let identity = export.identity;
    let user_id = identity.user_id.clone();
    let display_name = identity.display_name.clone();

    // Create account container if it doesn't exist
    let account_manager = AccountManager::new()
        .map_err(|e| format!("Failed to access account manager: {}", e))?;

    if !account_manager.account_exists(&user_id) {
        account_manager.create_account(&user_id, &display_name)
            .map_err(|e| format!("Failed to create account: {}", e))?;
    }

    // Set session explicitly (bootstrap behavior)
    account_manager.set_session(&user_id)
        .map_err(|e| format!("Failed to set session: {}", e))?;

    // Save identity to account directory
    let manager = IdentityManager::for_account(&user_id)
        .map_err(|e| format!("Failed to initialize identity manager: {}", e))?;
    manager.save_identity(&identity)
        .map_err(|e| format!("Failed to save identity: {}", e))?;

    Ok(identity)
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
fn create_house(name: String, user_id: String, display_name: String) -> Result<HouseInfo, String> {
    // GUARDED: Requires active session
    require_session()?;
    
    let manager = HouseManager::new()
        .map_err(|e| format!("Failed to initialize house manager: {}", e))?;
    let house = manager.create_house(name, user_id, display_name)
        .map_err(|e| format!("Failed to create house: {}", e))?;
    Ok(house.to_info())
}

#[tauri::command]
fn list_houses() -> Result<Vec<HouseInfo>, String> {
    // GUARDED: Requires active session
    require_session()?;
    
    let manager = HouseManager::new()
        .map_err(|e| format!("Failed to initialize house manager: {}", e))?;
    let houses = manager.load_all_houses()
        .map_err(|e| format!("Failed to load houses: {}", e))?;
    Ok(houses.into_iter().map(|h| h.to_info()).collect())
}

#[tauri::command]
fn load_house(house_id: String) -> Result<HouseInfo, String> {
    // GUARDED: Requires active session
    require_session()?;
    
    let manager = HouseManager::new()
        .map_err(|e| format!("Failed to initialize house manager: {}", e))?;
    let house = manager.load_house(&house_id)
        .map_err(|e| format!("Failed to load house: {}", e))?;
    Ok(house.to_info())
}

#[tauri::command]
fn delete_house(house_id: String) -> Result<(), String> {
    // GUARDED: Requires active session
    require_session()?;
    
    let manager = HouseManager::new()
        .map_err(|e| format!("Failed to initialize house manager: {}", e))?;
    manager.delete_house(&house_id)
        .map_err(|e| format!("Failed to delete house: {}", e))
}

#[tauri::command]
fn find_house_by_invite(invite_code: String) -> Result<Option<HouseInfo>, String> {
    // GUARDED: Requires active session
    require_session()?;
    
    let manager = HouseManager::new()
        .map_err(|e| format!("Failed to initialize house manager: {}", e))?;
    let house = manager.find_house_by_invite(&invite_code)
        .map_err(|e| format!("Failed to find house: {}", e))?;
    Ok(house.map(|h| h.to_info()))
}

#[tauri::command]
fn join_house(house_id: String, user_id: String, display_name: String) -> Result<HouseInfo, String> {
    // GUARDED: Requires active session
    require_session()?;
    
    let manager = HouseManager::new()
        .map_err(|e| format!("Failed to initialize house manager: {}", e))?;
    let house = manager.add_member_to_house(&house_id, user_id, display_name)
        .map_err(|e| format!("Failed to join house: {}", e))?;
    Ok(house.to_info())
}

#[tauri::command]
fn add_room(house_id: String, name: String, description: Option<String>) -> Result<HouseInfo, String> {
    // GUARDED: Requires active session
    require_session()?;
    
    let manager = HouseManager::new()
        .map_err(|e| format!("Failed to initialize house manager: {}", e))?;
    let house = manager.add_room_to_house(&house_id, name, description)
        .map_err(|e| format!("Failed to add room: {}", e))?;
    Ok(house.to_info())
}

#[tauri::command]
fn remove_room(house_id: String, room_id: String) -> Result<HouseInfo, String> {
    // GUARDED: Requires active session
    require_session()?;
    
    let manager = HouseManager::new()
        .map_err(|e| format!("Failed to initialize house manager: {}", e))?;
    let house = manager.remove_room_from_house(&house_id, &room_id)
        .map_err(|e| format!("Failed to remove room: {}", e))?;
    Ok(house.to_info())
}

#[tauri::command]
fn import_house_hint(house: HouseInfo) -> Result<(), String> {
    // GUARDED: Requires active session (joining a house is a usage action)
    require_session()?;

    let manager = HouseManager::new()
        .map_err(|e| format!("Failed to initialize house manager: {}", e))?;

    manager
        .import_house_hint(house)
        .map_err(|e| format!("Failed to import house hint: {}", e))
}

#[tauri::command]
async fn register_house_hint(signaling_server: String, hint: EncryptedHouseHint) -> Result<(), String> {
    // Usage command (publishing state) - require session
    require_session()?;

    let base = normalize_signaling_to_http(&signaling_server)?;
    let url = format!(
        "{}/api/houses/{}/register",
        base,
        urlencoding::encode(&hint.signing_pubkey)
    );

    let client = reqwest::Client::new();
    let resp = client
        .post(url)
        .json(&hint)
        .send()
        .await
        .map_err(|e| format!("Failed to POST house hint: {}", e))?;

    if !resp.status().is_success() {
        return Err(format!("Failed to register house hint: HTTP {}", resp.status()));
    }

    Ok(())
}

#[tauri::command]
async fn get_house_hint(signaling_server: String, signing_pubkey: String) -> Result<Option<EncryptedHouseHint>, String> {
    // Usage command (joining) - require session
    require_session()?;

    let base = normalize_signaling_to_http(&signaling_server)?;
    let url = format!(
        "{}/api/houses/{}/hint",
        base,
        urlencoding::encode(&signing_pubkey)
    );

    let client = reqwest::Client::new();
    let resp = client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("Failed to GET house hint: {}", e))?;

    if resp.status().as_u16() == 404 {
        return Ok(None);
    }

    if !resp.status().is_success() {
        return Err(format!("Failed to get house hint: HTTP {}", resp.status()));
    }

    let hint = resp
        .json::<EncryptedHouseHint>()
        .await
        .map_err(|e| format!("Failed to parse house hint JSON: {}", e))?;

    Ok(Some(hint))
}

#[tauri::command]
async fn publish_house_hint_opaque(signaling_server: String, house_id: String) -> Result<(), String> {
    require_session()?;

    let manager = HouseManager::new()
        .map_err(|e| format!("Failed to initialize house manager: {}", e))?;

    let house = manager.load_house(&house_id)
        .map_err(|e| format!("Failed to load house: {}", e))?;

    let symmetric_key = house.get_symmetric_key()
        .ok_or_else(|| "House missing symmetric key".to_string())?;

    let house_info = house.to_info();
    let encrypted_state = encrypt_house_hint(&symmetric_key, &house_info)?;

    let hint = EncryptedHouseHint {
        signing_pubkey: house_info.signing_pubkey.clone(),
        encrypted_state,
        signature: "".to_string(),
        last_updated: chrono::Utc::now().to_rfc3339(),
    };

    register_house_hint(signaling_server, hint).await
}

#[tauri::command]
async fn publish_house_hint_member_left(signaling_server: String, house_id: String, user_id: String) -> Result<(), String> {
    require_session()?;

    let manager = HouseManager::new()
        .map_err(|e| format!("Failed to initialize house manager: {}", e))?;

    let house = manager.load_house(&house_id)
        .map_err(|e| format!("Failed to load house: {}", e))?;

    let symmetric_key = house.get_symmetric_key()
        .ok_or_else(|| "House missing symmetric key".to_string())?;

    let mut house_info = house.to_info();
    house_info.members.retain(|m| m.user_id != user_id);

    let encrypted_state = encrypt_house_hint(&symmetric_key, &house_info)?;
    let hint = EncryptedHouseHint {
        signing_pubkey: house_info.signing_pubkey.clone(),
        encrypted_state,
        signature: "".to_string(),
        last_updated: chrono::Utc::now().to_rfc3339(),
    };

    register_house_hint(signaling_server, hint).await
}

#[tauri::command]
async fn fetch_and_import_house_hint_opaque(signaling_server: String, signing_pubkey: String) -> Result<bool, String> {
    require_session()?;

    // Fetch encrypted hint from server
    let hint = match get_house_hint(signaling_server.clone(), signing_pubkey.clone()).await? {
        Some(h) => h,
        None => return Ok(false),
    };

    // Find local house + symmetric key by signing_pubkey
    let manager = HouseManager::new()
        .map_err(|e| format!("Failed to initialize house manager: {}", e))?;

    let Some(house_id) = manager.find_house_id_by_signing_pubkey(&signing_pubkey)
        .map_err(|e| format!("Failed to find local house: {}", e))? else {
        return Err("Cannot decrypt hint: house not present locally (join via invite first)".to_string());
    };

    let local_house = manager.load_house(&house_id)
        .map_err(|e| format!("Failed to load local house: {}", e))?;

    let symmetric_key = local_house.get_symmetric_key()
        .ok_or_else(|| "Cannot decrypt hint: missing symmetric key (join via invite first)".to_string())?;

    let decrypted = decrypt_house_hint(&symmetric_key, &hint.encrypted_state)?;

    manager.import_house_hint(decrypted)
        .map_err(|e| format!("Failed to import decrypted hint: {}", e))?;

    Ok(true)
}

#[derive(serde::Deserialize)]
struct InviteResolveResponse {
    signing_pubkey: String,
}

#[tauri::command]
async fn resolve_invite_code(signaling_server: String, invite_code: String) -> Result<Option<String>, String> {
    // Usage command (joining) - require session
    require_session()?;

    let base = normalize_signaling_to_http(&signaling_server)?;
    let code = invite_code.trim().to_ascii_uppercase();
    let url = format!("{}/api/invites/{}", base, urlencoding::encode(&code));

    let client = reqwest::Client::new();
    let resp = client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("Failed to resolve invite code: {}", e))?;

    if resp.status().as_u16() == 404 {
        return Ok(None);
    }

    if !resp.status().is_success() {
        return Err(format!("Failed to resolve invite code: HTTP {}", resp.status()));
    }

    let parsed = resp
        .json::<InviteResolveResponse>()
        .await
        .map_err(|e| format!("Failed to parse invite resolve JSON: {}", e))?;

    Ok(Some(parsed.signing_pubkey))
}

#[tauri::command]
async fn create_temporary_invite(signaling_server: String, house_id: String, max_uses: u32) -> Result<String, String> {
    require_session()?;

    let manager = HouseManager::new()
        .map_err(|e| format!("Failed to initialize house manager: {}", e))?;

    // Load house with secrets (need symmetric key)
    let house = manager.load_house(&house_id)
        .map_err(|e| format!("Failed to load house: {}", e))?;

    // Generate a short human-shareable code (18 chars)
    const CHARSET: &[u8] = b"ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    let mut code = String::new();
    let mut bytes = [0u8; 18];
    rand::thread_rng().fill_bytes(&mut bytes);
    for b in bytes {
        code.push(CHARSET[(b as usize) % CHARSET.len()] as char);
    }

    let mut house_info = house.to_info();
    let symmetric_key = house.get_symmetric_key()
        .ok_or_else(|| "House missing symmetric key".to_string())?;

    // Include active invite fields in the payload so new joiners see the current invite state immediately.
    // We treat the invite as "active until revoked"; this timestamp is just to allow UI hiding if it's very stale.
    let invite_uri = format!("rmmt://{}@{}", code, signaling_server.trim());
    let expires_at = chrono::Utc::now() + chrono::Duration::days(30);
    house_info.active_invite_uri = Some(invite_uri.clone());
    house_info.active_invite_expires_at = Some(expires_at);

    let payload = InviteTokenPayload {
        house: house_info.clone(),
        house_symmetric_key_b64: base64::encode(&symmetric_key),
    };
    let encrypted_payload = encrypt_invite_payload(&code, &payload)?;

    // POST to signaling server
    let base = normalize_signaling_to_http(&signaling_server)?;
    let url = format!(
        "{}/api/houses/{}/invites",
        base,
        urlencoding::encode(&house_info.signing_pubkey)
    );

    let client = reqwest::Client::new();
    let req = InviteTokenCreateRequest {
        code: code.clone(),
        max_uses,
        encrypted_payload,
        signature: "".to_string(),
    };
    let resp = client
        .post(url)
        .json(&req)
        .send()
        .await
        .map_err(|e| format!("Failed to create invite on signaling server: {}", e))?;

    if !resp.status().is_success() {
        return Err(format!("Failed to create invite: HTTP {}", resp.status()));
    }

    // Store as active invite locally (clients hide when expired based on expires_at)
    let record = resp.json::<InviteTokenRecord>().await
        .map_err(|e| format!("Failed to parse invite response: {}", e))?;

    manager.set_active_invite(&house_id, Some(invite_uri.clone()), Some(expires_at))
        .map_err(|e| format!("Failed to store active invite: {}", e))?;

    // Propagate active invite to all members via encrypted house hint
    publish_house_hint_opaque(signaling_server.clone(), house_id.clone()).await?;

    Ok(invite_uri)
}

#[tauri::command]
async fn revoke_active_invite(signaling_server: String, house_id: String) -> Result<(), String> {
    require_session()?;

    let manager = HouseManager::new()
        .map_err(|e| format!("Failed to initialize house manager: {}", e))?;

    let house = manager.load_house(&house_id)
        .map_err(|e| format!("Failed to load house: {}", e))?;

    let code = house
        .active_invite_uri
        .as_ref()
        .and_then(|uri| uri.trim().strip_prefix("rmmt://"))
        .and_then(|rest| rest.split('@').next())
        .map(|s| s.to_string());

    if let Some(code) = code {
        let base = normalize_signaling_to_http(&signaling_server)?;
        let url = format!("{}/api/invites/{}/revoke", base, urlencoding::encode(code.trim()));
        let client = reqwest::Client::new();
        let _ = client.post(url).send().await;
    }

    manager
        .set_active_invite(&house_id, None, None)
        .map_err(|e| format!("Failed to clear active invite: {}", e))?;

    // Propagate revocation to all members
    publish_house_hint_opaque(signaling_server.clone(), house_id.clone()).await?;

    Ok(())
}

#[tauri::command]
async fn redeem_temporary_invite(signaling_server: String, code: String, user_id: String, display_name: String) -> Result<HouseInfo, String> {
    require_session()?;

    let base = normalize_signaling_to_http(&signaling_server)?;
    let url = format!("{}/api/invites/{}/redeem", base, urlencoding::encode(code.trim()));

    let client = reqwest::Client::new();
    let resp = client
        .post(url)
        .send()
        .await
        .map_err(|e| format!("Failed to fetch invite: {}", e))?;

    if resp.status().as_u16() == 404 {
        return Err("Invite expired or not found".to_string());
    }
    if !resp.status().is_success() {
        return Err(format!("Failed to fetch invite: HTTP {}", resp.status()));
    }

    let record = resp.json::<InviteTokenRecord>().await
        .map_err(|e| format!("Failed to parse invite token: {}", e))?;

    let payload = decrypt_invite_payload(code.trim(), &record.encrypted_payload)?;
    let symmetric_key = base64::decode(&payload.house_symmetric_key_b64)
        .map_err(|e| format!("Invalid symmetric key b64: {}", e))?;

    let manager = HouseManager::new()
        .map_err(|e| format!("Failed to initialize house manager: {}", e))?;

    // IMPORTANT: The invite payload's house snapshot can be stale (it was created when the invite was generated).
    // Now that we have the symmetric key, pull+decrypt the latest server hint and merge memberships/rooms so we
    // don't overwrite the server's member list with "creator + me".
    let mut merged_house = payload.house.clone();
    if let Some(latest_hint) = get_house_hint(signaling_server.clone(), merged_house.signing_pubkey.clone()).await? {
        if let Ok(server_house) = decrypt_house_hint(&symmetric_key, &latest_hint.encrypted_state) {
            merged_house = merge_house_infos(server_house, merged_house);
        }
    }

    // Import merged house + symmetric key locally
    manager.import_house_invite(merged_house.clone(), symmetric_key)
        .map_err(|e| format!("Failed to import house from invite: {}", e))?;

    // Add member locally
    let updated = manager.add_member_to_house(&merged_house.id, user_id, display_name)
        .map_err(|e| format!("Failed to join house: {}", e))?;

    // CRITICAL: Publish updated encrypted hint as part of redeem flow.
    // Otherwise, other clients (including the creator) may never learn about this membership change,
    // and later syncs can overwrite the joiner's local member list.
    publish_house_hint_opaque(signaling_server.clone(), merged_house.id.clone()).await?;

    Ok(updated.to_info())
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

#[tauri::command]
async fn get_signaling_server_url(app_handle: tauri::AppHandle) -> Result<String, String> {
    let config_dir = app_handle.path_resolver().app_config_dir()
        .ok_or_else(|| "Could not determine config directory".to_string())?;

    let config_file = config_dir.join("signaling.json");

    if !config_file.exists() {
        // Return default if no custom URL is saved
        return Ok(get_default_signaling_url());
    }

    let content = std::fs::read_to_string(config_file)
        .map_err(|e| format!("Failed to read signaling config: {}", e))?;

    let config: serde_json::Value = serde_json::from_str(&content)
        .map_err(|e| format!("Failed to parse signaling config: {}", e))?;

    Ok(config.get("url")
        .and_then(|v| v.as_str())
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .unwrap_or(&get_default_signaling_url())
        .to_string())
}

#[tauri::command]
async fn set_signaling_server_url(app_handle: tauri::AppHandle, url: String) -> Result<(), String> {
    let config_dir = app_handle.path_resolver().app_config_dir()
        .ok_or_else(|| "Could not determine config directory".to_string())?;

    std::fs::create_dir_all(&config_dir)
        .map_err(|e| format!("Failed to create config directory: {}", e))?;

    let config_file = config_dir.join("signaling.json");

    let config = serde_json::json!({
        "url": url.trim()
    });

    std::fs::write(config_file, serde_json::to_string_pretty(&config).unwrap())
        .map_err(|e| format!("Failed to write signaling config: {}", e))?;

    Ok(())
}

// === Account Management Commands ===

#[tauri::command]
fn list_accounts() -> Result<Vec<String>, String> {
    let manager = AccountManager::new()
        .map_err(|e| format!("Failed to create account manager: {}", e))?;
    manager.list_accounts()
        .map_err(|e| format!("Failed to list accounts: {}", e))
}

#[tauri::command]
fn get_account_info(account_id: String) -> Result<Option<AccountInfo>, String> {
    let manager = AccountManager::new()
        .map_err(|e| format!("Failed to create account manager: {}", e))?;
    manager.get_account_info(&account_id)
        .map_err(|e| format!("Failed to get account info: {}", e))
}

#[tauri::command]
fn get_current_session() -> Result<SessionState, String> {
    let manager = AccountManager::new()
        .map_err(|e| format!("Failed to create account manager: {}", e))?;
    manager.get_session()
        .map_err(|e| format!("Failed to get session: {}", e))
}

#[tauri::command]
fn switch_account(account_id: String) -> Result<(), String> {
    let manager = AccountManager::new()
        .map_err(|e| format!("Failed to create account manager: {}", e))?;

    // Verify account exists
    if !manager.account_exists(&account_id) {
        return Err(format!("Account {} does not exist", account_id));
    }

    manager.set_session(&account_id)
        .map_err(|e| format!("Failed to switch account: {}", e))
}

#[tauri::command]
fn logout_account() -> Result<(), String> {
    let manager = AccountManager::new()
        .map_err(|e| format!("Failed to create account manager: {}", e))?;
    manager.clear_session()
        .map_err(|e| format!("Failed to logout: {}", e))
}

#[tauri::command]
fn get_current_account_id() -> Result<Option<String>, String> {
    let manager = AccountManager::new()
        .map_err(|e| format!("Failed to create account manager: {}", e))?;
    manager.get_current_account_id()
        .map_err(|e| format!("Failed to get current account: {}", e))
}

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            // Identity commands
            has_identity,
            check_account_has_identity,
            create_identity,
            load_identity,
            export_identity,
            import_identity,
            // Account management commands
            list_accounts,
            get_account_info,
            get_current_session,
            switch_account,
            logout_account,
            get_current_account_id,
            // Audio settings commands
            load_audio_settings,
            save_audio_settings,
            // House commands
            create_house,
            list_houses,
            load_house,
            delete_house,
            find_house_by_invite,
            join_house,
            add_room,
            remove_room,
            import_house_hint,
            register_house_hint,
            get_house_hint,
            resolve_invite_code,
            publish_house_hint_opaque,
            publish_house_hint_member_left,
            fetch_and_import_house_hint_opaque,
            create_temporary_invite,
            revoke_active_invite,
            redeem_temporary_invite,
            // Signaling commands
            check_signaling_server,
            get_default_signaling_server,
            get_signaling_server_url,
            set_signaling_server_url
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

