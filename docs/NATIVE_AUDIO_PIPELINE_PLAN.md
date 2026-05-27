# Native Audio Pipeline Implementation Plan (Phase 1)

## Overview

This document outlines the implementation plan for migrating Cordia's audio stack from webview-based `getUserMedia` to a native system-level audio pipeline with WebRTC transport.

**Status:** Phase 1 is **complete**. Phase 2 (2A, 2B, 2C) is planned for **Cordia v2**, not v1.

---

## What you should do now vs later

### ✅ What is perfect right now

**Do not touch these:**

- **Lock-free capture callback** — cpal callback writes into ring buffer; no locks, no blocking.
- **Fixed 10 ms frames** — 480 samples at 48 kHz; predictable, low latency.
- **Bounded queues + drop-on-full** — Raw ring and processed channel have fixed capacity; when full, drop (and count), never block.
- **"Prefer loss over latency" rule** — Audio loss > audio latency. Make this a contributor rule.
- **No allocations in callback** — Capture path is allocation-free; no heap in the hot path.
- **Event-driven push (no polling)** — Rust pushes frames via Tauri events; JS drains opportunistically. Never poll PCM from Rust.

This is textbook realtime audio engineering. You're already ahead of 95% of apps.

---

### 🟡 What you should plan, not implement yet

You don't need this now, but you should plan for it. Design the next layer; don't ship it yet.

- **Decouple injection from UI thread** — So UI stalls don't cause audible glitches (see Phase 2A).
- **Micro jitter buffer at injection** — For Wi-Fi forgiveness without turning into Discord (see Phase 2B).
- **Receiver-side Opus tuning** — Polish for last 10–20 ms when you touch WebRTC Opus (see Phase 2C).

---

### How to continue (clean, phased, no rewrites)

Phased roadmap: no big rewrites. Each phase builds on what you have.

#### Phase 2A (Soon, low risk): Decouple injection from UI thread

**Goal:** Prevent UI stalls from causing audible glitches without increasing latency.

**Best option: AudioWorklet**

- Runs on the audio rendering thread.
- Not blocked by React, DOM, layout, GC.
- Designed for exactly this use case.
- Supported in Chromium (WebView2).

**Architecture shift (minimal):**

```
Rust (cpal + DSP)
  ↓ (Tauri event)
JS Main Thread
  ↓ (MessagePort)
AudioWorkletProcessor
  ↓
RTCAudioSource / TrackGenerator
```

**Key point:** JS main thread becomes a **router**, not a processor. If UI stalls, frames may arrive late, but injection timing stays stable.

**What to plan now:**

- Define a single-producer ring inside the worklet.
- Messages from JS are "best effort".
- Worklet pulls every 10 ms.
- If empty → inject silence (not stall).

This preserves your philosophy: **loss is better than latency.**

---

#### Phase 2B (Optional, later): Micro jitter buffer (10–30 ms max)

**Goal:** Smooth Wi-Fi jitter without turning into Discord.

**What you want (Mumble-style):**

- 2–4 frames max (20–40 ms).
- Adaptive: grow slightly if underruns, shrink aggressively when stable.
- Never exceed a hard ceiling.

**Where to put it:** Not in Rust. Put it at **injection time** (AudioWorklet or Worker).

**Why:** Rust capture timing is perfect. Network jitter happens after. Worklet can adapt per-peer.

**Simple algorithm:**

- Circular buffer of N frames.
- Target fill = 2 frames.
- If underrun: temporarily allow 3–4.
- If overfill: drop oldest frame.

Result: near-LAN latency, forgiveness for bad Wi-Fi, no "robot voice" artifacts.

---

#### Phase 2C (Later): Receiver-side Opus tuning

You don't need custom transport yet. When you touch WebRTC Opus later:

- **ptime = 10**
- Disable FEC unless packet loss rises.
- Low jitter buffer target.

This squeezes the last 10–20 ms out. Polish, not core.

---

**Implemented and kept:** Drop metrics (raw ring + processed queue) via `get_audio_drop_stats_command()`. Optional: dev overlay or stats panel to expose them. Device hot-swap hardening (graceful fallback, "input lost" toast) remains as future work when needed.

---

## Current Architecture

### Frontend (TypeScript/React)
- **InputLevelMeter** (`src/lib/audio.ts`): 
  - Uses `getUserMedia` to capture microphone
  - Web Audio API for processing (gain, analysis)
  - Envelope math, VAD thresholding, PTT gating
  - Outputs `MediaStream` for WebRTC

