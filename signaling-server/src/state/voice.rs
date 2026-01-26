use std::collections::HashMap;
use serde::{Serialize, Deserialize};
use crate::{HouseId, SigningPubkey, VoicePeer, PeerId, ConnId};

/// Info about a voice peer (returned to clients)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VoicePeerInfo {
    pub peer_id: PeerId,
    pub user_id: String,
}

/// Voice chat state (room-scoped)
pub struct VoiceState {
    /// Map of (house_id, room_id) -> list of VoicePeers in that room
    /// Room peer list may need indexing (HashMap<PeerId, VoicePeer>) if churn increases.
    pub voice_rooms: HashMap<(HouseId, String), Vec<VoicePeer>>,
    /// Map of house_id -> signing_pubkey (for voice presence broadcasting)
    pub house_signing_pubkeys: HashMap<HouseId, SigningPubkey>,
}

impl VoiceState {
    pub fn new() -> Self {
        Self {
            voice_rooms: HashMap::new(),
            house_signing_pubkeys: HashMap::new(),
        }
    }

    /// Register a peer for voice in a specific room.
    /// Returns list of other peers in the room.
    pub fn register_voice_peer(
        &mut self,
        peer_id: PeerId,
        user_id: String,
        house_id: HouseId,
        room_id: String,
        conn_id: ConnId,
    ) -> Vec<VoicePeerInfo> {
        let key = (house_id, room_id);
        let peers = self.voice_rooms.entry(key.clone()).or_insert_with(Vec::new);

        // Remove any existing entry for this user_id (handles reconnect with new peer_id)
        peers.retain(|p| p.user_id != user_id);

        // Add new entry
        peers.push(VoicePeer {
            peer_id: peer_id.clone(),
            user_id: user_id.clone(),
            conn_id,
        });

        // Return other peers (not self)
        peers.iter()
            .filter(|p| p.peer_id != peer_id)
            .map(|p| VoicePeerInfo {
                peer_id: p.peer_id.clone(),
                user_id: p.user_id.clone(),
            })
            .collect()
    }

    /// Unregister a peer from voice.
    /// Returns the user_id if found (for broadcasting PeerLeft).
    pub fn unregister_voice_peer(&mut self, peer_id: &PeerId, house_id: &HouseId, room_id: &str) -> Option<String> {
        let key = (house_id.clone(), room_id.to_string());
        let peers = self.voice_rooms.get_mut(&key)?;

        // Find and remove the peer
        let pos = peers.iter().position(|p| &p.peer_id == peer_id)?;
        let removed = peers.remove(pos);

        // Clean up empty room
        if peers.is_empty() {
            self.voice_rooms.remove(&key);
        }

        Some(removed.user_id)
    }

    /// Handle voice disconnect for a WebSocket connection.
    /// Returns list of (house_id, room_id, peer_id, user_id) for broadcasting PeerLeft.
    pub fn handle_voice_disconnect(&mut self, conn_id: &ConnId) -> Vec<(HouseId, String, PeerId, String)> {
        let mut removed: Vec<(HouseId, String, PeerId, String)> = Vec::new();

        // Find and remove all voice peers for this connection
        for ((house_id, room_id), peers) in self.voice_rooms.iter_mut() {
            let to_remove: Vec<_> = peers.iter()
                .filter(|p| &p.conn_id == conn_id)
                .map(|p| (p.peer_id.clone(), p.user_id.clone()))
                .collect();

            for (peer_id, user_id) in to_remove {
                removed.push((house_id.clone(), room_id.clone(), peer_id.clone(), user_id));
                peers.retain(|p| p.peer_id != peer_id);
            }
        }

        // Clean up empty rooms
        self.voice_rooms.retain(|_, peers| !peers.is_empty());

        removed
    }
}
