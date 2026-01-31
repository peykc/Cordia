// Allow unused code during WebRTC scaffolding phase
#![allow(dead_code, unused_variables)]

use std::collections::HashSet;
use std::net::SocketAddr;
use std::sync::Arc;

use chrono::{DateTime, Duration, Utc};
use futures_util::{SinkExt, StreamExt};
use hyper::service::{make_service_fn, service_fn};
use hyper::{Body, Method, Request, Response, Server, StatusCode};
use log::{error, info, warn};
use serde::{Deserialize, Serialize};
use tokio::sync::mpsc;

#[cfg(feature = "postgres")]
use sqlx::postgres::PgPoolOptions;

pub mod state;
pub mod handlers;

pub type PeerId = String;
pub type ServerId = String;
pub type SigningPubkey = String;
pub type WebSocketSender = mpsc::UnboundedSender<hyper_tungstenite::tungstenite::Message>;
pub type ConnId = String;

pub(crate) fn decode_path_segment(seg: &str) -> String {
    match urlencoding::decode(seg) {
        Ok(s) => s.into_owned(),
        Err(_) => seg.to_string(),
    }
}

// Invite tokens are temporary and opaque to the server. Clients encrypt payloads; the server only stores/forwards.

// ============================================
// WebSocket Signaling Messages
// ============================================

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum SignalingMessage {
    /// Client registers with server_id and peer_id
    Register {
        server_id: ServerId,
        peer_id: PeerId,
        #[serde(default)]
        signing_pubkey: Option<SigningPubkey>,
    },
    /// SDP offer from one peer to another
    Offer {
        from_peer: PeerId,
        to_peer: PeerId,
        sdp: String,
    },
    /// SDP answer from one peer to another
    Answer {
        from_peer: PeerId,
        to_peer: PeerId,
        sdp: String,
    },
    /// ICE candidate exchange
    IceCandidate {
        from_peer: PeerId,
        to_peer: PeerId,
        candidate: String,
    },
    /// Server response to registration
    Registered {
        peer_id: PeerId,
        peers: Vec<PeerId>,
    },
    /// Error message from server
    Error {
        message: String,
    },
    /// Broadcast when a new member joins the server
    ServerMemberJoined {
        server_id: ServerId,
        member_user_id: String,
        member_display_name: String,
    },

    /// Broadcast when a server hint (snapshot) is updated via REST API
    ServerHintUpdated {
        signing_pubkey: SigningPubkey,
        encrypted_state: String,
        signature: String,
        last_updated: DateTime<Utc>,
    },

    // ============================
    // Presence (online/offline + active house)
    // ============================

    /// Client declares it is online for a set of servers and optionally which server is currently active.
    PresenceHello {
        user_id: String,
        signing_pubkeys: Vec<SigningPubkey>,
        #[serde(default)]
        active_signing_pubkey: Option<SigningPubkey>,
    },

    /// Client updates which server is currently active (or clears it to indicate "home").
    PresenceActive {
        user_id: String,
        #[serde(default)]
        active_signing_pubkey: Option<SigningPubkey>,
    },

    /// Server snapshot of currently-online users for a signing_pubkey.
    PresenceSnapshot {
        signing_pubkey: SigningPubkey,
        users: Vec<PresenceUserStatus>,
    },

    /// Server update for a single user relevant to a signing_pubkey.
    PresenceUpdate {
        signing_pubkey: SigningPubkey,
        user_id: String,
        online: bool,
        #[serde(default)]
        active_signing_pubkey: Option<SigningPubkey>,
    },

    /// Broadcast voice presence update (user joined/left voice in a chat)
    VoicePresenceUpdate {
        signing_pubkey: SigningPubkey,
        user_id: String,
        chat_id: String,
        in_voice: bool,  // true = joined, false = left
    },

    // ============================
    // Profile metadata (NO images)
    // ============================
    ProfileAnnounce {
        user_id: String,
        display_name: String,
        #[serde(default)]
        real_name: Option<String>,
        #[serde(default)]
        show_real_name: bool,
        rev: i64,
        signing_pubkeys: Vec<SigningPubkey>,
    },

    /// Client asks for the latest known profile metadata for a set of user_ids relevant to a server.
    /// (Server member lists are opaque to the beacon, so clients provide the user_ids they care about.)
    ProfileHello {
        signing_pubkey: SigningPubkey,
        user_ids: Vec<String>,
    },

    /// Server reply to ProfileHello with whatever it currently knows.
    ProfileSnapshot {
        signing_pubkey: SigningPubkey,
        profiles: Vec<ProfileSnapshotRecord>,
    },

    ProfileUpdate {
        user_id: String,
        display_name: String,
        #[serde(default)]
        real_name: Option<String>,
        #[serde(default)]
        show_real_name: bool,
        rev: i64,
        signing_pubkey: SigningPubkey,
    },

    // ============================
    // Voice Chat (Room-scoped WebRTC signaling)
    // ============================

    /// Client registers for voice in a specific chat
    VoiceRegister {
        server_id: ServerId,
        chat_id: String,
        peer_id: PeerId,      // Ephemeral session ID (UUID per join)
        user_id: String,      // Stable identity (public key hash)
        signing_pubkey: SigningPubkey,  // Server signing pubkey for presence broadcasting
    },

    /// Server response to voice registration
    VoiceRegistered {
        peer_id: PeerId,
        chat_id: String,
        peers: Vec<VoicePeerInfo>,  // Other peers in this chat only
    },

    /// Client unregisters from voice
    VoiceUnregister {
        peer_id: PeerId,
        chat_id: String,
    },

    /// Broadcast when a peer joins voice in a chat
    VoicePeerJoined {
        peer_id: PeerId,
        user_id: String,
        chat_id: String,
    },

    /// Broadcast when a peer leaves voice in a chat
    VoicePeerLeft {
        peer_id: PeerId,
        user_id: String,
        chat_id: String,
    },

    /// Voice SDP offer (chat-scoped)
    VoiceOffer {
        from_peer: PeerId,
        from_user: String,
        to_peer: PeerId,
        chat_id: String,
        sdp: String,
    },

    /// Voice SDP answer (chat-scoped)
    VoiceAnswer {
        from_peer: PeerId,
        from_user: String,
        to_peer: PeerId,
        chat_id: String,
        sdp: String,
    },

    /// Voice ICE candidate (chat-scoped)
    VoiceIceCandidate {
        from_peer: PeerId,
        to_peer: PeerId,
        chat_id: String,
        candidate: String,
    },

    // ============================
    // Keepalive (prevents idle WebSocket disconnect)
    // ============================

    /// Client ping to keep connection alive
    Ping,

    /// Server pong response
    Pong,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProfileSnapshotRecord {
    user_id: String,
    display_name: String,
    #[serde(default)]
    real_name: Option<String>,
    #[serde(default)]
    show_real_name: bool,
    rev: i64,
}

// PresenceUserStatus and VoicePeerInfo are now defined in state modules

/// Internal tracking for a voice peer
#[derive(Debug, Clone)]
pub struct VoicePeer {
    pub peer_id: PeerId,
    pub user_id: String,
    pub conn_id: ConnId,  // For cleanup on WebSocket disconnect
}

// ============================================
// Event Queue Types (REST API)
// ============================================

/// Server hint - NOT authoritative, just a cache/recovery aid
/// Any member can overwrite at any time (no creator lock)
/// 
/// Trust boundary: Clients MUST treat local state as authoritative even if server state differs.
/// The server is not the source of truth - this is just a cache/recovery aid.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EncryptedServerHint {
    pub signing_pubkey: String,
    pub encrypted_state: String,  // Beacon cannot decrypt
    pub signature: String,        // Signed by member's Ed25519 key
    pub last_updated: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InviteTokenCreateRequest {
    code: String,
    max_uses: u32, // 0 = unlimited
    encrypted_payload: String, // Server cannot decrypt
    signature: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InviteTokenRecord {
    pub code: String,
    pub signing_pubkey: String,
    pub encrypted_payload: String,
    pub signature: String,
    pub created_at: DateTime<Utc>,
    pub expires_at: DateTime<Utc>,
    pub max_uses: u32,
    pub remaining_uses: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ServerEvent {
    pub event_id: String,
    pub signing_pubkey: String,
    pub event_type: String,        // "MemberJoin", "MemberLeave", "NameChange"
    pub encrypted_payload: String, // Beacon cannot decrypt
    pub signature: String,         // Signed by member's Ed25519 key
    pub timestamp: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AckRequest {
    user_id: String,
    last_event_id: String,
}

// ============================================
// Server State
// ============================================

/// Connection info for each peer
#[derive(Debug, Clone)]
pub struct PeerConnection {
    pub peer_id: PeerId,
    pub server_id: ServerId,
    pub signing_pubkey: Option<SigningPubkey>,
    pub conn_id: ConnId,
}

#[derive(Debug, Clone)]
pub struct PresenceConn {
    pub user_id: String,
    pub signing_pubkeys: HashSet<SigningPubkey>,
}

#[derive(Debug, Clone)]
/// Presence user tracking across multiple device connections.
/// Trust boundary: Last connection wins for active_signing_pubkey (multi-device behavior).
/// This is an intentional UX choice, not a bug - the most recently active device sets the active server.
pub struct PresenceUser {
    pub conns: HashSet<ConnId>,
    pub signing_pubkeys: HashSet<SigningPubkey>,
    pub active_signing_pubkey: Option<SigningPubkey>,
}

#[derive(Debug, Clone)]
pub struct ProfileRecord {
    pub display_name: String,
    pub real_name: Option<String>,
    pub show_real_name: bool,
    pub rev: i64,
}

// ============================================
// Database and Redis Functions
// ============================================
// Moved to handlers/db.rs and handlers/redis.rs

const EVENT_RETENTION_DAYS: i64 = 30;
#[cfg(feature = "redis-backend")]
pub const DEFAULT_REDIS_PRESENCE_TTL_SECS: u64 = 120;

/// Shared state across all connections
// ServerState has been migrated to AppState with modular subsystems
// All methods are now in state/ modules

use state::AppState;
use state::presence::PresenceUserStatus;
use state::voice::VoicePeerInfo;
use handlers::{handle_message, handle_api_request};

#[cfg(feature = "postgres")]
use handlers::db::init_db;
#[cfg(feature = "postgres")]
use handlers::db::gc_old_events_db;
#[cfg(feature = "redis-backend")]
use handlers::redis::{redis_presence_disconnect, redis_presence_refresh};

type SharedState = Arc<AppState>;

// ============================================
// WebSocket Connection Handler
// ============================================

async fn handle_connection(
    ws: hyper_tungstenite::WebSocketStream<hyper::upgrade::Upgraded>,
    addr: SocketAddr,
    state: SharedState,
) {
    info!("WebSocket connection established from {}", addr);

    let (mut ws_sender, mut ws_receiver) = ws.split();
    let conn_id: ConnId = uuid::Uuid::new_v4().to_string();

    // Create channel for sending messages to this WebSocket
    let (tx, mut rx) = mpsc::unbounded_channel();

    // Spawn task to forward messages from channel to WebSocket
    let mut send_task = tokio::spawn(async move {
        while let Some(msg) = rx.recv().await {
            if ws_sender.send(msg).await.is_err() {
                break;
            }
        }
    });

    // Handle incoming messages
    loop {
        tokio::select! {
            msg_result = ws_receiver.next() => {
                match msg_result {
                    Some(Ok(hyper_tungstenite::tungstenite::Message::Text(text))) => {
                        match serde_json::from_str::<SignalingMessage>(&text) {
                            Ok(msg) => {
                                match handle_message(msg, &conn_id, &state, &tx).await {
                                    Ok(_) => {}
                                    Err(e) => {
                                        warn!("Error handling message: {}", e);
                                        let error_msg = SignalingMessage::Error {
                                            message: e.to_string(),
                                        };
                                        if let Ok(json) = serde_json::to_string(&error_msg) {
                                            let _ = tx.send(hyper_tungstenite::tungstenite::Message::Text(json));
                                        }
                                    }
                                }
                            }
                            Err(e) => {
                                warn!("Failed to parse message: {}", e);
                                let error_msg = SignalingMessage::Error {
                                    message: format!("Invalid message format: {}", e),
                                };
                                if let Ok(json) = serde_json::to_string(&error_msg) {
                                    let _ = tx.send(hyper_tungstenite::tungstenite::Message::Text(json));
                                }
                            }
                        }
                    }
                    Some(Ok(hyper_tungstenite::tungstenite::Message::Close(_))) => {
                        info!("Client {} closed connection", addr);
                        break;
                    }
                    Some(Ok(hyper_tungstenite::tungstenite::Message::Ping(data))) => {
                        let _ = tx.send(hyper_tungstenite::tungstenite::Message::Pong(data));
                    }
                    Some(Ok(_)) => {}
                    Some(Err(e)) => {
                        error!("WebSocket error from {}: {}", addr, e);
                        break;
                    }
                    None => break,
                }
            }
            _ = &mut send_task => {
                break;
            }
        }
    }

    // Clean up when connection closes
    // Get signing_pubkeys BEFORE disconnecting to ensure we have them for presence updates
    let server_signing_map = {
        let voice = state.voice.lock().await;
        voice.server_signing_pubkeys.clone()
    };

    let (presence_removed, voice_removed, redis_client) = {
        let mut signaling = state.signaling.lock().await;

        let peer_ids = if let Some(peer_ids) = signaling.conn_peers.remove(&conn_id) {
            let ids: Vec<_> = peer_ids.iter().cloned().collect();
            for peer_id in &ids {
                signaling.unregister_peer(peer_id);
            }
            ids
        } else {
            Vec::new()
        };

        drop(signaling);

        // Handle voice disconnect
        let mut voice = state.voice.lock().await;
        let voice_removed = voice.handle_voice_disconnect(&conn_id);
        drop(voice);

        // Handle presence disconnect
        let mut presence = state.presence.lock().await;
        let presence_removed = presence.remove_presence_conn(&conn_id);
        drop(presence);

        #[cfg(feature = "redis-backend")]
        let redis_client = {
            let backends = state.backends.lock().await;
            backends.redis.clone()
        };
        #[cfg(not(feature = "redis-backend"))]
        let redis_client: Option<()> = None;

        (presence_removed, voice_removed, redis_client)
    };

    // Broadcast VoicePeerLeft to remaining peers in each affected chat
    if !voice_removed.is_empty() {
        for (server_id, chat_id, peer_id, user_id) in voice_removed.clone() {
            info!("Voice peer {} (user {}) disconnected from chat {}", peer_id, user_id, chat_id);
            let msg = SignalingMessage::VoicePeerLeft {
                peer_id,
                user_id: user_id.clone(),
                chat_id: chat_id.clone(),
            };
            state.broadcast_to_voice_room(&server_id, &chat_id, &msg, None).await;
        }
        
        // Broadcast voice presence updates for disconnected peers
        for (server_id, chat_id, _, user_id) in voice_removed {
            // Use the signing_pubkey we collected BEFORE disconnecting
            if let Some(signing_pubkey) = server_signing_map.get(&server_id) {
                state.broadcast_voice_presence(signing_pubkey, &user_id, &chat_id, false).await;
            }
        }
    }

    if let Some((user_id, spks)) = presence_removed {
        #[cfg(feature = "redis-backend")]
        if let Some(client) = redis_client.as_ref() {
            if let Err(e) = redis_presence_disconnect(client, &user_id, &spks).await {
                warn!("Redis presence disconnect failed: {}", e);
            }
        }

        for spk in spks {
            state.broadcast_presence_update(&spk, &user_id, false, None).await;
        }
    }

    send_task.abort();
}


// ============================================
// HTTP REST API Handlers (Event Queue)
// ============================================
// Moved to handlers/http.rs

// ============================================
// Main Request Handler
// ============================================

async fn handle_request(
    mut req: Request<Body>,
    state: SharedState,
) -> Result<Response<Body>, hyper::Error> {
    let path = req.uri().path();
    let method = req.method().clone();

    // CORS preflight (needed for browser fetch from the Tauri/React frontend)
    if method == Method::OPTIONS {
        return Ok(Response::builder()
            .status(StatusCode::NO_CONTENT)
            .header("Access-Control-Allow-Origin", "*")
            .header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
            .header("Access-Control-Allow-Headers", "Content-Type")
            .header("Access-Control-Max-Age", "86400")
            .body(Body::empty())
            .unwrap());
    }

    // Health check endpoint
    if path == "/health" {
        return Ok(Response::builder()
            .status(StatusCode::OK)
            .header("Access-Control-Allow-Origin", "*")
            .header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
            .header("Access-Control-Allow-Headers", "Content-Type")
            .body(Body::from("ok"))
            .unwrap());
    }

    // WebSocket upgrade MUST be checked before GET / so app connections to wss://host/ get 101, not 200 HTML
    if hyper_tungstenite::is_upgrade_request(&req) {
        match hyper_tungstenite::upgrade(&mut req, None) {
            Ok((response, websocket)) => {
                tokio::spawn(async move {
                    if let Ok(ws) = websocket.await {
                        let addr = "0.0.0.0:9001".parse().unwrap();
                        handle_connection(ws, addr, state).await;
                    }
                });
                return Ok(response);
            }
            Err(e) => {
                error!("WebSocket upgrade error: {}", e);
                return Ok(Response::builder()
                    .status(StatusCode::BAD_REQUEST)
                    .body(Body::from("Invalid WebSocket upgrade request"))
                    .unwrap());
            }
        }
    }

    // Live status page (GET / or GET /status) - shows concurrent connections, auto-refreshes
    if path == "/" || path == "/status" {
        const STATUS_HTML: &str = r#"<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Cordia Beacon</title>
  <style>
    body { font-family: system-ui, sans-serif; display: flex; flex-direction: column; align-items: center; justify-content: center; min-height: 100vh; margin: 0; background: #0f0f0f; color: #e0e0e0; }
    h1 { font-weight: 300; font-size: 1.5rem; letter-spacing: 0.1em; text-transform: uppercase; margin-bottom: 0.5rem; }
    #count { font-size: 3rem; font-variant-numeric: tabular-nums; }
    .muted { font-size: 0.875rem; color: #888; margin-top: 1rem; }
  </style>
</head>
<body>
  <h1>Cordia Beacon</h1>
  <p id="count">—</p>
  <p class="muted">concurrent connections</p>
  <p class="muted">(app opens a connection when logged in and connected, or when in voice)</p>
  <p class="muted">Updates every 3s</p>
  <script>
    function update() {
      fetch(window.location.origin + '/api/status').then(r => {
        if (!r.ok) throw new Error(r.status);
        return r.json();
      }).then(d => {
        document.getElementById('count').textContent = String(d.connections ?? '—');
        document.getElementById('count').style.color = '';
      }).catch(() => {
        document.getElementById('count').textContent = '?';
        document.getElementById('count').style.color = '#888';
      });
    }
    update();
    setInterval(update, 3000);
  </script>
</body>
</html>"#;
        return Ok(Response::builder()
            .status(StatusCode::OK)
            .header("Content-Type", "text/html; charset=utf-8")
            .body(Body::from(STATUS_HTML))
            .unwrap());
    }

    // API endpoints (REST)
    if path.starts_with("/api/") {
        let mut resp = handle_api_request(req, state).await?;
        let headers = resp.headers_mut();
        headers.insert("Access-Control-Allow-Origin", "*".parse().unwrap());
        headers.insert("Access-Control-Allow-Methods", "GET, POST, OPTIONS".parse().unwrap());
        headers.insert("Access-Control-Allow-Headers", "Content-Type".parse().unwrap());
        return Ok(resp);
    }

    // Default response for other requests
    Ok(Response::builder()
        .status(StatusCode::NOT_FOUND)
        .body(Body::from("Not found. Use / or /status for live connection count, /health for health check, /api/* for REST API, or upgrade to WebSocket."))
        .unwrap())
}

// ============================================
// Main Entry Point
// ============================================

#[tokio::main]
async fn main() {
    // Healthcheck mode: exit 0 if server is running (port in use), exit 1 if not
    if std::env::args().any(|a| a == "--healthcheck") {
        use std::net::TcpListener;
        match TcpListener::bind("127.0.0.1:9001") {
            Ok(_) => std::process::exit(1), // Port free = server NOT running
            Err(_) => std::process::exit(0), // Port in use = server IS running (healthy)
        }
    }

    env_logger::init();

    let addr: SocketAddr = "0.0.0.0:9001".parse().expect("Invalid address");
    let state = Arc::new(AppState::new());

    // Optional Postgres durability (profiles first; others later)
    #[cfg(feature = "postgres")]
    {
        if let Ok(db_url) = std::env::var("SIGNALING_DB_URL") {
            match PgPoolOptions::new().max_connections(8).connect(&db_url).await {
                Ok(pool) => {
                    if let Err(e) = init_db(&pool).await {
                        warn!("DB init failed; continuing without DB: {}", e);
                    } else {
                        let mut backends = state.backends.lock().await;
                        backends.db = Some(pool);
                        info!("Postgres enabled (SIGNALING_DB_URL set).");
                    }
                }
                Err(e) => warn!("Failed to connect to Postgres; continuing without DB: {}", e),
            }
        } else {
            info!("Postgres disabled (SIGNALING_DB_URL not set).");
        }
    }

    // Optional Redis presence backend (ephemeral data with TTL)
    #[cfg(feature = "redis-backend")]
    {
        let ttl_secs = std::env::var("SIGNALING_REDIS_PRESENCE_TTL_SECS")
            .ok()
            .and_then(|v| v.parse::<u64>().ok())
            .unwrap_or(DEFAULT_REDIS_PRESENCE_TTL_SECS);

        if let Ok(redis_url) = std::env::var("SIGNALING_REDIS_URL") {
            match redis::Client::open(redis_url.as_str()) {
                Ok(client) => {
                    match client.get_multiplexed_tokio_connection().await {
                        Ok(mut conn) => {
                            let pong: Result<String, _> = redis::cmd("PING").query_async(&mut conn).await;
                            match pong {
                                Ok(_) => {
                                    let mut backends = state.backends.lock().await;
                                    backends.redis = Some(client);
                                    backends.redis_presence_ttl_secs = ttl_secs;
                                    info!("Redis presence enabled (SIGNALING_REDIS_URL set).");
                                }
                                Err(e) => warn!("Redis PING failed; continuing without Redis: {}", e),
                            }
                        }
                        Err(e) => warn!("Failed to connect to Redis; continuing without Redis: {}", e),
                    }
                }
                Err(e) => warn!("Invalid Redis URL; continuing without Redis: {}", e),
            }
        } else {
            info!("Redis presence disabled (SIGNALING_REDIS_URL not set).");
        }
    }

    // Spawn background task for garbage collection
    let gc_state = state.clone();
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(tokio::time::Duration::from_secs(3600)).await; // Every hour
            let (db, cutoff) = {
                let mut events = gc_state.events.lock().await;
                events.gc_old_events();
                drop(events);
                #[cfg(feature = "postgres")]
                let db = {
                    let backends = gc_state.backends.lock().await;
                    backends.db.clone()
                };
                #[cfg(not(feature = "postgres"))]
                let db: Option<()> = None;
                let cutoff = Utc::now() - Duration::days(EVENT_RETENTION_DAYS);
                (db, cutoff)
            };

            #[cfg(feature = "postgres")]
            if let Some(pool) = db {
                if let Err(e) = gc_old_events_db(&pool, cutoff).await {
                    warn!("DB GC failed: {}", e);
                }
            }

            info!("Garbage collected old events");
        }
    });

    #[cfg(feature = "redis-backend")]
    {
        let refresh_state = state.clone();
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(tokio::time::Duration::from_secs(30)).await;
                let (client, ttl, users) = {
                    let backends = refresh_state.backends.lock().await;
                    let presence = refresh_state.presence.lock().await;
                    let client = backends.redis.clone();
                    let ttl = backends.redis_presence_ttl_secs;
                    let users = presence
                        .presence_users
                        .iter()
                        .map(|(user_id, u)| {
                            (
                                user_id.clone(),
                                u.signing_pubkeys.iter().cloned().collect::<Vec<_>>(),
                                u.active_signing_pubkey.clone(),
                            )
                        })
                        .collect::<Vec<_>>();
                    (client, ttl, users)
                };

                if let Some(client) = client {
                    if let Err(e) = redis_presence_refresh(&client, ttl, &users).await {
                        warn!("Redis presence refresh failed: {}", e);
                    }
                }
            }
        });
    }

    let make_svc = make_service_fn(move |_conn| {
        let state = state.clone();
        async move {
            Ok::<_, hyper::Error>(service_fn(move |req| {
                let state = state.clone();
                handle_request(req, state)
            }))
        }
    });

    let server = Server::bind(&addr).serve(make_svc);

    info!("Beacon listening on http://{}", addr);
    info!("WebSocket endpoint: ws://{}", addr);
    info!("REST API: http://{}/api/servers/{{signing_pubkey}}/... (server hints)", addr);
    info!("Health check: http://{}/health", addr);

    if let Err(e) = server.await {
        error!("Server error: {}", e);
    }
}
