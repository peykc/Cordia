use std::collections::{HashMap, HashSet};
use crate::{PeerId, HouseId, SigningPubkey, WebSocketSender, ConnId, PeerConnection, EncryptedHouseHint, SignalingMessage};
use hyper_tungstenite::tungstenite::Message;

/// WebSocket signaling state (peer ↔ peer)
pub struct SignalingState {
    /// Map of peer_id -> PeerConnection
    pub peers: HashMap<PeerId, PeerConnection>,
    /// Map of house_id -> set of peer_ids in that house
    pub houses: HashMap<HouseId, HashSet<PeerId>>,
    /// Map of signing_pubkey -> set of peer_ids subscribed to that house
    pub signing_houses: HashMap<SigningPubkey, HashSet<PeerId>>,
    /// Map of peer_id -> WebSocket sender (for message forwarding)
    pub peer_senders: HashMap<PeerId, WebSocketSender>,
    /// Map of conn_id -> peer_ids registered on that websocket connection (allows correct cleanup)
    pub conn_peers: HashMap<ConnId, HashSet<PeerId>>,
}

impl SignalingState {
    pub fn new() -> Self {
        Self {
            peers: HashMap::new(),
            houses: HashMap::new(),
            signing_houses: HashMap::new(),
            peer_senders: HashMap::new(),
            conn_peers: HashMap::new(),
        }
    }

    /// Validates that a peer_id belongs to the connection sending the message.
    /// This enforces connection identity consistency, not authorization.
    /// Returns true if the peer_id is registered and belongs to the given conn_id.
    /// 
    /// Future optimization: Consider returning the validated PeerConnection to avoid
    /// double-locking (lock → validate → unlock, then lock again for work).
    pub fn validate_peer_connection(&self, peer_id: &PeerId, conn_id: &ConnId) -> bool {
        match self.peers.get(peer_id) {
            Some(peer) => peer.conn_id == *conn_id,
            None => false,
        }
    }

    pub fn register_peer(
        &mut self,
        peer_id: PeerId,
        house_id: HouseId,
        signing_pubkey: Option<SigningPubkey>,
        conn_id: ConnId,
    ) -> Vec<PeerId> {
        // Add peer connection
        self.peers.insert(
            peer_id.clone(),
            PeerConnection {
                peer_id: peer_id.clone(),
                house_id: house_id.clone(),
                signing_pubkey: signing_pubkey.clone(),
                conn_id: conn_id.clone(),
            },
        );

        // Track peer_id for this connection (fixes memory leaks when socket dies)
        self.conn_peers
            .entry(conn_id)
            .or_insert_with(HashSet::new)
            .insert(peer_id.clone());

        // Add peer to house
        let peers_in_house = self.houses.entry(house_id.clone()).or_insert_with(HashSet::new);
        peers_in_house.insert(peer_id.clone());

        // If a signing_pubkey was provided, treat this peer as subscribed for house-hint broadcasts
        if let Some(spk) = signing_pubkey {
            self.signing_houses.entry(spk).or_insert_with(HashSet::new).insert(peer_id.clone());
        }

        // Return other peers in the same house
        peers_in_house
            .iter()
            .filter(|p| **p != peer_id)
            .cloned()
            .collect()
    }

    pub fn unregister_peer(&mut self, peer_id: &PeerId) {
        if let Some(conn) = self.peers.remove(peer_id) {
            // Remove from house list
            if let Some(peers_in_house) = self.houses.get_mut(&conn.house_id) {
                peers_in_house.remove(peer_id);
                if peers_in_house.is_empty() {
                    self.houses.remove(&conn.house_id);
                }
            }

            // Remove from signing house list (if subscribed)
            if let Some(spk) = conn.signing_pubkey {
                if let Some(peers_for_signing) = self.signing_houses.get_mut(&spk) {
                    peers_for_signing.remove(peer_id);
                    if peers_for_signing.is_empty() {
                        self.signing_houses.remove(&spk);
                    }
                }
            }
        }
        // Remove WebSocket sender
        self.peer_senders.remove(peer_id);
    }

    pub fn get_house(&self, peer_id: &PeerId) -> Option<HouseId> {
        self.peers.get(peer_id).map(|c| c.house_id.clone())
    }

    pub fn broadcast_house_hint_updated(&self, signing_pubkey: &SigningPubkey, hint: &EncryptedHouseHint) {
        let Some(peers) = self.signing_houses.get(signing_pubkey) else {
            return;
        };

        let msg = SignalingMessage::HouseHintUpdated {
            signing_pubkey: signing_pubkey.clone(),
            encrypted_state: hint.encrypted_state.clone(),
            signature: hint.signature.clone(),
            last_updated: hint.last_updated,
        };

        let Ok(json) = serde_json::to_string(&msg) else {
            return;
        };

        for peer_id in peers {
            if let Some(sender) = self.peer_senders.get(peer_id) {
                let _ = sender.send(Message::Text(json.clone()));
            }
        }
    }
}