### WebRTC Integration
- **WebRTCContext** (`src/contexts/WebRTCContext.tsx`):
  - Uses `attachAudioTrack()` to add MediaStream tracks to PeerConnection
  - Handles signaling, ICE, peer management
  - **KEEP THIS** - only change the audio source

## Target Architecture (Phase 1)

```
Native Mic Capture (Rust/cpal)
  ↓
Native DSP Pipeline (Rust)
  ├─ Noise Suppression
  ├─ Echo Cancellation  
  ├─ Voice Activity Detection
  └─ Gain Control
  ↓
PCM Frames (48kHz, mono, f32)
  ↓
RTCAudioSource (WebRTC inserted track)
  ↓
Existing WebRTC PeerConnection
  ↓
Network Transport (unchanged)
```

## Implementation Steps

### Step 1: Add Rust Dependencies

**File**: `src-tauri/Cargo.toml`

Add dependencies:
```toml
[dependencies]
# Audio capture (cross-platform)
cpal = "0.15"  # Cross-platform audio I/O

# Optional: For advanced DSP
# webrtc-audio-processing = "0.1"  # If available
# or use simpler VAD/NS implementations
```

**Research needed**: 
- Check if `webrtc-audio-processing` crate exists or if we need to use WebRTC C++ bindings
- Alternative: Use simpler Rust implementations for NS/EC/VAD

### Step 2: Create Native Audio Capture Module

**File**: `src-tauri/src/audio_capture.rs`

**Key Components**:

1. **AudioDevice** struct (matches frontend `AudioDevice`):
```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AudioDevice {
    pub device_id: String,
    pub label: String,
    pub kind: AudioDeviceKind,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum AudioDeviceKind {
    Input,
    Output,
}
```

2. **AudioCapture** struct:
```rust
pub struct AudioCapture {
    stream: Option<cpal::Stream>,
    device: Option<cpal::Device>,
    config: cpal::StreamConfig,
    sample_rate: u32,  // 48000
    channels: u16,     // 1 (mono)
}

impl AudioCapture {
    pub fn enumerate_devices() -> Result<Vec<AudioDevice>, String>;
    pub fn start_capture(device_id: Option<String>) -> Result<(), String>;
    pub fn stop_capture(&mut self);
    pub fn get_pcm_frames(&self) -> Option<Vec<f32>>;  // Returns latest frame buffer
}
```

3. **PCM Frame Callback**:
   - Use `cpal`'s callback-based API
   - Process frames in real-time (10ms chunks = 480 samples at 48kHz)
   - Apply DSP pipeline before sending to frontend

### Step 3: Implement Native DSP Pipeline

**File**: `src-tauri/src/audio_dsp.rs`

**Components**:

1. **DSP Pipeline**:
```rust
pub struct AudioDSP {
    noise_suppressor: NoiseSuppressor,
    echo_canceller: EchoCanceller,
    vad: VoiceActivityDetector,
    gain: f32,
    threshold: f32,
    input_mode: InputMode,  // VoiceActivity or PushToTalk
    ptt_pressed: bool,
    transmission_muted: bool,
}

impl AudioDSP {
    pub fn process_frame(&mut self, input: &[f32]) -> Vec<f32>;
    pub fn set_gain(&mut self, gain: f32);
    pub fn set_threshold(&mut self, threshold: f32);
    pub fn set_input_mode(&mut self, mode: InputMode);
    pub fn set_ptt_pressed(&mut self, pressed: bool);
    pub fn set_transmission_muted(&mut self, muted: bool);
    pub fn get_level(&self) -> f32;  // For UI meter
}
```

2. **Port InputLevelMeter Logic**:
   - **Envelope math**: Fast attack (instant), slow decay (0.88 per frame)
   - **Threshold gating**: VAD mode gates based on threshold, PTT mode gates on key press
   - **Gain smoothing**: Exponential attack/release for click-free gating
   - **Noise floor**: Clamp silence to 0 (0.0002 threshold)

3. **DSP Algorithms** (start simple, can improve later):
   - **Noise Suppression**: Simple spectral subtraction or use WebRTC's NS
   - **Echo Cancellation**: WebRTC's AEC (if available via bindings) or simpler adaptive filter
   - **VAD**: Energy-based VAD (simple) or WebRTC's VAD

### Step 4: Create Tauri Commands

**File**: `src-tauri/src/main.rs`

