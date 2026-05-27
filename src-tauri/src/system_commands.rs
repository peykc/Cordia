/// Read text from the system clipboard (avoids webview permission prompt).
#[tauri::command]
pub fn read_clipboard_text() -> Result<String, String> {
    use arboard::Clipboard;
    let mut clipboard = Clipboard::new().map_err(|e| format!("Clipboard unavailable: {}", e))?;
    clipboard.get_text().map_err(|e| format!("Clipboard read failed: {}", e))
}

#[tauri::command]
pub fn open_path_in_file_explorer(path: String) -> Result<(), String> {
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
pub fn path_exists(path: String) -> bool {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return false;
    }
    std::path::PathBuf::from(trimmed).exists()
}
