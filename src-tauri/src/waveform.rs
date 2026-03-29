//! Waveform peaks for chat music attachments — computed once during attachment prep (FFmpeg decode),
//! stored on `AttachmentRecord`, and shipped in message metadata so WebView never decodes full files per row.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::io::Read;
use std::path::Path;
use std::process::{Command, Stdio};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

/// Must match `WAVE_BARS` in `ChatMusicAttachmentCard.tsx`.
pub const WAVE_BARS: usize = 100;

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct WaveformPeaks {
    pub top: Vec<f32>,
    pub bottom: Vec<f32>,
}

struct BarAcc {
    top_sum_sq: f64,
    top_n: u32,
    bottom_sum_sq: f64,
    bottom_n: u32,
}

impl Default for BarAcc {
    fn default() -> Self {
        Self {
            top_sum_sq: 0.0,
            top_n: 0,
            bottom_sum_sq: 0.0,
            bottom_n: 0,
        }
    }
}

/// Fewer samples/sec as duration grows — same time-based bar buckets, much less FFmpeg work.
fn sample_rate_hz_for_duration(duration_secs: f64) -> u64 {
    if duration_secs >= 40.0 * 60.0 {
        2_500
    } else if duration_secs >= 20.0 * 60.0 {
        5_000
    } else if duration_secs >= 10.0 * 60.0 {
        11_025
    } else {
        44_100
    }
}

fn ffprobe_duration(path: &Path) -> Option<f64> {
    let bin = if cfg!(target_os = "windows") {
        "ffprobe.exe"
    } else {
        "ffprobe"
    };
    let mut cmd = Command::new(bin);
    cmd.args([
        "-v",
        "error",
        "-show_entries",
        "format=duration",
        "-of",
        "default=noprint_wrappers=1:nokey=1",
    ])
    .arg(path)
    .stdout(Stdio::piped())
    .stderr(Stdio::null());
    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let out = cmd.output().ok()?;
    if !out.status.success() {
        return None;
    }
    let s = String::from_utf8_lossy(&out.stdout);
    s.trim().parse().ok()
}

fn normalize_to_band(raw: &[f64], min_h: f64, max_h: f64) -> Vec<f32> {
    let mx = raw.iter().cloned().fold(0.0_f64, f64::max).max(1e-12);
    raw.iter()
        .map(|v| (min_h + (v / mx) * (max_h - min_h)) as f32)
        .collect()
}

/// Decode mono f32 @ 44.1kHz via FFmpeg, bucket RMS into `bars` segments (matches TS `extractSplitPeaksFromChannelData`).
pub fn compute_waveform_peaks(path: &Path, bars: usize) -> Option<WaveformPeaks> {
    compute_waveform_peaks_with_progress(path, bars, |_| {})
}