Add commands:
```rust
#[tauri::command]
fn enumerate_audio_devices_native() -> Result<Vec<AudioDevice>, String>;

#[tauri::command]
fn start_audio_capture(device_id: Option<String>) -> Result<(), String>;

#[tauri::command]
fn stop_audio_capture() -> Result<(), String>;

#[tauri::command]
fn set_audio_gain(gain: f32) -> Result<(), String>;

#[tauri::command]
fn set_audio_threshold(threshold: f32) -> Result<(), String>;

#[tauri::command]
fn set_audio_input_mode(mode: String) -> Result<(), String>;  // "voice_activity" | "push_to_talk"

#[tauri::command]
fn set_ptt_key_pressed(pressed: bool) -> Result<(), String>;

#[tauri::command]
fn set_transmission_muted(muted: bool) -> Result<(), String>;

// For level meter UI updates
#[tauri::command]
fn get_audio_level() -> Result<f32, String>;
```

**Event Emission**:
- Emit `cordia:audio-level` events periodically (60fps) with current level
- Frontend listens for these events to update UI meter

### Step 5: RTCAudioSource Integration

**Challenge**: WebRTC's `RTCAudioSource` is a Chromium/WebRTC API that allows manual frame injection.

**Approach**:
1. **Option A (Recommended)**: Use `RTCAudioSource` via JavaScript
   - Rust sends PCM frames to frontend via Tauri event or shared memory
   - Frontend creates `RTCAudioSource` and `MediaStreamTrack`
   - Inject frames using `RTCAudioSource.processFrame()`

2. **Option B**: Use WebRTC Rust bindings
   - More complex, requires `webrtc-rs` or similar
   - May not support inserted tracks easily

**Implementation (Option A)**:

**Frontend** (`src/lib/nativeAudio.ts`):
```typescript
export class NativeAudioCapture {
  private audioSource: RTCAudioSource | null = null;
  private track: MediaStreamTrack | null = null;
  private frameInterval: number | null = null;

  async start(): Promise<MediaStream> {
    // Create RTCAudioSource (Chromium API)
    this.audioSource = new RTCAudioSource();
    this.track = this.audioSource.createTrack();
    
    const stream = new MediaStream([this.track]);
    
    // Start frame injection loop
    this.frameInterval = setInterval(() => {
      this.injectFrame();
    }, 10); // 10ms = 480 samples at 48kHz
    
    return stream;
  }

  private async injectFrame() {
    if (!this.audioSource) return;
    
    // Get PCM frame from Rust (via Tauri event or IPC)
    const frame = await this.getPCMFrameFromRust();
    if (!frame) return;
    
    // Create AudioData (WebCodecs API) or use RTCAudioSource.processFrame
    // Note: Exact API depends on Chromium version
    this.audioSource.processFrame({
      samples: frame,
      sampleRate: 48000,
      numberOfChannels: 1,
    });
  }

  private async getPCMFrameFromRust(): Promise<Float32Array | null> {
    // Option 1: Tauri event listener
    // Option 2: Shared memory / IPC
    // Option 3: Polling via command (less efficient)
    return null; // TODO: Implement
  }
}
```

**Alternative**: Use `MediaStreamTrackGenerator` (newer API) if available:
```typescript
const generator = new MediaStreamTrackGenerator({ kind: 'audio' });
const writer = generator.writable.getWriter();
// Write AudioData frames to writer
```

### Step 6: Update Frontend Audio Integration

**File**: `src/lib/audio.ts`

**Changes**:
1. Replace `InputLevelMeter.start()` to use native capture:
```typescript
async start(deviceId: string | null, onLevelUpdate: (level: number) => void) {
  // Call Tauri command to start native capture
  await invoke('start_audio_capture', { deviceId });
  
  // Listen for level updates
  listen('cordia:audio-level', (event) => {
    const level = event.payload as number;
    onLevelUpdate(level);
  });
  
  // Get MediaStream from native audio source
  const nativeAudio = new NativeAudioCapture();
  this.stream = await nativeAudio.start();
}
```

2. Update `getTransmissionStream()`:
   - Return stream from `NativeAudioCapture` instead of Web Audio destination
   - DSP gating happens in Rust, so stream is already gated

3. Remove Web Audio API usage:
   - Remove `AudioContext`, `AnalyserNode`, `GainNode`
   - Keep only the interface methods (setGain, setThreshold, etc.) that call Tauri commands

**File**: `src/contexts/WebRTCContext.tsx`

**Changes**:
- `ensureAudioInitialized()`: Use native audio instead of `InputLevelMeter`
- `attachAudioTrack()`: Use stream from native capture
- Remove `localStreamRef` dependency on `getUserMedia`

