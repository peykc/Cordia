use std::collections::HashMap;
use chrono::Utc;
use crate::{ConnId, SigningPubkey, SwarmPeerInfo};

#[derive(Debug, Clone)]
pub struct SwarmPeer {
    pub user_id: String,
    pub conn_id: ConnId,
    pub seeding: bool,
    pub piece_count: u32,
    pub upload_kbps: Option<u32>,
    pub quality_score: Option<u8>,
    pub leechers: Option<u32>,
    pub updated_at_unix_ms: i64,
}

/// In-memory swarm index keyed by (signing_pubkey, sha256).
/// This is intentionally ephemeral and rebuilt by client announces after reconnect.
pub struct SwarmState {
    pub swarms: HashMap<(SigningPubkey, String), HashMap<ConnId, SwarmPeer>>,
}

impl SwarmState {
    pub fn new() -> Self {
        Self { swarms: HashMap::new() }
    }

    pub fn announce(
        &mut self,
        signing_pubkey: SigningPubkey,
        sha256: String,
        conn_id: ConnId,
        user_id: String,
        seeding: bool,
        piece_count: u32,
        upload_kbps: Option<u32>,
        quality_score: Option<u8>,
    ) {
        let now = Utc::now().timestamp_millis();
        let by_conn = self.swarms.entry((signing_pubkey, sha256)).or_default();
        by_conn.insert(
            conn_id.clone(),
            SwarmPeer {
                user_id,
                conn_id,
                seeding,
                piece_count,
                upload_kbps,
                quality_score,
                leechers: None,
                updated_at_unix_ms: now,
            },
        );
    }

    pub fn unannounce(&mut self, signing_pubkey: &SigningPubkey, sha256: &str, conn_id: &ConnId) {
        let key = (signing_pubkey.clone(), sha256.to_string());
        if let Some(by_conn) = self.swarms.get_mut(&key) {
            by_conn.remove(conn_id);
            if by_conn.is_empty() {
                self.swarms.remove(&key);
            }
        }
    }

    pub fn update_health(
        &mut self,
        signing_pubkey: &SigningPubkey,
        sha256: &str,
        conn_id: &ConnId,
        upload_kbps: Option<u32>,
        quality_score: Option<u8>,
        leechers: Option<u32>,
    ) {
        let key = (signing_pubkey.clone(), sha256.to_string());
        if let Some(by_conn) = self.swarms.get_mut(&key) {
            if let Some(p) = by_conn.get_mut(conn_id) {
                p.upload_kbps = upload_kbps.or(p.upload_kbps);
                p.quality_score = quality_score.or(p.quality_score);
                p.leechers = leechers.or(p.leechers);
                p.updated_at_unix_ms = Utc::now().timestamp_millis();
            }
        }
    }

    pub fn peers_for(
        &self,
        signing_pubkey: &SigningPubkey,
        sha256: &str,
        exclude_conn_id: &ConnId,
        max_peers: usize,
    ) -> Vec<SwarmPeerInfo> {
        let key = (signing_pubkey.clone(), sha256.to_string());
        let Some(by_conn) = self.swarms.get(&key) else {
            return Vec::new();
        };
        let mut list: Vec<&SwarmPeer> = by_conn
            .values()
            .filter(|p| &p.conn_id != exclude_conn_id)
            .collect();

        // Prefer seeders, then quality score, then upload capacity, then most recently updated.
        list.sort_by(|a, b| {
            b.seeding.cmp(&a.seeding)
                .then_with(|| b.quality_score.unwrap_or(0).cmp(&a.quality_score.unwrap_or(0)))
                .then_with(|| b.upload_kbps.unwrap_or(0).cmp(&a.upload_kbps.unwrap_or(0)))
                .then_with(|| b.updated_at_unix_ms.cmp(&a.updated_at_unix_ms))
        });

        list.into_iter()
            .take(max_peers)
            .map(|p| SwarmPeerInfo {
                user_id: p.user_id.clone(),
                seeding: p.seeding,
                piece_count: p.piece_count,
                upload_kbps: p.upload_kbps,
                quality_score: p.quality_score,
                leechers: p.leechers,
                updated_at_unix_ms: p.updated_at_unix_ms,
            })
            .collect()
    }

    pub fn remove_conn(&mut self, conn_id: &ConnId) {
        let mut empty_keys: Vec<(SigningPubkey, String)> = Vec::new();
        for (k, by_conn) in self.swarms.iter_mut() {
            by_conn.remove(conn_id);
            if by_conn.is_empty() {
                empty_keys.push(k.clone());
            }
        }
        for k in empty_keys {
            self.swarms.remove(&k);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn returns_ranked_peers_and_excludes_requester() {
        let mut state = SwarmState::new();
        let signing = "spk-1".to_string();
        let sha = "sha-1".to_string();
        state.announce(
            signing.clone(),
            sha.clone(),
            "conn-a".to_string(),
            "user-a".to_string(),
            true,
            8,
            Some(1500),
            Some(90),
        );
        state.announce(
            signing.clone(),
            sha.clone(),
            "conn-b".to_string(),
            "user-b".to_string(),
            true,
            8,
            Some(500),
            Some(60),
        );
        state.announce(
            signing.clone(),
            sha.clone(),
            "conn-c".to_string(),
            "user-c".to_string(),
            false,
            4,
            Some(100),
            Some(20),
        );

        let peers = state.peers_for(&signing, &sha, &"conn-a".to_string(), 10);
        assert_eq!(peers.len(), 2);
        assert_eq!(peers[0].user_id, "user-b");
        assert_eq!(peers[1].user_id, "user-c");
        assert!(peers[0].seeding);
        assert!(!peers[1].seeding);
    }

    #[test]
    fn removes_disconnected_connection_from_all_swarms() {
        let mut state = SwarmState::new();
        state.announce(
            "spk-1".to_string(),
            "sha-1".to_string(),
            "conn-a".to_string(),
            "user-a".to_string(),
            true,
            8,
            None,
            None,
        );
        state.announce(
            "spk-2".to_string(),
            "sha-2".to_string(),
            "conn-a".to_string(),
            "user-a".to_string(),
            true,
            8,
            None,
            None,
        );
        state.remove_conn(&"conn-a".to_string());
        assert!(state.swarms.is_empty());
    }
}
