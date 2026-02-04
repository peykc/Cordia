//! Friend requests, friend codes, and delivery of pending items to users by WebSocket.

use std::collections::HashMap;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use tokio_tungstenite::tungstenite::Message;

use crate::{ConnId, WebSocketSender};

/// A pending friend request: from_user_id wants to be friends with to_user_id.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FriendRequest {
    pub from_user_id: String,
    pub to_user_id: String,
    #[serde(default)]
    pub from_display_name: Option<String>,
    #[serde(default)]
    pub from_account_created_at: Option<String>,
    pub created_at: DateTime<Utc>,
}

/// A shareable friend code created by a user. One active code per owner (create overwrites or returns existing).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FriendCode {
    pub owner_user_id: String,
    pub code: String,
    pub created_at: DateTime<Utc>,
    pub revoked: bool,
}

/// Someone used a friend code; code owner can accept or decline.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CodeRedemption {
    pub code_owner_id: String,
    pub redeemer_user_id: String,
    pub redeemer_display_name: String,
    #[serde(default)]
    pub redeemer_account_created_at: Option<String>,
    pub code: String,
    pub created_at: DateTime<Utc>,
}

/// Maps user_id -> (conn_id -> sender) so we can push friend-related messages to a user's connections.
pub struct FriendState {
    /// user_id -> (conn_id -> sender)
    pub user_connections: HashMap<String, HashMap<ConnId, WebSocketSender>>,
    /// (from_user_id, to_user_id) -> request (so we can look up both ways for mutual check)
    pub friend_requests: HashMap<(String, String), FriendRequest>,
    /// code (normalized) -> FriendCode
    pub friend_codes: HashMap<String, FriendCode>,
    /// owner_user_id -> list of redemptions (redeemer_user_id is key for accept/decline)
    pub code_redemptions: HashMap<String, Vec<CodeRedemption>>,
}

impl FriendState {
    pub fn new() -> Self {
        Self {
            user_connections: HashMap::new(),
            friend_requests: HashMap::new(),
            friend_codes: HashMap::new(),
            code_redemptions: HashMap::new(),
        }
    }

    /// Register a connection for a user (call when PresenceHello is received).
    pub fn register_connection(&mut self, user_id: &str, conn_id: ConnId, sender: WebSocketSender) {
        self.user_connections
            .entry(user_id.to_string())
            .or_default()
            .insert(conn_id, sender);
    }

    /// Unregister a connection for a user (call on WebSocket disconnect).
    pub fn unregister_connection(&mut self, user_id: &str, conn_id: &ConnId) {
        if let Some(conns) = self.user_connections.get_mut(user_id) {
            conns.remove(conn_id);
            if conns.is_empty() {
                self.user_connections.remove(user_id);
            }
        }
    }

    /// Send a JSON message to all connections for the given user.
    pub fn send_to_user(&self, user_id: &str, json: &str) {
        if let Some(conns) = self.user_connections.get(user_id) {
            let msg = Message::Text(json.to_string());
            for sender in conns.values() {
                let _ = sender.send(msg.clone());
            }
        }
    }

    /// Resolve sender user_id from conn_id (for ProfilePush).
    pub fn get_user_id_for_conn(&self, conn_id: &ConnId) -> Option<String> {
        for (user_id, conns) in &self.user_connections {
            if conns.contains_key(conn_id) {
                return Some(user_id.clone());
            }
        }
        None
    }
}