### Step 7: Update Device Enumeration

**File**: `src/lib/audio.ts`

**Changes**:
```typescript
export async function enumerateAudioDevices(): Promise<{
  inputDevices: AudioDevice[]
  outputDevices: AudioDevice[]
}> {
  // Call native Rust enumeration (no permission needed!)
  const devices = await invoke('enumerate_audio_devices_native');
  return {
    inputDevices: devices.filter(d => d.kind === 'audioinput'),
    outputDevices: devices.filter(d => d.kind === 'audiooutput'),
  };
}
```

**Remove**: All `getUserMedia` calls for device enumeration

### Step 8: Testing & Validation

**Test Cases**:
1. ✅ No mic prompt appears on app start
2. ✅ Audio capture works without browser permissions
3. ✅ Device enumeration works without permissions
4. ✅ DSP pipeline processes audio correctly (NS/EC/VAD)
5. ✅ Gain, threshold, VAD/PTT modes work as before
6. ✅ Level meter updates correctly
7. ✅ WebRTC transmission works (remote peers hear audio)
8. ✅ Audio quality is good (no artifacts, low latency)
9. ✅ Hot-swap input device works
10. ✅ Monitoring (local loopback) works if implemented

## Technical Considerations

### Latency
- Target: <50ms end-to-end (capture → network)
- Use 10ms frame chunks (480 samples at 48kHz)
- Minimize buffering in Rust → Frontend → WebRTC path

### Threading
- Audio capture runs on dedicated thread in Rust
- DSP processing in capture callback (real-time)
- Frame delivery to frontend via Tauri events (async, non-blocking)

### Error Handling
- Device unavailable: Fall back to default device
- Capture failure: Show user-friendly error, don't crash
- WebRTC track creation failure: Log error, retry

### Backward Compatibility
- Keep `AudioSettings` structure unchanged
- Settings migration not needed (same fields)
- UI changes minimal (same controls, different backend)

## Dependencies Research

### Required Crates
1. **cpal** (`0.15`): Cross-platform audio I/O
   - ✅ Well-maintained
   - ✅ Supports Windows, macOS, Linux
   - ✅ Low-level control

2. **DSP Libraries** (choose one):
   - **Option A**: Use WebRTC C++ bindings via `webrtc-sys`
     - Pros: Industry-standard NS/EC/VAD
     - Cons: Complex build, large binary
   - **Option B**: Simple Rust implementations
     - Pros: Easy to integrate, small
     - Cons: May need tuning for quality
   - **Option C**: Hybrid (simple VAD, WebRTC NS/EC if available)
     - Pros: Balance of quality and simplicity

### Recommended Approach
Start with **Option C**: 
- Simple energy-based VAD (port from JS logic)
- Basic noise suppression (spectral subtraction)
- Echo cancellation: Start disabled, add WebRTC AEC later if needed
- Can improve DSP algorithms incrementally

## Migration Strategy

**Phase 1 (done):** Foundation, DSP integration, native capture → frontend → WebRTC flow. See **What you should do now vs later** at the top of this doc for what to keep and what to plan next.

**Phase 2 roadmap:** See **How to continue (clean, phased, no rewrites)** above — Phase 2A (AudioWorklet), 2B (micro jitter buffer), 2C (Opus tuning).

## Success Criteria

✅ **Functional**:
- No mic prompt on app start
- Audio capture works without browser permissions
- WebRTC transmission works
- All existing audio features work (gain, threshold, VAD/PTT)

✅ **Quality**:
- Audio quality matches or exceeds current implementation
- Latency < 50ms
- No audio artifacts or glitches

✅ **User Experience**:
- Seamless transition (users don't notice change)
- Settings UI works identically
- Device hot-swap works

## Future Enhancements (Phase 2)

Covered by the roadmap at the top: **Phase 2A** (decouple injection from UI thread), **Phase 2B** (micro jitter buffer), **Phase 2C** (receiver-side Opus tuning). Beyond that: custom P2P transport, advanced DSP (NS/EC), device hot-swap hardening, multi-channel, effects — only when needed.

## Notes

- **InputLevelMeter logic is valuable**: The envelope math, thresholding, and gating logic in the current JS implementation is well-tuned. Port this exactly to maintain UX.
- **WebRTC signaling unchanged**: Only the audio source changes. All signaling, ICE, peer management stays the same.
- **No rewrite needed**: This is an incremental improvement, not a rewrite. Current WebRTC code remains valuable.
