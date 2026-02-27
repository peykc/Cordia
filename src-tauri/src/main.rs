// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod identity;
mod audio_settings;
mod audio_capture;
mod audio_dsp;
mod server;
mod beacon;
mod account_manager;

#[cfg(windows)]
mod file_association;

use tauri::Manager;
use identity::{IdentityManager, UserIdentity};
use audio_settings::{AudioSettingsManager, AudioSettings};
use audio_capture::{enumerate_devices, start_capture, stop_capture, AudioDevice, AudioDropStats};
use audio_dsp::{get_dsp, InputMode};
use server::{ServerManager, ServerInfo};
use beacon::{check_beacon_health, get_default_beacon_url};
use account_manager::{AccountManager, SessionState, AccountInfo, KnownProfile, KnownProfileForExport};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use chacha20poly1305::{XChaCha20Poly1305, aead::{Aead, KeyInit, AeadCore}};
use rand::RngCore;
use std::collections::HashMap;
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::PathBuf;
use std::time::UNIX_EPOCH;
use std::process::Command;
use std::sync::{Mutex, OnceLock};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[derive(Debug, Clone, Serialize, Deserialize)]
struct EncryptedServerHint {
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
    #[serde(rename = "house")]
    server: ServerInfo,
    #[serde(rename = "house_symmetric_key_b64")]
    server_symmetric_key_b64: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum AttachmentStorageMode {
    CurrentPath,
    ProgramCopy,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct AttachmentRecord {
    attachment_id: String,
    #[serde(default)]
    sha256: String,
    file_name: String,
    extension: String,
    size_bytes: u64,
    storage_mode: AttachmentStorageMode,
    #[serde(default)]
    source_path: Option<String>,
    #[serde(default)]
    cached_file_name: Option<String>,
    #[serde(default)]
    thumbnail_path: Option<String>,
    created_at: String,
    /// "preparing" | "ready" | "failed" — default "ready" for backward compat
    #[serde(default = "default_attachment_status")]
    status: String,
    /// When false, attachment is not in the share list (uploader unshared) but record is kept for display / share-again
    #[serde(default = "default_true")]
    shared: bool,
}

fn default_true() -> bool {
    true
}

fn default_attachment_status() -> String {
    "ready".to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct AttachmentIndex {
    records: HashMap<String, AttachmentRecord>,
    sha_to_cached_file_name: HashMap<String, String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct PathShaCacheEntry {
    sha256: String,
    size_bytes: u64,
    mtime_secs: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct FileMetadataResult {
    file_name: String,
    extension: String,
    size_bytes: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct AttachmentRegistrationResult {
    attachment_id: String,
    sha256: String,
    file_name: String,
    extension: String,
    size_bytes: u64,
    storage_mode: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    thumbnail_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    source_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    file_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    status: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct SharedAttachmentItem {
    attachment_id: String,
    sha256: String,
    file_name: String,
    extension: String,
    size_bytes: u64,
    storage_mode: String,
    source_path: Option<String>,
    /// Full path to the file for convertFileSrc (source_path or cache path)
    file_path: Option<String>,
    /// Path to thumbnail image (JPEG) for video/image preview, if generated
    thumbnail_path: Option<String>,
    created_at: String,
    can_share_now: bool,
}

fn account_attachment_dir(account_id: &str) -> Result<PathBuf, String> {
    let account_manager = AccountManager::new()
        .map_err(|e| format!("Failed to access account manager: {}", e))?;
    let base = account_manager.get_account_dir(account_id).join("attachments");
    std::fs::create_dir_all(&base).map_err(|e| format!("Failed to create attachments dir: {}", e))?;
    std::fs::create_dir_all(base.join("cache")).map_err(|e| format!("Failed to create attachment cache dir: {}", e))?;
    std::fs::create_dir_all(base.join("downloads")).map_err(|e| format!("Failed to create attachment downloads dir: {}", e))?;
    std::fs::create_dir_all(base.join("thumbs")).map_err(|e| format!("Failed to create attachment thumbs dir: {}", e))?;
    Ok(base)
}

fn attachment_index_path(base: &PathBuf) -> PathBuf {
    base.join("index.json")
}

/// Serializes all attachment index load/modify/save to prevent races when multiple
/// prepare threads run concurrently and overwrite each other's saves.
static ATTACHMENT_INDEX_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

fn with_attachment_index_lock<F, R>(f: F) -> R
where
    F: FnOnce() -> R,
{
    let lock = ATTACHMENT_INDEX_LOCK.get_or_init(|| Mutex::new(()));
    let _guard = lock.lock().unwrap();
    f()
}

fn load_attachment_index(base: &PathBuf) -> AttachmentIndex {
    let path = attachment_index_path(base);
    if !path.exists() {
        return AttachmentIndex::default();
    }
    match std::fs::read_to_string(path) {
        Ok(content) => serde_json::from_str::<AttachmentIndex>(&content).unwrap_or_default(),
        Err(_) => AttachmentIndex::default(),
    }
}

fn save_attachment_index(base: &PathBuf, index: &AttachmentIndex) -> Result<(), String> {
    let path = attachment_index_path(base);
    let json = serde_json::to_string_pretty(index)
        .map_err(|e| format!("Failed to serialize attachment index: {}", e))?;
    std::fs::write(path, json).map_err(|e| format!("Failed to write attachment index: {}", e))
}

fn path_sha_cache_path(base: &PathBuf) -> PathBuf {
    base.join("path_sha_cache.json")
}

fn load_path_sha_cache(base: &PathBuf) -> HashMap<String, PathShaCacheEntry> {
    let path = path_sha_cache_path(base);
    if !path.exists() {
        return HashMap::new();
    }
    match std::fs::read_to_string(&path) {
        Ok(content) => serde_json::from_str(&content).unwrap_or_default(),
        Err(_) => HashMap::new(),
    }
}

fn save_path_sha_cache(base: &PathBuf, cache: &HashMap<String, PathShaCacheEntry>) -> Result<(), String> {
    let path = path_sha_cache_path(base);
    let json = serde_json::to_string_pretty(cache)
        .map_err(|e| format!("Failed to serialize path SHA cache: {}", e))?;
    std::fs::write(path, json).map_err(|e| format!("Failed to write path SHA cache: {}", e))
}

fn sha256_file(path: &PathBuf) -> Result<String, String> {
    let bytes = std::fs::read(path).map_err(|e| format!("Failed to read file for hashing: {}", e))?;
    let mut hasher = Sha256::new();
    hasher.update(&bytes);
    Ok(hex::encode(hasher.finalize()))
}

fn sha256_file_streaming(path: &PathBuf) -> Result<String, String> {
    sha256_file_streaming_with_progress(path, |_| {})
}

fn sha256_file_streaming_with_progress<F>(path: &PathBuf, mut on_progress: F) -> Result<String, String>
where
    F: FnMut(u8),
{
    let mut f = std::fs::File::open(path).map_err(|e| format!("Failed to open file for hashing: {}", e))?;
    let total = f.seek(SeekFrom::End(0)).map_err(|e| format!("Failed to seek for file size: {}", e))?;
    f.seek(SeekFrom::Start(0)).map_err(|e| format!("Failed to seek to start: {}", e))?;
    let mut hasher = Sha256::new();
    let mut buf = [0u8; 1024 * 1024];
    let mut read_total: u64 = 0;
    let mut last_pct: u8 = 0;
    loop {
        let n = f.read(&mut buf).map_err(|e| format!("Failed to read file for hashing: {}", e))?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
        read_total += n as u64;
        if total > 0 {
            let pct = ((read_total * 100) / total).min(100) as u8;
            if pct >= last_pct + 2 || pct == 100 {
                last_pct = pct;
                on_progress(pct);
            }
        }
    }
    Ok(hex::encode(hasher.finalize()))
}

#[derive(Debug)]
struct DownloadStreamState {
    temp_path: PathBuf,
    target_path: PathBuf,
    file: std::fs::File,
}

static DOWNLOAD_STREAMS: OnceLock<Mutex<HashMap<String, DownloadStreamState>>> = OnceLock::new();

fn download_streams() -> &'static Mutex<HashMap<String, DownloadStreamState>> {
    DOWNLOAD_STREAMS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn resolve_downloads_dir(target_dir: Option<String>) -> Result<PathBuf, String> {
    if let Some(dir) = target_dir
        .as_ref()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
    {
        let p = PathBuf::from(dir);
        std::fs::create_dir_all(&p).map_err(|e| format!("Failed to create download directory: {}", e))?;
        return Ok(p);
    }
    if let Some(p) = tauri::api::path::download_dir() {
        std::fs::create_dir_all(&p).map_err(|e| format!("Failed to create OS Downloads directory: {}", e))?;
        return Ok(p);
    }
    let account_id = require_session()?;
    let base = account_attachment_dir(&account_id)?;
    Ok(base.join("downloads"))
}

fn resolve_download_target(downloads_dir: &PathBuf, file_name: &str) -> PathBuf {
    let mut safe_name = file_name.trim().to_string();
    if safe_name.is_empty() {
        safe_name = "download.bin".to_string();
    }
    let desired = downloads_dir.join(&safe_name);
    if !desired.exists() {
        return desired;
    }
    let stem = PathBuf::from(&safe_name)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("download")
        .to_string();
    let ext = PathBuf::from(&safe_name)
        .extension()
        .and_then(|s| s.to_str())
        .map(|s| format!(".{}", s))
        .unwrap_or_default();
    let mut i = 1;
    loop {
        let candidate = downloads_dir.join(format!("{} ({}){}", stem, i, ext));
        if !candidate.exists() {
            return candidate;
        }
        i += 1;
    }
}

fn is_video_ext(ext: &str) -> bool {
    let e = ext.to_lowercase();
    ["mp4", "mov", "webm", "avi", "mkv", "m4v", "wmv", "flv", "mpeg", "mpg", "3gp", "ogv"].contains(&e.as_str())
}

fn is_image_ext(ext: &str) -> bool {
    let e = ext.to_lowercase();
    ["jpg", "jpeg", "png", "gif", "webp", "bmp", "heic", "tiff", "tif"].contains(&e.as_str())
}

fn extract_thumbnail(source: &PathBuf, output_path: &PathBuf, ext: &str) -> bool {
    let ffmpeg = if cfg!(target_os = "windows") { "ffmpeg.exe" } else { "ffmpeg" };
    let output = output_path.to_string_lossy();
    let input = source.to_string_lossy();
    let args: Vec<&str> = if is_video_ext(ext) {
        vec!["-i", &input, "-vframes", "1", "-y", &output]
    } else if is_image_ext(ext) {
        vec!["-i", &input, "-vf", "scale=128:-1", "-y", &output]
    } else {
        return false;
    };
    let mut cmd = Command::new(ffmpeg);
    cmd.args(args)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd.status().map(|s| s.success()).unwrap_or(false)
}

/// Returns file metadata without registering the file as an attachment. Used for staging attachments before send.
#[tauri::command]
fn get_file_metadata(path: String) -> Result<FileMetadataResult, String> {
    let source = PathBuf::from(path.trim());
    if !source.exists() {
        return Err("File not found".to_string());
    }
    let meta = std::fs::metadata(&source).map_err(|e| format!("Failed to read file metadata: {}", e))?;
    if !meta.is_file() {
        return Err("Path must be a file".to_string());
    }
    let file_name = source
        .file_name()
        .and_then(|s| s.to_str())
        .ok_or_else(|| "Invalid file name".to_string())?
        .to_string();
    let extension = source
        .extension()
        .and_then(|s| s.to_str())
        .map(|s| s.to_ascii_lowercase())
        .unwrap_or_default();
    let size_bytes = meta.len();
    Ok(FileMetadataResult {
        file_name,
        extension,
        size_bytes,
    })
}

/// Computes SHA256 of a file (hex-encoded). Used for integrity verification before re-sharing.
#[tauri::command]
fn compute_file_sha256(path: String) -> Result<String, String> {
    let source = PathBuf::from(path.trim());
    if !source.exists() {
        return Err("File not found".to_string());
    }
    let meta = std::fs::metadata(&source).map_err(|e| format!("Failed to read file metadata: {}", e))?;
    if !meta.is_file() {
        return Err("Path must be a file".to_string());
    }
    sha256_file_streaming(&source)
}

#[tauri::command]
fn register_attachment_from_path(
    window: tauri::Window,
    path: String,
    storage_mode: String,
) -> Result<AttachmentRegistrationResult, String> {
    let account_id = require_session()?;
    let source = PathBuf::from(path.trim());
    if !source.exists() {
        return Err("Attachment source file not found".to_string());
    }
    let meta = std::fs::metadata(&source).map_err(|e| format!("Failed to read file metadata: {}", e))?;
    if !meta.is_file() {
        return Err("Attachment source must be a file".to_string());
    }
    let file_name = source
        .file_name()
        .and_then(|s| s.to_str())
        .ok_or_else(|| "Invalid source file name".to_string())?
        .to_string();
    let extension = source
        .extension()
        .and_then(|s| s.to_str())
        .map(|s| s.to_ascii_lowercase())
        .unwrap_or_default();
    let size_bytes = meta.len();
    let mode = if storage_mode == "program_copy" {
        AttachmentStorageMode::ProgramCopy
    } else {
        AttachmentStorageMode::CurrentPath
    };

    let base = account_attachment_dir(&account_id)?;
    let source_path_str = source.to_string_lossy().to_string();
    let attachment_id = with_attachment_index_lock(|| -> Result<String, String> {
        let mut index = load_attachment_index(&base);
        let attachment_id = uuid::Uuid::new_v4().to_string();
        let record = AttachmentRecord {
            attachment_id: attachment_id.clone(),
            sha256: String::new(),
            file_name: file_name.clone(),
            extension: extension.clone(),
            size_bytes,
            storage_mode: mode.clone(),
            source_path: if matches!(mode, AttachmentStorageMode::CurrentPath) {
                Some(source_path_str.clone())
            } else {
                None
            },
            cached_file_name: None,
            thumbnail_path: None,
            created_at: chrono::Utc::now().to_rfc3339(),
            status: "preparing".to_string(),
            shared: true,
        };
        index.records.insert(attachment_id.clone(), record);
        save_attachment_index(&base, &index)?;
        Ok(attachment_id)
    })?;

    let app_handle = window.app_handle().clone();
    let attachment_id_clone = attachment_id.clone();
    let file_name_clone = file_name.clone();
    let extension_clone = extension.clone();
    let mode_clone = mode.clone();
    let source_path_for_thread = source_path_str.clone();
    std::thread::spawn(move || {
        let result = prepare_attachment_background(
            &account_id,
            &source_path_for_thread,
            mode_clone,
            &attachment_id_clone,
            &file_name_clone,
            &extension_clone,
            size_bytes,
            Some((app_handle.clone(), attachment_id_clone.clone())),
        );
        if let Err(ref err) = result {
            if let Ok(base) = account_attachment_dir(&account_id) {
                let _ = with_attachment_index_lock(|| {
                    let mut index = load_attachment_index(&base);
                    if let Some(rec) = index.records.get_mut(&attachment_id_clone) {
                        rec.status = "failed".to_string();
                        let _ = save_attachment_index(&base, &index);
                    }
                });
            }
            eprintln!("Attachment prep failed for {}: {}", attachment_id_clone, err);
        }
        if let Err(e) = app_handle.emit_all("cordia:attachment-ready", serde_json::json!({
            "attachment_id": attachment_id_clone,
            "ok": result.is_ok(),
            "error": result.as_ref().err().map(|s| s.as_str()),
        })) {
            eprintln!("Failed to emit attachment-ready: {:?}", e);
        }
    });

    Ok(AttachmentRegistrationResult {
        attachment_id,
        sha256: String::new(),
        file_name,
        extension,
        size_bytes,
        storage_mode: match mode {
            AttachmentStorageMode::CurrentPath => "current_path".to_string(),
            AttachmentStorageMode::ProgramCopy => "program_copy".to_string(),
        },
        thumbnail_path: None,
        source_path: if matches!(mode, AttachmentStorageMode::CurrentPath) {
            Some(source_path_str)
        } else {
            None
        },
        file_path: None,
        status: Some("preparing".to_string()),
    })
}

fn prepare_attachment_background(
    account_id: &str,
    source_path: &str,
    mode: AttachmentStorageMode,
    attachment_id: &str,
    _file_name: &str,
    extension: &str,
    _size_bytes: u64,
    progress_emitter: Option<(tauri::AppHandle, String)>,
) -> Result<(), String> {
    let base = account_attachment_dir(account_id)?;
    let cache_dir = base.join("cache");
    let source = PathBuf::from(source_path);

    let meta = std::fs::metadata(&source).map_err(|e| format!("Failed to read file metadata: {}", e))?;
    let size_bytes = meta.len();
    let mtime_secs = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0);

    let sha256 = {
        let mut path_cache = load_path_sha_cache(&base);
        let path_key = source.to_string_lossy().to_string();
        let cached = path_cache.get(&path_key);
        let compute_sha = || {
            if let Some((ref app, ref att_id)) = progress_emitter {
                let app = app.clone();
                let att_id = att_id.clone();
                sha256_file_streaming_with_progress(&source, move |pct| {
                    let _ = app.emit_all("cordia:attachment-sha-progress", serde_json::json!({
                        "attachment_id": att_id,
                        "percent": pct,
                    }));
                })
            } else {
                sha256_file_streaming(&source)
            }
        };
        if let Some(entry) = cached {
            if entry.size_bytes == size_bytes && entry.mtime_secs == mtime_secs {
                entry.sha256.clone()
            } else {
                let sha = compute_sha()?;
                path_cache.insert(
                    path_key,
                    PathShaCacheEntry {
                        sha256: sha.clone(),
                        size_bytes,
                        mtime_secs,
                    },
                );
                let _ = save_path_sha_cache(&base, &path_cache);
                sha
            }
        } else {
            let sha = compute_sha()?;
            path_cache.insert(
                path_key,
                PathShaCacheEntry {
                    sha256: sha.clone(),
                    size_bytes,
                    mtime_secs,
                },
            );
            let _ = save_path_sha_cache(&base, &path_cache);
            sha
        }
    };
    let cached_file_name = with_attachment_index_lock(|| -> Result<Option<String>, String> {
        let mut index = load_attachment_index(&base);
        let cached_file_name = if let Some(existing) = index.sha_to_cached_file_name.get(&sha256) {
            Some(existing.clone())
        } else if matches!(mode, AttachmentStorageMode::ProgramCopy) {
            let ext_suffix = if extension.is_empty() {
                "".to_string()
            } else {
                format!(".{}", extension)
            };
            let file_name_cache = format!("{}{}", sha256, ext_suffix);
            let target = cache_dir.join(&file_name_cache);
            if !target.exists() {
                std::fs::copy(&source, &target)
                    .map_err(|e| format!("Failed to copy attachment to cache: {}", e))?;
            }
            index.sha_to_cached_file_name.insert(sha256.clone(), file_name_cache.clone());
            Some(file_name_cache)
        } else {
            None
        };

        if let Some(rec) = index.records.get_mut(attachment_id) {
            rec.sha256 = sha256.clone();
            rec.cached_file_name = cached_file_name.clone();
            rec.source_path = if matches!(mode, AttachmentStorageMode::CurrentPath) {
                Some(source_path.to_string())
            } else {
                None
            };
            rec.status = "ready".to_string();
        }
        save_attachment_index(&base, &index)?;
        Ok(cached_file_name)
    })?;

    if is_video_ext(extension) || is_image_ext(extension) {
        let extract_from = if let Some(cache_name) = &cached_file_name {
            cache_dir.join(cache_name)
        } else {
            source
        };
        let thumb_path = base.join("thumbs").join(format!("{}.jpg", attachment_id));
        if extract_thumbnail(&extract_from, &thumb_path, extension) {
            with_attachment_index_lock(|| {
                let mut index = load_attachment_index(&base);
                if let Some(rec) = index.records.get_mut(attachment_id) {
                    rec.thumbnail_path = Some(thumb_path.to_string_lossy().to_string());
                    let _ = save_attachment_index(&base, &index);
                }
            });
        }
    }

    Ok(())
}

#[tauri::command]
fn get_attachment_record(attachment_id: String) -> Result<Option<AttachmentRegistrationResult>, String> {
    let account_id = require_session()?;
    let base = account_attachment_dir(&account_id)?;
    let index = with_attachment_index_lock(|| load_attachment_index(&base));
    let Some(rec) = index.records.get(&attachment_id) else {
        return Ok(None);
    };
    let file_path = if let Some(cache_name) = &rec.cached_file_name {
        let p = base.join("cache").join(cache_name);
        if p.exists() {
            Some(p.to_string_lossy().to_string())
        } else {
            None
        }
    } else if let Some(src) = &rec.source_path {
        if PathBuf::from(src).exists() {
            Some(src.clone())
        } else {
            None
        }
    } else {
        None
    };
    let thumbnail_path = rec
        .thumbnail_path
        .clone()
        .filter(|p| PathBuf::from(p).exists());
    Ok(Some(AttachmentRegistrationResult {
        attachment_id: rec.attachment_id.clone(),
        sha256: rec.sha256.clone(),
        file_name: rec.file_name.clone(),
        extension: rec.extension.clone(),
        size_bytes: rec.size_bytes,
        storage_mode: match rec.storage_mode {
            AttachmentStorageMode::CurrentPath => "current_path".to_string(),
            AttachmentStorageMode::ProgramCopy => "program_copy".to_string(),
        },
        thumbnail_path,
        source_path: rec.source_path.clone(),
        file_path,
        status: Some(rec.status.clone()),
    }))
}

#[tauri::command]
fn read_attachment_bytes(attachment_id: String) -> Result<Vec<u8>, String> {
    let account_id = require_session()?;
    let base = account_attachment_dir(&account_id)?;
    let index = with_attachment_index_lock(|| load_attachment_index(&base));
    let rec = index
        .records
        .get(&attachment_id)
        .ok_or_else(|| "Attachment not found".to_string())?;
    if rec.status != "ready" {
        return Err("Attachment is still preparing".to_string());
    }

    let path = if let Some(cache_name) = &rec.cached_file_name {
        base.join("cache").join(cache_name)
    } else if let Some(src) = &rec.source_path {
        PathBuf::from(src)
    } else {
        return Err("Attachment has no readable source".to_string());
    };
    std::fs::read(path).map_err(|e| format!("Failed to read attachment data: {}", e))
}

#[tauri::command]
fn read_attachment_chunk(attachment_id: String, offset: u64, length: usize) -> Result<Vec<u8>, String> {
    if length == 0 {
        return Ok(Vec::new());
    }
    let account_id = require_session()?;
    let base = account_attachment_dir(&account_id)?;
    let index = with_attachment_index_lock(|| load_attachment_index(&base));
    let rec = index
        .records
        .get(&attachment_id)
        .ok_or_else(|| "Attachment not found".to_string())?;
    if rec.status != "ready" {
        return Err("Attachment is still preparing".to_string());
    }

    let path = if let Some(cache_name) = &rec.cached_file_name {
        base.join("cache").join(cache_name)
    } else if let Some(src) = &rec.source_path {
        PathBuf::from(src)
    } else {
        return Err("Attachment has no readable source".to_string());
    };

    let mut f = std::fs::File::open(path).map_err(|e| format!("Failed to open attachment: {}", e))?;
    f.seek(SeekFrom::Start(offset))
        .map_err(|e| format!("Failed to seek attachment: {}", e))?;
    let mut buf = vec![0u8; length];
    let n = f
        .read(&mut buf)
        .map_err(|e| format!("Failed to read attachment chunk: {}", e))?;
    buf.truncate(n);
    Ok(buf)
}

#[tauri::command]
fn list_shared_attachments() -> Result<Vec<SharedAttachmentItem>, String> {
    let account_id = require_session()?;
    let base = account_attachment_dir(&account_id)?;
    let index = with_attachment_index_lock(|| load_attachment_index(&base));
    let mut out: Vec<SharedAttachmentItem> = index
        .records
        .values()
        .filter(|rec| rec.shared)
        .map(|rec| {
            let file_exists = if let Some(cache_name) = &rec.cached_file_name {
                base.join("cache").join(cache_name).exists()
            } else if let Some(src) = &rec.source_path {
                PathBuf::from(src).exists()
            } else {
                false
            };
            let can_share_now = rec.status == "ready" && file_exists && !rec.sha256.is_empty();
            {
                let file_path = if let Some(cache_name) = &rec.cached_file_name {
                    base.join("cache").join(cache_name).to_string_lossy().to_string()
                } else if let Some(src) = &rec.source_path {
                    src.clone()
                } else {
                    String::new()
                };
                let file_path = if file_path.is_empty() { None } else { Some(file_path) };
                SharedAttachmentItem {
                    attachment_id: rec.attachment_id.clone(),
                    sha256: rec.sha256.clone(),
                    file_name: rec.file_name.clone(),
                    extension: rec.extension.clone(),
                    size_bytes: rec.size_bytes,
                    storage_mode: match rec.storage_mode {
                        AttachmentStorageMode::CurrentPath => "current_path".to_string(),
                        AttachmentStorageMode::ProgramCopy => "program_copy".to_string(),
                    },
                    source_path: rec.source_path.clone(),
                    file_path,
                    thumbnail_path: rec.thumbnail_path.clone().filter(|p| PathBuf::from(p).exists()),
                    created_at: rec.created_at.clone(),
                    can_share_now,
                }
            }
        })
        .collect();
    out.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    Ok(out)
}

#[tauri::command]
fn unshare_attachment(attachment_id: String) -> Result<bool, String> {
    let account_id = require_session()?;
    let base = account_attachment_dir(&account_id)?;
    with_attachment_index_lock(|| -> Result<bool, String> {
        let mut index = load_attachment_index(&base);
        let Some(rec) = index.records.get_mut(&attachment_id) else {
            return Ok(false);
        };
        rec.shared = false;
        save_attachment_index(&base, &index)?;
        Ok(true)
    })
}

#[tauri::command]
fn share_attachment_again(attachment_id: String, new_path: Option<String>) -> Result<bool, String> {
    let account_id = require_session()?;
    let base = account_attachment_dir(&account_id)?;
    with_attachment_index_lock(|| -> Result<bool, String> {
        let mut index = load_attachment_index(&base);
        let Some(rec) = index.records.get_mut(&attachment_id) else {
            return Ok(false);
        };
        if rec.shared {
            return Ok(true);
        }
        let file_exists = if let Some(cache_name) = &rec.cached_file_name {
            base.join("cache").join(cache_name).exists()
        } else if let Some(src) = &rec.source_path {
            PathBuf::from(src).exists()
        } else {
            false
        };
        if !file_exists {
            if let Some(ref path) = new_path {
                let source = PathBuf::from(path.trim());
                if !source.exists() {
                    return Err("Selected file not found".to_string());
                }
                let meta = std::fs::metadata(&source).map_err(|e| format!("Failed to read file: {}", e))?;
                if !meta.is_file() {
                    return Err("Selected path is not a file".to_string());
                }
                if meta.len() != rec.size_bytes {
                    return Err("File size does not match original; must be the same file".to_string());
                }
                if !rec.sha256.is_empty() {
                    if let Ok(actual_sha) = sha256_file_streaming(&source) {
                        if actual_sha != rec.sha256 {
                            return Err("File content does not match original; must be the same file".to_string());
                        }
                    }
                }
                rec.source_path = Some(source.to_string_lossy().to_string());
                rec.cached_file_name = None;
                rec.storage_mode = AttachmentStorageMode::CurrentPath;
            } else {
                return Err("File no longer exists at original path".to_string());
            }
        }
        rec.shared = true;
        save_attachment_index(&base, &index)?;
        Ok(true)
    })
}

#[tauri::command]
fn save_downloaded_attachment(
    file_name: String,
    bytes: Vec<u8>,
    _sha256: Option<String>,
    target_dir: Option<String>,
) -> Result<String, String> {
    let mut safe_name = file_name.trim().to_string();
    if safe_name.is_empty() {
        safe_name = "download.bin".to_string();
    }

    let downloads_dir = resolve_downloads_dir(target_dir)?;
    let target = resolve_download_target(&downloads_dir, &safe_name);
    std::fs::write(&target, bytes).map_err(|e| format!("Failed to save downloaded attachment: {}", e))?;
    Ok(target.to_string_lossy().to_string())
}

#[tauri::command]
fn begin_download_stream(
    request_id: String,
    file_name: String,
    _sha256: Option<String>,
    target_dir: Option<String>,
) -> Result<String, String> {
    let rid = request_id.trim().to_string();
    if rid.is_empty() {
        return Err("request_id is empty".to_string());
    }
    let safe_name = file_name.trim().to_string();
    let downloads_dir = resolve_downloads_dir(target_dir)?;
    let target_path = resolve_download_target(&downloads_dir, &safe_name);
    let temp_name = format!(
        "{}.part",
        target_path
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("download.bin")
    );
    let temp_path = target_path.with_file_name(temp_name);

    let file = std::fs::OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(true)
        .open(&temp_path)
        .map_err(|e| format!("Failed to create temp download file: {}", e))?;

    let mut map = download_streams().lock().map_err(|_| "Download stream lock poisoned".to_string())?;
    // If an old one exists (e.g. retry), overwrite it.
    map.insert(
        rid.clone(),
        DownloadStreamState {
            temp_path,
            target_path,
            file,
        },
    );

    Ok(rid)
}

#[tauri::command]
fn write_download_stream_chunk(request_id: String, bytes: Vec<u8>) -> Result<(), String> {
    let rid = request_id.trim().to_string();
    if rid.is_empty() {
        return Err("request_id is empty".to_string());
    }
    let mut map = download_streams().lock().map_err(|_| "Download stream lock poisoned".to_string())?;
    let st = map
        .get_mut(&rid)
        .ok_or_else(|| "Download stream not found (begin_download_stream missing?)".to_string())?;
    st.file
        .write_all(&bytes)
        .map_err(|e| format!("Failed to write download chunk: {}", e))?;
    Ok(())
}

#[tauri::command]
fn finish_download_stream(request_id: String) -> Result<String, String> {
    let rid = request_id.trim().to_string();
    if rid.is_empty() {
        return Err("request_id is empty".to_string());
    }
    let mut map = download_streams().lock().map_err(|_| "Download stream lock poisoned".to_string())?;
    let st = map
        .remove(&rid)
        .ok_or_else(|| "Download stream not found".to_string())?;
    // Ensure data is flushed before rename.
    let _ = st.file.sync_all();
    std::fs::rename(&st.temp_path, &st.target_path)
        .map_err(|e| format!("Failed to finalize download file: {}", e))?;
    Ok(st.target_path.to_string_lossy().to_string())
}

#[tauri::command]
fn cancel_download_stream(request_id: String) -> Result<(), String> {
    let rid = request_id.trim().to_string();
    if rid.is_empty() {
        return Ok(());
    }
    let mut map = download_streams().lock().map_err(|_| "Download stream lock poisoned".to_string())?;
    if let Some(st) = map.remove(&rid) {
        let _ = std::fs::remove_file(&st.temp_path);
    }
    Ok(())
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

fn encrypt_server_hint(symmetric_key: &[u8], server: &ServerInfo) -> Result<String, String> {
    if symmetric_key.len() != 32 {
        return Err("Invalid server symmetric key length".to_string());
    }
    let cipher = XChaCha20Poly1305::new(symmetric_key.into());
    let mut nonce_bytes = [0u8; 24];
    rand::thread_rng().fill_bytes(&mut nonce_bytes);
    let nonce = nonce_bytes.into();
    let plaintext = serde_json::to_vec(server).map_err(|e| format!("Failed to serialize server: {}", e))?;
    let ciphertext = cipher.encrypt(&nonce, plaintext.as_ref()).map_err(|_| "Server hint encryption failed".to_string())?;
    let mut out = nonce_bytes.to_vec();
    out.extend(ciphertext);
    Ok(base64::encode(&out))
}

fn decrypt_server_hint(symmetric_key: &[u8], encrypted_state_b64: &str) -> Result<ServerInfo, String> {
    if symmetric_key.len() != 32 {
        return Err("Invalid server symmetric key length".to_string());
    }
    let cipher = XChaCha20Poly1305::new(symmetric_key.into());
    let data = base64::decode(encrypted_state_b64).map_err(|e| format!("Server hint base64 decode failed: {}", e))?;
    if data.len() < 24 {
        return Err("Server hint ciphertext too short".to_string());
    }
    let mut nonce_bytes = [0u8; 24];
    nonce_bytes.copy_from_slice(&data[..24]);
    let nonce = nonce_bytes.into();
    let ciphertext = &data[24..];
    let plaintext = cipher.decrypt(&nonce, ciphertext).map_err(|_| "Server hint decryption failed".to_string())?;
    serde_json::from_slice::<ServerInfo>(&plaintext).map_err(|e| format!("Server hint JSON parse failed: {}", e))
}

fn merge_server_infos(mut base: ServerInfo, other: ServerInfo) -> ServerInfo {
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

    // Chats: union by id
    let mut seen_chats = std::collections::HashSet::<String>::new();
    let mut merged_chats = Vec::new();
    for r in base.chats.into_iter() {
        if seen_chats.insert(r.id.clone()) {
            merged_chats.push(r);
        }
    }
    for r in other.chats.into_iter() {
        if seen_chats.insert(r.id.clone()) {
            merged_chats.push(r);
        }
    }
    base.chats = merged_chats;

    // Invite state: prefer any active value
    if base.active_invite_uri.is_none() {
        base.active_invite_uri = other.active_invite_uri;
    }
    if base.active_invite_expires_at.is_none() {
        base.active_invite_expires_at = other.active_invite_expires_at;
    }

    base
}

fn normalize_beacon_to_http(url: &str) -> Result<String, String> {
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
fn export_identity_for_account(account_id: String) -> Result<Vec<u8>, String> {
    // NO GUARD: Can export any account's identity (for backup before deletion)
    let manager = IdentityManager::for_account(&account_id)
        .map_err(|e| format!("Failed to initialize identity manager: {}", e))?;
    manager.export_identity()
        .map_err(|e| format!("Failed to export identity: {}", e))
}

#[tauri::command]
fn export_full_identity_for_account(
    account_id: String,
    profile_json: Option<serde_json::Value>,
) -> Result<Vec<u8>, String> {
    // NO GUARD: Can export any account's full identity (for backup before deletion)
    let identity_manager = IdentityManager::for_account(&account_id)
        .map_err(|e| format!("Failed to initialize identity manager: {}", e))?;

    // Load all servers for this specific account
    let server_manager = ServerManager::for_account(&account_id)
        .map_err(|e| format!("Failed to initialize server manager for account {}: {}", account_id, e))?;
    
    let servers = server_manager.load_all_servers()
        .map_err(|e| format!("Failed to load servers: {}", e))?;

    // Export only essential cryptographic keys (rooms/members come from signaling server)
    let mut server_data: Vec<serde_json::Value> = Vec::new();
    for server in &servers {
        if let Some(symmetric_key) = server.get_symmetric_key() {
            let signing_pubkey = server.signing_pubkey.clone();
            let invite_uri = server.invite_uri.clone();
            let invite_code = server.invite_code.clone();
            
            let mut server_export = serde_json::json!({
                "signing_pubkey": signing_pubkey,
                "symmetric_key_b64": base64::encode(&symmetric_key),
                "invite_uri": invite_uri,
            });
            
            if let Some(signing_secret) = server.get_signing_secret() {
                server_export["signing_secret_b64"] = serde_json::Value::String(base64::encode(&signing_secret));
            }
            if !invite_code.is_empty() {
                server_export["invite_code"] = serde_json::Value::String(invite_code);
            }
            server_data.push(server_export);
        } else {
            eprintln!("Warning: Server {} has no symmetric key, skipping export", server.id);
        }
    }

    // Get signaling server URL and friends from account
    let account_manager = AccountManager::new()
        .map_err(|e| format!("Failed to access account manager: {}", e))?;
    let account_info = account_manager.get_account_info(&account_id)
        .map_err(|e| format!("Failed to get account info: {}", e))?
        .unwrap_or_else(|| AccountInfo {
            account_id: account_id.clone(),
            display_name: String::new(),
            created_at: String::new(),
            signaling_server_url: None,
        });
    let signaling_server_url = account_info.signaling_server_url;
    let friends = account_manager.load_friends(&account_id).unwrap_or_default();
    let known_profiles_map = account_manager.load_known_profiles(&account_id).unwrap_or_default();
    let known_profiles_for_export: std::collections::HashMap<String, KnownProfileForExport> = known_profiles_map.iter()
        .map(|(k, v)| (k.clone(), KnownProfileForExport::from(v)))
        .collect();
    let known_profiles = serde_json::to_value(&known_profiles_for_export).ok();
    // Build known_server_names from current server list so restore shows last-known names when offline
    let known_server_names: std::collections::HashMap<String, String> = servers.iter()
        .filter(|s| !s.name.is_empty())
        .map(|s| (s.signing_pubkey.clone(), s.name.clone()))
        .collect();
    let known_server_names = serde_json::to_value(&known_server_names).ok();

    identity_manager.export_full_identity(profile_json, server_data, signaling_server_url, friends, known_profiles, known_server_names)
        .map_err(|e| format!("Failed to export full identity: {}", e))
}

#[tauri::command]
fn export_full_identity(profile_json: Option<serde_json::Value>) -> Result<Vec<u8>, String> {
    // GUARDED: Requires active session
    require_session()?;
    
    let identity_manager = IdentityManager::new()
        .map_err(|e| format!("Failed to initialize identity manager: {}", e))?;

    // Load all servers for current account
    let server_manager = ServerManager::new()
        .map_err(|e| format!("Failed to initialize server manager: {}", e))?;
    
    let servers = server_manager.load_all_servers()
        .map_err(|e| format!("Failed to load servers: {}", e))?;

    // Export only essential cryptographic keys (rooms/members come from signaling server)
    let mut server_data: Vec<serde_json::Value> = Vec::new();
    for server in &servers {
        if let Some(symmetric_key) = server.get_symmetric_key() {
            let signing_pubkey = server.signing_pubkey.clone();
            let invite_uri = server.invite_uri.clone();
            let invite_code = server.invite_code.clone();
            
            let mut server_export = serde_json::json!({
                "signing_pubkey": signing_pubkey,
                "symmetric_key_b64": base64::encode(&symmetric_key),
                "invite_uri": invite_uri,
            });
            
            if let Some(signing_secret) = server.get_signing_secret() {
                server_export["signing_secret_b64"] = serde_json::Value::String(base64::encode(&signing_secret));
            }
            if !invite_code.is_empty() {
                server_export["invite_code"] = serde_json::Value::String(invite_code);
            }
            server_data.push(server_export);
        } else {
            eprintln!("Warning: Server {} has no symmetric key, skipping export", server.id);
        }
    }

    // Get signaling server URL and friends from current account
    let account_manager = AccountManager::new()
        .map_err(|e| format!("Failed to access account manager: {}", e))?;
    let current_account_id = account_manager.get_current_account_id()
        .map_err(|e| format!("Failed to get current account: {}", e))?
        .ok_or_else(|| "No active session".to_string())?;
    let account_info = account_manager.get_account_info(&current_account_id)
        .map_err(|e| format!("Failed to get account info: {}", e))?
        .unwrap_or_else(|| AccountInfo {
            account_id: current_account_id.clone(),
            display_name: String::new(),
            created_at: String::new(),
            signaling_server_url: None,
        });
    let signaling_server_url = account_info.signaling_server_url;
    let friends = account_manager.load_friends(&current_account_id).unwrap_or_default();
    let known_profiles_map = account_manager.load_known_profiles(&current_account_id).unwrap_or_default();
    let known_profiles_for_export: std::collections::HashMap<String, KnownProfileForExport> = known_profiles_map.iter()
        .map(|(k, v)| (k.clone(), KnownProfileForExport::from(v)))
        .collect();
    let known_profiles = serde_json::to_value(&known_profiles_for_export).ok();
    let known_server_names: std::collections::HashMap<String, String> = servers.iter()
        .filter(|s| !s.name.is_empty())
        .map(|s| (s.signing_pubkey.clone(), s.name.clone()))
        .collect();
    let known_server_names = serde_json::to_value(&known_server_names).ok();

    identity_manager.export_full_identity(profile_json, server_data, signaling_server_url, friends, known_profiles, known_server_names)
        .map_err(|e| format!("Failed to export full identity: {}", e))
}

#[tauri::command]
fn export_full_identity_debug(profile_json: Option<serde_json::Value>) -> Result<String, String> {
    // GUARDED: Requires active session
    require_session()?;
    
    let identity_manager = IdentityManager::new()
        .map_err(|e| format!("Failed to initialize identity manager: {}", e))?;

    // Load all servers for current account
    let server_manager = ServerManager::new()
        .map_err(|e| format!("Failed to initialize server manager: {}", e))?;
    
    let servers = server_manager.load_all_servers()
        .map_err(|e| format!("Failed to load servers: {}", e))?;

    // Export only essential cryptographic keys (rooms/members come from signaling server)
    let mut server_data: Vec<serde_json::Value> = Vec::new();
    for server in servers {
        if let Some(symmetric_key) = server.get_symmetric_key() {
            let signing_pubkey = server.signing_pubkey.clone();
            let invite_uri = server.invite_uri.clone();
            let invite_code = server.invite_code.clone();
            
            let mut server_export = serde_json::json!({
                "signing_pubkey": signing_pubkey,
                "symmetric_key_b64": base64::encode(&symmetric_key),
                "invite_uri": invite_uri,
            });
            
            if let Some(signing_secret) = server.get_signing_secret() {
                server_export["signing_secret_b64"] = serde_json::Value::String(base64::encode(&signing_secret));
            }
            if !invite_code.is_empty() {
                server_export["invite_code"] = serde_json::Value::String(invite_code);
            }
            server_data.push(server_export);
        } else {
            eprintln!("Warning: Server {} has no symmetric key, skipping export", server.id);
        }
    }

    let identity = identity_manager.load_identity()
        .map_err(|e| format!("Failed to load identity: {}", e))?;

    // Get signaling server URL from current account
    let account_manager = AccountManager::new()
        .map_err(|e| format!("Failed to access account manager: {}", e))?;
    let current_account_id = account_manager.get_current_account_id()
        .map_err(|e| format!("Failed to get current account: {}", e))?
        .ok_or_else(|| "No active session".to_string())?;
    let account_info = account_manager.get_account_info(&current_account_id)
        .map_err(|e| format!("Failed to get account info: {}", e))?
        .unwrap_or_else(|| AccountInfo {
            account_id: current_account_id,
            display_name: String::new(),
            created_at: String::new(),
            signaling_server_url: None,
        });
    let signaling_server_url = account_info.signaling_server_url;

    #[derive(Serialize)]
    struct DebugExport {
        version: u8,
        identity: UserIdentity,
        profile: Option<serde_json::Value>,
        servers: Vec<serde_json::Value>,
        signaling_server_url: Option<String>,
    }

    let debug_export = DebugExport {
        version: 1,
        identity,
        profile: profile_json,
        servers: server_data,
        signaling_server_url,
    };

    serde_json::to_string_pretty(&debug_export)
        .map_err(|e| format!("Failed to serialize debug export: {}", e))
}

#[derive(Serialize)]
struct ImportResult {
    identity: UserIdentity,
    profile_json: Option<serde_json::Value>,
}

#[tauri::command]
fn import_identity(data: Vec<u8>) -> Result<ImportResult, String> {
    // NO GUARD: Bootstrap command - works without session for initial setup
    
    // Import .key format
    let (identity, profile_json, server_data, signaling_server_url, friends, known_profiles, known_server_names) = IdentityManager::import_key_format_static(&data)
        .map_err(|e| format!("Failed to import .key file: {}", e))?;
    
    // Create account container if it doesn't exist
    let account_manager = AccountManager::new()
        .map_err(|e| format!("Failed to access account manager: {}", e))?;

    let user_id = identity.user_id.clone();
    let display_name = identity.display_name.clone();

    if !account_manager.account_exists(&user_id) {
        account_manager.create_account(&user_id, &display_name)
            .map_err(|e| format!("Failed to create account: {}", e))?;
    }
    
    // Restore signaling server URL to account info if present in export
    if let Some(signaling_url) = &signaling_server_url {
        let mut account_info = account_manager.get_account_info(&user_id)
            .map_err(|e| format!("Failed to get account info: {}", e))?
            .unwrap_or_else(|| AccountInfo {
                account_id: user_id.clone(),
                display_name: display_name.clone(),
                created_at: chrono::Utc::now().to_rfc3339(),
            signaling_server_url: None,
        });
        account_info.signaling_server_url = signaling_server_url.clone();
        account_manager.save_account_info(&account_info)
            .map_err(|e| format!("Failed to save account info: {}", e))?;
    }

    // Set session explicitly (bootstrap behavior)
    account_manager.set_session(&user_id)
        .map_err(|e| format!("Failed to set session: {}", e))?;

    // Save identity with this device's key
    let identity_manager = IdentityManager::for_account(&user_id)
        .map_err(|e| format!("Failed to initialize identity manager: {}", e))?;
    identity_manager.save_identity(&identity)
        .map_err(|e| format!("Failed to save identity: {}", e))?;

    // Restore servers from exported data
    // IMPORTANT: ServerManager must be created AFTER session is set to use correct account directory
    let server_count = server_data.len();
    if !server_data.is_empty() {
        // Verify session is set before creating ServerManager
        let current_session = account_manager.get_session()
            .map_err(|e| format!("Failed to verify session: {}", e))?;
        if current_session.current_account_id.as_ref() != Some(&user_id) {
            return Err(format!("Session mismatch: expected {}, got {:?}", 
                user_id, current_session.current_account_id));
        }
        
        let server_manager = ServerManager::new()
            .map_err(|e| format!("Failed to initialize server manager: {}", e))?;
        
        for server_json in server_data {
            // Get essential keys from export (rooms/members will come from signaling server)
            let signing_pubkey: String = server_json.get("signing_pubkey")
                .and_then(|v| v.as_str())
                .ok_or_else(|| "Missing signing_pubkey in export".to_string())?
                .to_string();
            
            let symmetric_key_b64: String = server_json.get("symmetric_key_b64")
                .and_then(|v| v.as_str())
                .ok_or_else(|| format!("Missing symmetric_key_b64 for server {}", signing_pubkey))?
                .to_string();
            let symmetric_key = base64::decode(&symmetric_key_b64)
                .map_err(|e| format!("Invalid symmetric_key_b64: {}", e))?;
            
            let signing_secret_b64: Option<String> = server_json.get("signing_secret_b64")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());
            let signing_secret = signing_secret_b64.and_then(|b64| base64::decode(&b64).ok());
            
            let invite_uri: String = server_json.get("invite_uri")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            
            let invite_code: String = server_json.get("invite_code")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            
            // Check if server with this signing_pubkey already exists
            match server_manager.find_server_id_by_signing_pubkey(&signing_pubkey)
                .map_err(|e| format!("Failed to check for existing server: {}", e))? {
                Some(_existing_id) => {
                    // House already exists locally - skip import
                    // The existing server already has the keys (encrypted with this device's key)
                    // No need to recreate or update anything
                    eprintln!("House with signing_pubkey {} already exists locally, skipping import", signing_pubkey);
                    continue;
                }
                None => {
                    // House doesn't exist - create it with minimal data
                    use uuid::Uuid;
                    let server_id = Uuid::new_v4().to_string();
                    
                    // Create minimal server JSON - NO default name, let signaling server provide it
                    let minimal_server_json = serde_json::json!({
                        "id": server_id,
                        "signing_pubkey": signing_pubkey,
                        "invite_uri": invite_uri,
                        "invite_code": invite_code,
                    });
                    
                    // Restore server using ServerManager method (will encrypt keys with device key)
                    // Rooms/members will be empty initially - signaling server will populate them
                    server_manager.restore_server_from_export(&minimal_server_json, symmetric_key, signing_secret)
                        .map_err(|e| format!("Failed to restore server {}: {}", signing_pubkey, e))?;
                }
            }
        }
        
        // Verify servers were restored
        let restored_servers = server_manager.load_all_servers()
            .map_err(|e| format!("Failed to verify restored servers: {}", e))?;
        if restored_servers.len() != server_count {
            return Err(format!("Server restoration incomplete: expected {} servers, got {}", 
                server_count, restored_servers.len()));
        }
    }

    // Restore friends list to account
    if !friends.is_empty() {
        account_manager.save_friends(&user_id, &friends)
            .map_err(|e| format!("Failed to save friends: {}", e))?;
    }

    // Restore known display names (so we never show "Unknown" for people we've seen)
    if let Some(ref val) = known_profiles {
        if let Ok(map) = serde_json::from_value::<std::collections::HashMap<String, account_manager::KnownProfile>>(val.clone()) {
            let _ = account_manager.save_known_profiles(&user_id, &map);
        }
    }

    // Restore known server names and apply to servers with empty names (so restore shows names without beacon)
    if let Some(ref val) = known_server_names {
        if let Ok(map) = serde_json::from_value::<std::collections::HashMap<String, String>>(val.clone()) {
            let _ = account_manager.save_known_server_names(&user_id, &map);
            if !map.is_empty() {
                let server_manager = ServerManager::new()
                    .map_err(|e| format!("Failed to initialize server manager: {}", e))?;
                for (signing_pubkey, name) in &map {
                    if name.is_empty() {
                        continue;
                    }
                    if let Ok(Some(server_id)) = server_manager.find_server_id_by_signing_pubkey(signing_pubkey) {
                        if let Ok(mut server) = server_manager.load_server(&server_id) {
                            if server.name.is_empty() {
                                server.name = name.clone();
                                let _ = server_manager.save_server(&server);
                            }
                        }
                    }
                }
            }
        }
    }
    
    // Return identity and profile data so frontend can restore profile to localStorage
    Ok(ImportResult {
        identity,
        profile_json,
    })
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
fn create_server(name: String, user_id: String, display_name: String) -> Result<ServerInfo, String> {
    // GUARDED: Requires active session
    require_session()?;
    
    let manager = ServerManager::new()
        .map_err(|e| format!("Failed to initialize server manager: {}", e))?;
    let server = manager.create_server(name, user_id, display_name)
        .map_err(|e| format!("Failed to create server: {}", e))?;
    Ok(server.to_info())
}

#[tauri::command]
fn list_servers() -> Result<Vec<ServerInfo>, String> {
    // GUARDED: Requires active session
    let account_id = require_session()?;
    
    let manager = ServerManager::new()
        .map_err(|e| format!("Failed to initialize server manager: {}", e))?;
    let mut servers = manager.load_all_servers()
        .map_err(|e| format!("Failed to load servers: {}", e))?;

    // Fill empty server names from cache (e.g. after restore without beacon); then refresh cache from current list
    let account_manager = AccountManager::new()
        .map_err(|e| format!("Failed to access account manager: {}", e))?;
    let known = account_manager.load_known_server_names(&account_id).unwrap_or_default();
    for s in &mut servers {
        if s.name.is_empty() {
            if let Some(name) = known.get(&s.signing_pubkey) {
                s.name = name.clone();
                let _ = manager.save_server(s);
            }
        }
    }
    let mut new_known = std::collections::HashMap::new();
    for s in &servers {
        if !s.name.is_empty() {
            new_known.insert(s.signing_pubkey.clone(), s.name.clone());
        }
    }
    let _ = account_manager.save_known_server_names(&account_id, &new_known);

    Ok(servers.into_iter().map(|s| s.to_info()).collect())
}

#[tauri::command]
fn load_server(server_id: String) -> Result<ServerInfo, String> {
    // GUARDED: Requires active session
    require_session()?;
    
    let manager = ServerManager::new()
        .map_err(|e| format!("Failed to initialize server manager: {}", e))?;
    let srv = manager.load_server(&server_id)
        .map_err(|e| format!("Failed to load server: {}", e))?;
    Ok(srv.to_info())
}

#[tauri::command]
fn encrypt_ephemeral_chat_message(server_id: String, plaintext: String) -> Result<String, String> {
    // GUARDED: Requires active session
    require_session()?;

    let manager = ServerManager::new()
        .map_err(|e| format!("Failed to initialize server manager: {}", e))?;
    let server = manager.load_server(&server_id)
        .map_err(|e| format!("Failed to load server: {}", e))?;

    let encrypted = server
        .encrypt(plaintext.as_bytes())
        .map_err(|e| format!("Failed to encrypt ephemeral message: {}", e))?;
    Ok(base64::encode(encrypted))
}

#[tauri::command]
fn encrypt_ephemeral_chat_message_by_signing_pubkey(signing_pubkey: String, plaintext: String) -> Result<String, String> {
    // GUARDED: Requires active session
    require_session()?;

    let manager = ServerManager::new()
        .map_err(|e| format!("Failed to initialize server manager: {}", e))?;
    let server_id = manager
        .find_server_id_by_signing_pubkey(&signing_pubkey)
        .map_err(|e| format!("Failed to resolve signing pubkey: {}", e))?
        .ok_or_else(|| "No local server for signing pubkey".to_string())?;
    let server = manager
        .load_server(&server_id)
        .map_err(|e| format!("Failed to load server: {}", e))?;

    let encrypted = server
        .encrypt(plaintext.as_bytes())
        .map_err(|e| format!("Failed to encrypt ephemeral message: {}", e))?;
    Ok(base64::encode(encrypted))
}

#[tauri::command]
fn decrypt_ephemeral_chat_message(server_id: String, encrypted_payload_b64: String) -> Result<String, String> {
    // GUARDED: Requires active session
    require_session()?;

    let manager = ServerManager::new()
        .map_err(|e| format!("Failed to initialize server manager: {}", e))?;
    let server = manager.load_server(&server_id)
        .map_err(|e| format!("Failed to load server: {}", e))?;

    let encrypted = base64::decode(encrypted_payload_b64)
        .map_err(|e| format!("Failed to decode encrypted payload: {}", e))?;
    let plaintext = server
        .decrypt(&encrypted)
        .map_err(|e| format!("Failed to decrypt ephemeral message: {}", e))?;
    String::from_utf8(plaintext).map_err(|e| format!("Invalid UTF-8 message payload: {}", e))
}

#[tauri::command]
fn decrypt_ephemeral_chat_message_by_signing_pubkey(signing_pubkey: String, encrypted_payload_b64: String) -> Result<String, String> {
    // GUARDED: Requires active session
    require_session()?;

    let manager = ServerManager::new()
        .map_err(|e| format!("Failed to initialize server manager: {}", e))?;
    let server_id = manager
        .find_server_id_by_signing_pubkey(&signing_pubkey)
        .map_err(|e| format!("Failed to resolve signing pubkey: {}", e))?
        .ok_or_else(|| "No local server for signing pubkey".to_string())?;
    let server = manager
        .load_server(&server_id)
        .map_err(|e| format!("Failed to load server: {}", e))?;

    let encrypted = base64::decode(encrypted_payload_b64)
        .map_err(|e| format!("Failed to decode encrypted payload: {}", e))?;
    let plaintext = server
        .decrypt(&encrypted)
        .map_err(|e| format!("Failed to decrypt ephemeral message: {}", e))?;
    String::from_utf8(plaintext).map_err(|e| format!("Invalid UTF-8 message payload: {}", e))
}

#[tauri::command]
fn delete_server(server_id: String) -> Result<(), String> {
    // GUARDED: Requires active session
    require_session()?;
    
    let manager = ServerManager::new()
        .map_err(|e| format!("Failed to initialize server manager: {}", e))?;
    manager.delete_server(&server_id)
        .map_err(|e| format!("Failed to delete server: {}", e))
}

#[tauri::command]
fn find_server_by_invite(invite_code: String) -> Result<Option<ServerInfo>, String> {
    // GUARDED: Requires active session
    require_session()?;
    
    let manager = ServerManager::new()
        .map_err(|e| format!("Failed to initialize server manager: {}", e))?;
    let server = manager.find_server_by_invite(&invite_code)
        .map_err(|e| format!("Failed to find server: {}", e))?;
    Ok(server.map(|h| h.to_info()))
}

#[tauri::command]
fn join_server(server_id: String, user_id: String, display_name: String) -> Result<ServerInfo, String> {
    // GUARDED: Requires active session
    require_session()?;
    
    let manager = ServerManager::new()
        .map_err(|e| format!("Failed to initialize server manager: {}", e))?;
    let server = manager.add_member_to_server(&server_id, user_id, display_name)
        .map_err(|e| format!("Failed to join server: {}", e))?;
    Ok(server.to_info())
}

#[tauri::command]
fn import_server_hint(server: ServerInfo) -> Result<(), String> {
    // GUARDED: Requires active session (joining a server is a usage action)
    require_session()?;

    let manager = ServerManager::new()
        .map_err(|e| format!("Failed to initialize server manager: {}", e))?;

    manager
        .import_server_hint(server)
        .map_err(|e| format!("Failed to import server hint: {}", e))
}

#[tauri::command]
async fn register_server_hint(beacon_url: String, hint: EncryptedServerHint) -> Result<(), String> {
    // Usage command (publishing state) - require session
    require_session()?;

    let base = normalize_beacon_to_http(&beacon_url)?;
    let url = format!(
        "{}/api/servers/{}/register",
        base,
        urlencoding::encode(&hint.signing_pubkey)
    );

    let client = reqwest::Client::new();
    let resp = client
        .post(url)
        .json(&hint)
        .send()
        .await
        .map_err(|e| format!("Failed to POST server hint: {}", e))?;

    if !resp.status().is_success() {
        return Err(format!("Failed to register server hint: HTTP {}", resp.status()));
    }

    Ok(())
}

#[tauri::command]
async fn get_server_hint(beacon_url: String, signing_pubkey: String) -> Result<Option<EncryptedServerHint>, String> {
    // Usage command (joining) - require session
    require_session()?;

    let base = normalize_beacon_to_http(&beacon_url)?;
    let url = format!(
        "{}/api/servers/{}/hint",
        base,
        urlencoding::encode(&signing_pubkey)
    );

    let client = reqwest::Client::new();
    let resp = client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("Failed to GET server hint: {}", e))?;

    if resp.status().as_u16() == 404 {
        return Ok(None);
    }

    if !resp.status().is_success() {
        return Err(format!("Failed to get server hint: HTTP {}", resp.status()));
    }

    let hint = resp
        .json::<EncryptedServerHint>()
        .await
        .map_err(|e| format!("Failed to parse server hint JSON: {}", e))?;

    Ok(Some(hint))
}

#[tauri::command]
async fn publish_server_hint_opaque(beacon_url: String, server_id: String) -> Result<(), String> {
    require_session()?;

    let manager = ServerManager::new()
        .map_err(|e| format!("Failed to initialize server manager: {}", e))?;

    let server = manager.load_server(&server_id)
        .map_err(|e| format!("Failed to load server: {}", e))?;

    let symmetric_key = server.get_symmetric_key()
        .ok_or_else(|| "Server missing symmetric key".to_string())?;

    let server_info = server.to_info();
    let encrypted_state = encrypt_server_hint(&symmetric_key, &server_info)?;

    let hint = EncryptedServerHint {
        signing_pubkey: server_info.signing_pubkey.clone(),
        encrypted_state,
        signature: "".to_string(),
        last_updated: chrono::Utc::now().to_rfc3339(),
    };

    register_server_hint(beacon_url, hint).await
}

#[tauri::command]
async fn publish_server_hint_member_left(beacon_url: String, server_id: String, user_id: String) -> Result<(), String> {
    require_session()?;

    let manager = ServerManager::new()
        .map_err(|e| format!("Failed to initialize server manager: {}", e))?;

    let server = manager.load_server(&server_id)
        .map_err(|e| format!("Failed to load server: {}", e))?;

    let symmetric_key = server.get_symmetric_key()
        .ok_or_else(|| "Server missing symmetric key".to_string())?;

    let mut server_info = server.to_info();
    server_info.members.retain(|m| m.user_id != user_id);

    let encrypted_state = encrypt_server_hint(&symmetric_key, &server_info)?;
    let hint = EncryptedServerHint {
        signing_pubkey: server_info.signing_pubkey.clone(),
        encrypted_state,
        signature: "".to_string(),
        last_updated: chrono::Utc::now().to_rfc3339(),
    };

    register_server_hint(beacon_url, hint).await
}

#[tauri::command]
async fn fetch_and_import_server_hint_opaque(beacon_url: String, signing_pubkey: String) -> Result<bool, String> {
    require_session()?;

    // Fetch encrypted hint from server
    let hint = match get_server_hint(beacon_url.clone(), signing_pubkey.clone()).await? {
        Some(h) => h,
        None => return Ok(false),
    };

    // Find local server + symmetric key by signing_pubkey
    let manager = ServerManager::new()
        .map_err(|e| format!("Failed to initialize server manager: {}", e))?;

    let Some(server_id) = manager.find_server_id_by_signing_pubkey(&signing_pubkey)
        .map_err(|e| format!("Failed to find local server: {}", e))? else {
        return Err("Cannot decrypt hint: server not present locally (join via invite first)".to_string());
    };

    let local_server = manager.load_server(&server_id)
        .map_err(|e| format!("Failed to load local server: {}", e))?;

    let Some(symmetric_key) = local_server.get_symmetric_key() else {
        // Server exists but has no key (e.g. created in a bad state). Can't decrypt hint; skip without error.
        return Ok(false);
    };

    let decrypted = decrypt_server_hint(&symmetric_key, &hint.encrypted_state)?;

    manager.import_server_hint(decrypted)
        .map_err(|e| format!("Failed to import decrypted hint: {}", e))?;

    Ok(true)
}

#[derive(serde::Deserialize)]
struct InviteResolveResponse {
    signing_pubkey: String,
}

#[tauri::command]
async fn resolve_invite_code(beacon_url: String, invite_code: String) -> Result<Option<String>, String> {
    // Usage command (joining) - require session
    require_session()?;

    let base = normalize_beacon_to_http(&beacon_url)?;
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
async fn create_temporary_invite(beacon_url: String, server_id: String, max_uses: u32) -> Result<String, String> {
    require_session()?;

    let manager = ServerManager::new()
        .map_err(|e| format!("Failed to initialize server manager: {}", e))?;

    // Load server with secrets (need symmetric key)
    let server = manager.load_server(&server_id)
        .map_err(|e| format!("Failed to load server: {}", e))?;

    // Generate a short human-shareable code (8 chars - easy to read over phone)
    const CHARSET: &[u8] = b"ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    let mut code = String::with_capacity(8);
    let mut bytes = [0u8; 8];
    rand::thread_rng().fill_bytes(&mut bytes);
    for b in bytes {
        code.push(CHARSET[(b as usize) % CHARSET.len()] as char);
    }

    let mut server_info = server.to_info();
    let symmetric_key = server.get_symmetric_key()
        .ok_or_else(|| "Server missing symmetric key".to_string())?;

    // Include active invite fields in the payload so new joiners see the current invite state immediately.
    // We treat the invite as "active until revoked"; this timestamp is just to allow UI hiding if it's very stale.
    let invite_uri = format!("cordia://{}@{}", code, beacon_url.trim());
    let expires_at = chrono::Utc::now() + chrono::Duration::days(30);
    server_info.active_invite_uri = Some(invite_uri.clone());
    server_info.active_invite_expires_at = Some(expires_at);

    let payload = InviteTokenPayload {
        server: server_info.clone(),
        server_symmetric_key_b64: base64::encode(&symmetric_key),
    };
    let encrypted_payload = encrypt_invite_payload(&code, &payload)?;

    // POST to signaling server
    let base = normalize_beacon_to_http(&beacon_url)?;
    let url = format!(
        "{}/api/servers/{}/invites",
        base,
        urlencoding::encode(&server_info.signing_pubkey)
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

    manager.set_active_invite(&server_id, Some(invite_uri.clone()), Some(expires_at))
        .map_err(|e| format!("Failed to store active invite: {}", e))?;

    // Propagate active invite to all members via encrypted server hint
    publish_server_hint_opaque(beacon_url.clone(), server_id.clone()).await?;

    Ok(invite_uri)
}

#[tauri::command]
async fn revoke_active_invite(beacon_url: String, server_id: String) -> Result<(), String> {
    require_session()?;

    let manager = ServerManager::new()
        .map_err(|e| format!("Failed to initialize server manager: {}", e))?;

    let server = manager.load_server(&server_id)
        .map_err(|e| format!("Failed to load server: {}", e))?;

    let code = server
        .active_invite_uri
        .as_ref()
        .and_then(|uri| uri.trim().strip_prefix("cordia://"))
        .and_then(|rest| rest.split('@').next())
        .map(|s| s.to_string());

    if let Some(code) = code {
        let base = normalize_beacon_to_http(&beacon_url)?;
        let url = format!("{}/api/invites/{}/revoke", base, urlencoding::encode(code.trim()));
        let client = reqwest::Client::new();
        let _ = client.post(url).send().await;
    }

    manager
        .set_active_invite(&server_id, None, None)
        .map_err(|e| format!("Failed to clear active invite: {}", e))?;

    // Propagate revocation to all members
    publish_server_hint_opaque(beacon_url.clone(), server_id.clone()).await?;

    Ok(())
}

#[tauri::command]
async fn redeem_temporary_invite(beacon_url: String, code: String, user_id: String, display_name: String) -> Result<ServerInfo, String> {
    require_session()?;

    let base = normalize_beacon_to_http(&beacon_url)?;
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
    let symmetric_key = base64::decode(&payload.server_symmetric_key_b64)
        .map_err(|e| format!("Invalid symmetric key b64: {}", e))?;

    let manager = ServerManager::new()
        .map_err(|e| format!("Failed to initialize server manager: {}", e))?;

    // IMPORTANT: The invite payload's server snapshot can be stale (it was created when the invite was generated).
    // Now that we have the symmetric key, pull+decrypt the latest server hint and merge memberships/rooms so we
    // don't overwrite the server's member list with "creator + me".
    let mut merged_server = payload.server.clone();
    if let Some(latest_hint) = get_server_hint(beacon_url.clone(), merged_server.signing_pubkey.clone()).await? {
        if let Ok(server_from_hint) = decrypt_server_hint(&symmetric_key, &latest_hint.encrypted_state) {
            merged_server = merge_server_infos(server_from_hint, merged_server);
        }
    }

    // Import merged server + symmetric key locally
    // Returns the actual server ID used (may differ from merged_server.id if server already existed)
    let actual_server_id = manager.import_server_invite(merged_server.clone(), symmetric_key)
        .map_err(|e| format!("Failed to import server from invite: {}", e))?;

    // Add member locally using the actual server ID
    let updated = manager.add_member_to_server(&actual_server_id, user_id, display_name)
        .map_err(|e| format!("Failed to join server: {}", e))?;

    // CRITICAL: Publish updated encrypted hint as part of redeem flow.
    // Otherwise, other clients (including the creator) may never learn about this membership change,
    // and later syncs can overwrite the joiner's local member list.
    publish_server_hint_opaque(beacon_url.clone(), actual_server_id).await?;

    Ok(updated.to_info())
}

#[tauri::command]
async fn check_beacon(url: Option<String>) -> Result<bool, String> {
    let server_url = url.unwrap_or_else(get_default_beacon_url);
    check_beacon_health(&server_url)
        .await
        .map_err(|e| format!("Beacon check failed: {}", e))
}

#[tauri::command]
fn get_default_beacon() -> String {
    get_default_beacon_url()
}

#[tauri::command]
async fn get_beacon_url() -> Result<String, String> {
    // GUARDED: Requires active session
    require_session()?;
    
    let account_manager = AccountManager::new()
        .map_err(|e| format!("Failed to access account manager: {}", e))?;
    let current_account_id = account_manager.get_current_account_id()
        .map_err(|e| format!("Failed to get current account: {}", e))?
        .ok_or_else(|| "No active session".to_string())?;
    
    let account_info = account_manager.get_account_info(&current_account_id)
        .map_err(|e| format!("Failed to get account info: {}", e))?
        .unwrap_or_else(|| AccountInfo {
            account_id: current_account_id,
            display_name: String::new(),
            created_at: String::new(),
            signaling_server_url: None,
        });
    
    Ok(account_info.signaling_server_url
        .unwrap_or_else(|| get_default_beacon_url()))
}

#[tauri::command]
async fn set_beacon_url(url: String) -> Result<(), String> {
    // GUARDED: Requires active session
    require_session()?;
    
    let account_manager = AccountManager::new()
        .map_err(|e| format!("Failed to access account manager: {}", e))?;
    let current_account_id = account_manager.get_current_account_id()
        .map_err(|e| format!("Failed to get current account: {}", e))?
        .ok_or_else(|| "No active session".to_string())?;
    
    let mut account_info = account_manager.get_account_info(&current_account_id)
        .map_err(|e| format!("Failed to get account info: {}", e))?
        .unwrap_or_else(|| AccountInfo {
            account_id: current_account_id.clone(),
            display_name: String::new(),
            created_at: chrono::Utc::now().to_rfc3339(),
            signaling_server_url: None,
        });
    
    // Only save if different from default (to avoid cluttering account info)
    let trimmed_url = url.trim().to_string();
    if trimmed_url == get_default_beacon_url() {
        account_info.signaling_server_url = None;
    } else {
        account_info.signaling_server_url = Some(trimmed_url);
    }
    
    account_manager.save_account_info(&account_info)
        .map_err(|e| format!("Failed to save account info: {}", e))?;
    
    Ok(())
}

/// Read text from the system clipboard (avoids webview permission prompt).
#[tauri::command]
fn read_clipboard_text() -> Result<String, String> {
    use arboard::Clipboard;
    let mut clipboard = Clipboard::new().map_err(|e| format!("Clipboard unavailable: {}", e))?;
    clipboard.get_text().map_err(|e| format!("Clipboard read failed: {}", e))
}

#[tauri::command]
fn open_path_in_file_explorer(path: String) -> Result<(), String> {
    let target = path.trim();
    if target.is_empty() {
        return Err("Path is empty".to_string());
    }
    let p = std::path::PathBuf::from(target);
    if !p.exists() {
        return Err("Path does not exist".to_string());
    }

    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer")
            .arg(target)
            .spawn()
            .map_err(|e| format!("Failed to open in explorer: {}", e))?;
        return Ok(());
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(target)
            .spawn()
            .map_err(|e| format!("Failed to open in Finder: {}", e))?;
        return Ok(());
    }
    #[cfg(target_os = "linux")]
    {
        std::process::Command::new("xdg-open")
            .arg(target)
            .spawn()
            .map_err(|e| format!("Failed to open in file manager: {}", e))?;
        return Ok(());
    }
    #[allow(unreachable_code)]
    Err("Unsupported OS".to_string())
}

#[tauri::command]
fn path_exists(path: String) -> bool {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return false;
    }
    PathBuf::from(trimmed).exists()
}

#[cfg(windows)]
#[tauri::command]
fn register_key_file_association_command() -> Result<(), String> {
    #[cfg(all(windows, feature = "windows-registry"))]
    {
        use file_association::register_key_file_association;
        register_key_file_association()
            .map_err(|e| format!("Failed to register .key file association: {}", e))
    }
    #[cfg(not(all(windows, feature = "windows-registry")))]
    {
        Err("File association registration is only supported on Windows with windows-registry feature".to_string())
    }
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

#[tauri::command]
fn delete_account(account_id: String) -> Result<(), String> {
    // NO GUARD: Can delete any account (user must be on account select screen)
    let manager = AccountManager::new()
        .map_err(|e| format!("Failed to create account manager: {}", e))?;
    manager.delete_account(&account_id)
        .map_err(|e| format!("Failed to delete account: {}", e))
}

#[tauri::command]
fn list_friends() -> Result<Vec<String>, String> {
    let account_id = require_session()?;
    let manager = AccountManager::new()
        .map_err(|e| format!("Failed to access account manager: {}", e))?;
    manager.load_friends(&account_id)
        .map_err(|e| format!("Failed to load friends: {}", e))
}

#[tauri::command]
fn add_friend(user_id: String) -> Result<(), String> {
    let account_id = require_session()?;
    let manager = AccountManager::new()
        .map_err(|e| format!("Failed to access account manager: {}", e))?;
    let mut friends = manager.load_friends(&account_id)
        .map_err(|e| format!("Failed to load friends: {}", e))?;
    if !friends.contains(&user_id) {
        friends.push(user_id);
        manager.save_friends(&account_id, &friends)
            .map_err(|e| format!("Failed to save friends: {}", e))?;
    }
    Ok(())
}

#[tauri::command]
fn load_known_profiles() -> Result<serde_json::Value, String> {
    let account_id = require_session()?;
    let manager = AccountManager::new()
        .map_err(|e| format!("Failed to access account manager: {}", e))?;
    let map = manager.load_known_profiles(&account_id)
        .map_err(|e| format!("Failed to load known profiles: {}", e))?;
    serde_json::to_value(map).map_err(|e| format!("Failed to serialize known profiles: {}", e))
}

#[tauri::command]
fn save_known_profiles(profiles: std::collections::HashMap<String, KnownProfile>) -> Result<(), String> {
    let account_id = require_session()?;
    let manager = AccountManager::new()
        .map_err(|e| format!("Failed to access account manager: {}", e))?;
    manager.save_known_profiles(&account_id, &profiles)
        .map_err(|e| format!("Failed to save known profiles: {}", e))
}

#[tauri::command]
fn remove_friend(user_id: String) -> Result<(), String> {
    let account_id = require_session()?;
    let manager = AccountManager::new()
        .map_err(|e| format!("Failed to access account manager: {}", e))?;
    let mut friends = manager.load_friends(&account_id)
        .map_err(|e| format!("Failed to load friends: {}", e))?;
    friends.retain(|id| id != &user_id);
    manager.save_friends(&account_id, &friends)
        .map_err(|e| format!("Failed to save friends: {}", e))
}

/// Returns headers for friend API auth: request signed with identity Ed25519 key.
/// Envelope: method + "\n" + path + "\n" + timestamp + "\n" + sha256(body).hex().
/// No shared secret; server verifies signature with public key (mailbox-style).
#[tauri::command]
fn get_friend_auth_headers(
    method: String,
    path: String,
    body: Option<String>,
) -> Result<std::collections::HashMap<String, String>, String> {
    use ed25519_dalek::Signer;

    let _ = require_session()?;
    let manager = IdentityManager::new()
        .map_err(|e| format!("Identity manager: {}", e))?;
    let identity = manager.load_identity()
        .map_err(|e| format!("Load identity: {}", e))?;
    let private_key_hex = identity.private_key
        .as_ref()
        .ok_or("Identity has no private key. If you created this account before a recent update, create a new account to use friend requests and friend codes.")?;
    let private_key_bytes = hex::decode(private_key_hex)
        .map_err(|e| format!("Invalid private key hex: {}", e))?;
    let signing_key = ed25519_dalek::SigningKey::from_bytes(
        private_key_bytes.as_slice().try_into()
            .map_err(|_| "Invalid private key length")?,
    );

    let timestamp = chrono::Utc::now().timestamp();
    let body_hash = match body.as_deref().unwrap_or("") {
        "" => String::new(),
        b => {
            use sha2::Digest;
            let mut hasher = sha2::Sha256::new();
            hasher.update(b.as_bytes());
            hex::encode(hasher.finalize())
        }
    };
    let envelope = format!("{}\n{}\n{}\n{}",
        method.to_uppercase(),
        path.trim(),
        timestamp,
        body_hash,
    );
    let signature = signing_key.sign(envelope.as_bytes());

    let mut headers = std::collections::HashMap::new();
    headers.insert("X-User-Id".to_string(), identity.user_id);
    headers.insert("X-Timestamp".to_string(), timestamp.to_string());
    headers.insert("X-Public-Key".to_string(), identity.public_key.clone());
    headers.insert("X-Signature".to_string(), base64::encode(signature.to_bytes()));
    Ok(headers)
}

// === Native Audio Commands ===

#[tauri::command]
fn enumerate_audio_devices_native() -> Result<Vec<AudioDevice>, String> {
    enumerate_devices()
}

/// Bounded capacity for processed frames: ~30 ms. If JS doesn't drain in time, we drop (never block Rust).
const PROCESSED_FRAME_QUEUE_CAP: usize = 3;

#[tauri::command]
fn start_audio_capture(
    app: tauri::AppHandle,
    device_id: Option<String>,
) -> Result<(), String> {
    // Bounded channel: processing thread uses try_send; when full, frames are dropped (audio loss > latency).
    let (processed_tx, processed_rx) = std::sync::mpsc::sync_channel(PROCESSED_FRAME_QUEUE_CAP);
    let (level_tx, level_rx) = std::sync::mpsc::channel();

    start_capture(device_id, processed_tx, level_tx)?;

    let app_clone = app.clone();
    std::thread::spawn(move || {
        // Level updates: event-driven, no polling
        let app_level = app_clone.clone();
        std::thread::spawn(move || {
            loop {
                match level_rx.recv() {
                    Ok(level) => {
                        let _ = app_level.emit_all("cordia:audio-level", level);
                    }
                    Err(_) => break,
                }
            }
        });

        // Emitter: drain opportunistically, batch 2–3 frames to reduce IPC jitter. Never block Rust.
        const BATCH_SIZE: usize = 2;
        const RECV_TIMEOUT_MS: u64 = 25; // ~2.5 frames at 10 ms/frame; if nothing, emit what we have
        let timeout = std::time::Duration::from_millis(RECV_TIMEOUT_MS);
        let mut batch: Vec<f32> = Vec::with_capacity(480 * BATCH_SIZE);
        loop {
            batch.clear();
            let mut got_any = false;
            for _ in 0..BATCH_SIZE {
                match processed_rx.recv_timeout(timeout) {
                    Ok(frame) => {
                        batch.extend_from_slice(&frame);
                        got_any = true;
                    }
                    Err(std::sync::mpsc::RecvTimeoutError::Timeout) => break,
                    Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => return,
                }
            }
            if got_any && !batch.is_empty() {
                let frame_bytes: Vec<u8> = batch
                    .iter()
                    .flat_map(|f| f.to_le_bytes().to_vec())
                    .collect();
                let frame_b64 = base64::encode(&frame_bytes);
                let _ = app_clone.emit_all("cordia:audio-frame", frame_b64);
            }
        }
    });

    Ok(())
}

#[tauri::command]
fn stop_audio_capture() -> Result<(), String> {
    stop_capture();
    Ok(())
}

#[tauri::command]
fn set_audio_gain(gain: f32) -> Result<(), String> {
    let dsp = get_dsp();
    let mut dsp_guard = dsp.lock().map_err(|_| "Failed to lock DSP".to_string())?;
    dsp_guard.set_gain(gain);
    Ok(())
}

#[tauri::command]
fn set_audio_threshold(threshold: f32) -> Result<(), String> {
    let dsp = get_dsp();
    let mut dsp_guard = dsp.lock().map_err(|_| "Failed to lock DSP".to_string())?;
    dsp_guard.set_threshold(threshold);
    Ok(())
}

#[tauri::command]
fn set_audio_input_mode(mode: String) -> Result<(), String> {
    let dsp = get_dsp();
    let mut dsp_guard = dsp.lock().map_err(|_| "Failed to lock DSP".to_string())?;
    let input_mode = match mode.as_str() {
        "voice_activity" => InputMode::VoiceActivity,
        "push_to_talk" => InputMode::PushToTalk,
        _ => return Err(format!("Invalid input mode: {}", mode)),
    };
    dsp_guard.set_input_mode(input_mode);
    Ok(())
}

#[tauri::command]
fn set_ptt_key_pressed(pressed: bool) -> Result<(), String> {
    let dsp = get_dsp();
    let mut dsp_guard = dsp.lock().map_err(|_| "Failed to lock DSP".to_string())?;
    dsp_guard.set_ptt_pressed(pressed);
    Ok(())
}

#[tauri::command]
fn set_transmission_muted(muted: bool) -> Result<(), String> {
    let dsp = get_dsp();
    let mut dsp_guard = dsp.lock().map_err(|_| "Failed to lock DSP".to_string())?;
    dsp_guard.set_transmission_muted(muted);
    Ok(())
}

#[tauri::command]
fn get_audio_level() -> Result<f32, String> {
    let dsp = get_dsp();
    let dsp_guard = dsp.lock().map_err(|_| "Failed to lock DSP".to_string())?;
    Ok(dsp_guard.get_level())
}

/// Drop/underrun stats for dev overlay or debug. Resets on each start_audio_capture.
#[tauri::command]
fn get_audio_drop_stats_command() -> AudioDropStats {
    audio_capture::get_audio_drop_stats()
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
            export_identity_for_account,
            export_full_identity,
            export_full_identity_for_account,
            export_full_identity_debug,
            import_identity,
            // Account management commands
            list_accounts,
            get_account_info,
            get_current_session,
            switch_account,
            logout_account,
            get_current_account_id,
            delete_account,
            list_friends,
            add_friend,
            remove_friend,
            load_known_profiles,
            save_known_profiles,
            get_friend_auth_headers,
            register_key_file_association_command,
            // Audio settings commands
            load_audio_settings,
            save_audio_settings,
            // Native audio commands
            enumerate_audio_devices_native,
            start_audio_capture,
            stop_audio_capture,
            set_audio_gain,
            set_audio_threshold,
            set_audio_input_mode,
            set_ptt_key_pressed,
            set_transmission_muted,
            get_audio_level,
            get_audio_drop_stats_command,
            // House commands
            create_server,
            list_servers,
            load_server,
            encrypt_ephemeral_chat_message,
            encrypt_ephemeral_chat_message_by_signing_pubkey,
            decrypt_ephemeral_chat_message,
            decrypt_ephemeral_chat_message_by_signing_pubkey,
            get_file_metadata,
            compute_file_sha256,
            register_attachment_from_path,
            get_attachment_record,
            read_attachment_bytes,
            read_attachment_chunk,
            list_shared_attachments,
            unshare_attachment,
            share_attachment_again,
            save_downloaded_attachment,
            begin_download_stream,
            write_download_stream_chunk,
            finish_download_stream,
            cancel_download_stream,
            delete_server,
            find_server_by_invite,
            join_server,
            import_server_hint,
            register_server_hint,
            get_server_hint,
            resolve_invite_code,
            publish_server_hint_opaque,
            publish_server_hint_member_left,
            fetch_and_import_server_hint_opaque,
            create_temporary_invite,
            revoke_active_invite,
            redeem_temporary_invite,
            // Beacon commands
            check_beacon,
            get_default_beacon,
            get_beacon_url,
            set_beacon_url,
            read_clipboard_text,
            open_path_in_file_explorer,
            path_exists
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

