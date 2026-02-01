pub mod signaling;
pub mod voice;
pub mod presence;
pub mod profiles;
pub mod events;
pub mod backends;

pub use signaling::SignalingState;
pub use voice::VoiceState;
pub use presence::PresenceState;
pub use profiles::ProfileState;
pub use events::EventState;
pub use backends::BackendState;

use std::sync::Arc;
use std::time::Instant;
use tokio::sync::Mutex;
use crate::{SigningPubkey, SignalingMessage, ProfileRecord, PeerId, ServerId, WebSocketSender};
use hyper_tungstenite::tungstenite::Message;

/// Main application state wrapping all subsystems.
/// Each subsystem has its own Mutex to reduce contention.
/// Start with Mutex everywhere. Only consider upgrading to RwLock after Phase 3 if profiling shows read-heavy contention.
pub struct AppState {
    pub signaling: Arc<Mutex<SignalingState>>,
    pub voice: Arc<Mutex<VoiceState>>,
    pub presence: Arc<Mutex<PresenceState>>,
    pub profiles: Arc<Mutex<ProfileState>>,
    pub events: Arc<Mutex<EventState>>,
    pub backends: Arc<Mutex<BackendState>>,
    /// When the beacon process started (for uptime / status page).
    pub started_at: Instant,
    /// ISO8601 timestamp when the beacon started (for status).
    pub started_at_utc: String,
    /// Duration of previous shutdown in seconds (from last-stop file), if any.
    pub downtime_secs: Option<u64>,
    /// Previous network totals and time for rate calculation (rx_total, tx_total, at).
    pub network_prev: Arc<Mutex<Option<(u64, u64, std::time::Instant)>>>,
}

impl AppState {
    pub fn new(downtime_secs: Option<u64>) -> Self {
        let now_utc = chrono::Utc::now();
        Self {
            signaling: Arc::new(Mutex::new(SignalingState::new())),
            voice: Arc::new(Mutex::new(VoiceState::new())),
            presence: Arc::new(Mutex::new(PresenceState::new())),
            profiles: Arc::new(Mutex::new(ProfileState::new())),
            events: Arc::new(Mutex::new(EventState::new())),
            backends: Arc::new(Mutex::new(BackendState::new())),
            started_at: Instant::now(),
            started_at_utc: now_utc.to_rfc3339(),
            downtime_secs,
            network_prev: Arc::new(Mutex::new(None)),
        }
    }

    /// Broadcast a presence update to all peers subscribed to a server.
    /// This coordinates between PresenceState and SignalingState.
    pub async fn broadcast_presence_update(&self, signing_pubkey: &SigningPubkey, user_id: &str, online: bool, active: Option<SigningPubkey>) {
        let signaling = self.signaling.lock().await;
        let Some(peers) = signaling.signing_servers.get(signing_pubkey) else {
            return;
        };

        let msg = SignalingMessage::PresenceUpdate {
            signing_pubkey: signing_pubkey.clone(),
            user_id: user_id.to_string(),
            online,
            active_signing_pubkey: active,
        };

        let Ok(json) = serde_json::to_string(&msg) else {
            return;
        };

        for peer_id in peers {
            if let Some(sender) = signaling.peer_senders.get(peer_id) {
                let _ = sender.send(Message::Text(json.clone()));
            }
        }
    }

    /// Broadcast a profile update to all peers subscribed to a server.
    /// This coordinates between ProfileState and SignalingState.
    pub async fn broadcast_profile_update(&self, signing_pubkey: &SigningPubkey, user_id: &str, rec: &ProfileRecord) {
        let signaling = self.signaling.lock().await;
        let Some(peers) = signaling.signing_servers.get(signing_pubkey) else {
            return;
        };

        let msg = SignalingMessage::ProfileUpdate {
            signing_pubkey: signing_pubkey.clone(),
            user_id: user_id.to_string(),
            display_name: rec.display_name.clone(),
            real_name: rec.real_name.clone(),
            show_real_name: rec.show_real_name,
            rev: rec.rev,
        };

        let Ok(json) = serde_json::to_string(&msg) else {
            return;
        };

        for peer_id in peers {
            if let Some(sender) = signaling.peer_senders.get(peer_id) {
                let _ = sender.send(Message::Text(json.clone()));
            }
        }
    }

    /// Broadcast a message to all peers in a voice chat.
    /// This coordinates between VoiceState and SignalingState.
    pub async fn broadcast_to_voice_room(&self, server_id: &ServerId, chat_id: &str, msg: &SignalingMessage, exclude_peer: Option<&PeerId>) {
        let voice = self.voice.lock().await;
        let key = (server_id.clone(), chat_id.to_string());
        let Some(peers) = voice.voice_chats.get(&key) else {
            return;
        };

        let Ok(json) = serde_json::to_string(msg) else {
            return;
        };

        // Need to get peer_senders from signaling
        let signaling = self.signaling.lock().await;
        for peer in peers {
            // Skip excluded peer
            if let Some(excluded) = exclude_peer {
                if &peer.peer_id == excluded {
                    continue;
                }
            }

            if let Some(sender) = signaling.peer_senders.get(&peer.peer_id) {
                let _ = sender.send(Message::Text(json.clone()));
            }
        }
    }

    /// Get the sender for a specific peer in a voice chat.
    /// This coordinates between VoiceState and SignalingState.
    pub async fn get_voice_peer_sender(&self, server_id: &ServerId, chat_id: &str, peer_id: &PeerId) -> Option<WebSocketSender> {
        let voice = self.voice.lock().await;
        let key = (server_id.clone(), chat_id.to_string());
        let peers = voice.voice_chats.get(&key)?;

        // Verify peer is in this room
        if !peers.iter().any(|p| &p.peer_id == peer_id) {
            return None;
        }

        let signaling = self.signaling.lock().await;
        signaling.peer_senders.get(peer_id).cloned()
    }

    /// Broadcast voice presence update to all presence connections for a server.
    /// This coordinates between VoiceState and SignalingState.
    pub async fn broadcast_voice_presence(&self, signing_pubkey: &SigningPubkey, user_id: &str, chat_id: &str, in_voice: bool) {
        let signaling = self.signaling.lock().await;
        let Some(peers) = signaling.signing_servers.get(signing_pubkey) else {
            return;
        };

        let msg = SignalingMessage::VoicePresenceUpdate {
            signing_pubkey: signing_pubkey.clone(),
            user_id: user_id.to_string(),
            chat_id: chat_id.to_string(),
            in_voice,
        };

        let Ok(json) = serde_json::to_string(&msg) else {
            return;
        };

        // Send to all peer connections subscribed to this house (same mechanism as presence updates)
        for peer_id in peers {
            if let Some(sender) = signaling.peer_senders.get(peer_id) {
                let _ = sender.send(Message::Text(json.clone()));
            }
        }
    }
}
