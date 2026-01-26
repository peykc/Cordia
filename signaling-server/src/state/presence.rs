use std::collections::{HashMap, HashSet};
use serde::{Serialize, Deserialize};
use crate::{ConnId, PresenceConn, PresenceUser, SigningPubkey};

/// Status of a presence user (returned in snapshots)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PresenceUserStatus {
    pub user_id: String,
    #[serde(default)]
    pub active_signing_pubkey: Option<SigningPubkey>,
}

/// Presence state (user ↔ house)
pub struct PresenceState {
    pub presence_conns: HashMap<ConnId, PresenceConn>,
    pub presence_users: HashMap<String, PresenceUser>,
}

impl PresenceState {
    pub fn new() -> Self {
        Self {
            presence_conns: HashMap::new(),
            presence_users: HashMap::new(),
        }
    }

    pub fn presence_snapshot_for(&self, signing_pubkey: &SigningPubkey) -> Vec<PresenceUserStatus> {
        let mut out = Vec::new();
        for (user_id, u) in self.presence_users.iter() {
            if u.signing_pubkeys.contains(signing_pubkey) {
                out.push(PresenceUserStatus {
                    user_id: user_id.clone(),
                    active_signing_pubkey: u.active_signing_pubkey.clone(),
                });
            }
        }
        out
    }

    pub fn upsert_presence_hello(
        &mut self,
        conn_id: &ConnId,
        user_id: String,
        signing_pubkeys: Vec<SigningPubkey>,
        active_signing_pubkey: Option<SigningPubkey>,
    ) -> Vec<SigningPubkey> {
        let spk_set: HashSet<SigningPubkey> = signing_pubkeys.into_iter().collect();
        self.presence_conns.insert(
            conn_id.clone(),
            PresenceConn {
                user_id: user_id.clone(),
                signing_pubkeys: spk_set.clone(),
            },
        );

        let u = self.presence_users.entry(user_id.clone()).or_insert_with(|| PresenceUser {
            conns: HashSet::new(),
            signing_pubkeys: HashSet::new(),
            active_signing_pubkey: None,
        });

        u.conns.insert(conn_id.clone());
        for spk in spk_set.iter() {
            u.signing_pubkeys.insert(spk.clone());
        }
        u.active_signing_pubkey = active_signing_pubkey;

        u.signing_pubkeys.iter().cloned().collect()
    }

    pub fn update_presence_active(&mut self, user_id: &str, active_signing_pubkey: Option<SigningPubkey>) -> Option<Vec<SigningPubkey>> {
        let u = self.presence_users.get_mut(user_id)?;
        u.active_signing_pubkey = active_signing_pubkey;
        Some(u.signing_pubkeys.iter().cloned().collect())
    }

    pub fn remove_presence_conn(&mut self, conn_id: &ConnId) -> Option<(String, Vec<SigningPubkey>)> {
        let conn = self.presence_conns.remove(conn_id)?;
        let user_id = conn.user_id.clone();
        let spks: Vec<SigningPubkey> = conn.signing_pubkeys.iter().cloned().collect();

        if let Some(u) = self.presence_users.get_mut(&user_id) {
            u.conns.remove(conn_id);
            if u.conns.is_empty() {
                self.presence_users.remove(&user_id);
                return Some((user_id, spks));
            }
        }
        // User still has another connection; keep online.
        None
    }
}
