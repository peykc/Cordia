use sha2::{Digest, Sha256};
use std::io::{Read, Seek, SeekFrom};
use std::path::PathBuf;

pub fn sha256_file(path: &PathBuf) -> Result<String, String> {
    let bytes = std::fs::read(path).map_err(|e| format!("Failed to read file for hashing: {}", e))?;
    let mut hasher = Sha256::new();
    hasher.update(&bytes);
    Ok(hex::encode(hasher.finalize()))
}

pub fn sha256_file_streaming(path: &PathBuf) -> Result<String, String> {
    sha256_file_streaming_with_progress(path, |_| {})
}

pub fn sha256_file_streaming_with_progress<F>(path: &PathBuf, mut on_progress: F) -> Result<String, String>
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

pub fn default_piece_size_for_bytes(size_bytes: u64) -> u32 {
    if size_bytes >= 2 * 1024 * 1024 * 1024 {
        1024 * 1024
    } else if size_bytes >= 256 * 1024 * 1024 {
        512 * 1024
    } else {
        256 * 1024
    }
}

pub fn compute_piece_hashes_with_progress<F>(path: &PathBuf, piece_size: u32, mut on_progress: F) -> Result<(u32, Vec<String>), String>
where
    F: FnMut(u8),
{
    let total = std::fs::metadata(path).map_err(|e| format!("Failed to read file metadata: {}", e))?.len();
    let mut f = std::fs::File::open(path).map_err(|e| format!("Failed to open file for piece hashing: {}", e))?;
    let mut buf = vec![0u8; piece_size as usize];
    let mut out: Vec<String> = Vec::new();
    let mut read_total: u64 = 0;
    let mut last_pct: u8 = 0;
    loop {
        let n = f
            .read(&mut buf)
            .map_err(|e| format!("Failed to read file for piece hashing: {}", e))?;
        if n == 0 {
            break;
        }
        let mut hasher = Sha256::new();
        hasher.update(&buf[..n]);
        out.push(hex::encode(hasher.finalize()));
        read_total += n as u64;
        if total > 0 {
            let pct = ((read_total * 100) / total).min(100) as u8;
            if pct >= last_pct + 2 || pct == 100 {
                last_pct = pct;
                on_progress(pct);
            }
        }
    }
    Ok((out.len() as u32, out))
}
