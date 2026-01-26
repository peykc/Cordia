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
use tokio::sync::Mutex;
use crate::{SigningPubkey, SignalingMessage, ProfileRecord, PeerId, HouseId, WebSocketSender};
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
}

impl AppState {
    pub fn new() -> Self {
        Self {
            signaling: Arc::new(Mutex::new(SignalingState::new())),
            voice: Arc::new(Mutex::new(VoiceState::new())),
            presence: Arc::new(Mutex::new(PresenceState::new())),
            profiles: Arc::new(Mutex::new(ProfileState::new())),
            events: Arc::new(Mutex::new(EventState::new())),
            backends: Arc::new(Mutex::new(BackendState::new())),
        }
    }

    /// Broadcast a presence update to all peers subscribed to a house.
    /// This coordinates between PresenceState and SignalingState.
    pub async fn broadcast_presence_update(&self, signing_pubkey: &SigningPubkey, user_id: &str, online: bool, active: Option<SigningPubkey>) {
        let signaling = self.signaling.lock().await;
        let Some(peers) = signaling.signing_houses.get(signing_pubkey) else {
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

    /// Broadcast a profile update to all peers subscribed to a house.
    /// This coordinates between ProfileState and SignalingState.
    pub async fn broadcast_profile_update(&self, signing_pubkey: &SigningPubkey, user_id: &str, rec: &ProfileRecord) {
        let signaling = self.signaling.lock().await;
        let Some(peers) = signaling.signing_houses.get(signing_pubkey) else {
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

    /// Broadcast a message to all peers in a voice room.
    /// This coordinates between VoiceState and SignalingState.
    pub async fn broadcast_to_voice_room(&self, house_id: &HouseId, room_id: &str, msg: &SignalingMessage, exclude_peer: Option<&PeerId>) {
        let voice = self.voice.lock().await;
        let key = (house_id.clone(), room_id.to_string());
        let Some(peers) = voice.voice_rooms.get(&key) else {
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

    /// Get the sender for a specific peer in a voice room.
    /// This coordinates between VoiceState and SignalingState.
    pub async fn get_voice_peer_sender(&self, house_id: &HouseId, room_id: &str, peer_id: &PeerId) -> Option<WebSocketSender> {
        let voice = self.voice.lock().await;
        let key = (house_id.clone(), room_id.to_string());
        let peers = voice.voice_rooms.get(&key)?;

        // Verify peer is in this room
        if !peers.iter().any(|p| &p.peer_id == peer_id) {
            return None;
        }

        let signaling = self.signaling.lock().await;
        signaling.peer_senders.get(peer_id).cloned()
    }

    /// Broadcast voice presence update to all presence connections for a house.
    /// This coordinates between VoiceState and SignalingState.
    pub async fn broadcast_voice_presence(&self, signing_pubkey: &SigningPubkey, user_id: &str, room_id: &str, in_voice: bool) {
        let signaling = self.signaling.lock().await;
        let Some(peers) = signaling.signing_houses.get(signing_pubkey) else {
            return;
        };

        let msg = SignalingMessage::VoicePresenceUpdate {
            signing_pubkey: signing_pubkey.clone(),
            user_id: user_id.to_string(),
            room_id: room_id.to_string(),
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