/// `on_progress` receives 0–100 of samples decoded (long files: this is most of prep time after SHA/piece hashing).
pub fn compute_waveform_peaks_with_progress<F>(path: &Path, bars: usize, mut on_progress: F) -> Option<WaveformPeaks>
where
    F: FnMut(u8),
{
    if bars == 0 {
        return None;
    }
    let duration = ffprobe_duration(path)?;
    if !duration.is_finite() || duration <= 0.0 {
        return None;
    }
    let rate = sample_rate_hz_for_duration(duration);
    let total_samples = ((duration * rate as f64) as u64).max(bars as u64);
    let block = (total_samples / bars as u64).max(1);

    let bin = if cfg!(target_os = "windows") {
        "ffmpeg.exe"
    } else {
        "ffmpeg"
    };
    let mut cmd = Command::new(bin);
    cmd.args([
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        path.to_str()?,
        "-f",
        "f32le",
        "-ac",
        "1",
        "-ar",
        &rate.to_string(),
        "-",
    ])
    .stdout(Stdio::piped())
    .stderr(Stdio::null());
    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let mut child = cmd.spawn().ok()?;
    let mut stdout = child.stdout.take()?;

    let mut acc: Vec<BarAcc> = (0..bars).map(|_| BarAcc::default()).collect();
    let mut pending: Vec<u8> = Vec::with_capacity(4096);
    let mut read_buf = [0u8; 256 * 1024];
    let mut global_i: u64 = 0;
    let mut last_wf_pct: u8 = 0;

    loop {
        let n = match stdout.read(&mut read_buf) {
            Ok(n) => n,
            Err(_) => break,
        };
        if n == 0 {
            break;
        }
        pending.extend_from_slice(&read_buf[..n]);
        while pending.len() >= 4 {
            let s = f32::from_le_bytes(pending[..4].try_into().expect("len >= 4")) as f64;
            pending.copy_within(4.., 0);
            let new_len = pending.len() - 4;
            pending.truncate(new_len);
            let sq = s * s;
            let bar = ((global_i / block) as usize).min(bars.saturating_sub(1));
            let pos_in_block = global_i % block;
            let mid = block / 2;
            if pos_in_block < mid {
                acc[bar].top_sum_sq += sq;
                acc[bar].top_n += 1;
            } else {
                acc[bar].bottom_sum_sq += sq;
                acc[bar].bottom_n += 1;
            }
            global_i += 1;
            if total_samples > 0 {
                let wf_pct = ((global_i * 100) / total_samples).min(100) as u8;
                if wf_pct > last_wf_pct || wf_pct == 100 {
                    last_wf_pct = wf_pct;
                    on_progress(wf_pct);
                }
            }
        }
    }

    let _ = child.wait();
    on_progress(100);

    let mut raw_top: Vec<f64> = Vec::with_capacity(bars);
    let mut raw_bottom: Vec<f64> = Vec::with_capacity(bars);
    for a in acc.iter() {
        let top_rms = if a.top_n > 0 {
            (a.top_sum_sq / f64::from(a.top_n)).sqrt()
        } else {
            0.0
        };
        let bot_rms = if a.bottom_n > 0 {
            (a.bottom_sum_sq / f64::from(a.bottom_n)).sqrt()
        } else {
            0.0
        };
        raw_top.push(top_rms);
        raw_bottom.push(bot_rms);
    }

    Some(WaveformPeaks {
        top: normalize_to_band(&raw_top, 0.04, 0.98),
        bottom: normalize_to_band(&raw_bottom, 0.04, 0.48),
    })
}

/// First audio stream info from ffprobe (local files). `bits_per_sample` is often absent for lossy codecs.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioStreamInfo {
    pub sample_rate_hz: u32,
    pub bits_per_sample: Option<u16>,
}

fn json_value_to_u32(v: &Value) -> Option<u32> {
    match v {
        Value::Number(n) => n.as_u64().and_then(|x| u32::try_from(x).ok()),
        Value::String(s) => s.parse().ok(),
        _ => None,
    }
}

fn json_value_to_u16_nonzero(v: &Value) -> Option<u16> {
    let n = json_value_to_u32(v)?;
    if n == 0 {
        return None;
    }
    u16::try_from(n).ok()
}

/// Uses ffprobe JSON (`sample_rate`, `bits_per_sample` on stream a:0). Requires ffprobe on PATH.
pub fn ffprobe_audio_stream_info(path: &Path) -> Option<AudioStreamInfo> {
    let bin = if cfg!(target_os = "windows") {
        "ffprobe.exe"
    } else {
        "ffprobe"
    };
    let mut cmd = Command::new(bin);
    cmd.args([
        "-v",
        "error",
        "-select_streams",
        "a:0",
        "-show_entries",
        "stream=sample_rate,bits_per_sample",
        "-of",
        "json",
    ])
    .arg(path)
    .stdout(Stdio::piped())
    .stderr(Stdio::null());
    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let out = cmd.output().ok()?;
    if !out.status.success() {
        return None;
    }
    let root: Value = serde_json::from_slice(&out.stdout).ok()?;
    let stream = root.get("streams")?.as_array()?.first()?;
    let sample_rate_hz = stream
        .get("sample_rate")
        .and_then(|v| json_value_to_u32(v))?;
    let bits_per_sample = stream
        .get("bits_per_sample")
        .and_then(|v| json_value_to_u16_nonzero(v));
    Some(AudioStreamInfo {
        sample_rate_hz,
        bits_per_sample,
    })
}
