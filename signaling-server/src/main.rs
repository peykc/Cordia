// Allow unused code during WebRTC scaffolding phase
#![allow(dead_code, unused_variables)]

use std::collections::HashSet;
use std::env;
use std::fs;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;

use axum::{
    http::StatusCode,
    response::Html,
    routing::get,
    Router,
};
use chrono::{DateTime, Duration, Utc};
use log::{error, info};
use serde::{Deserialize, Serialize};
use tokio::sync::mpsc;
use tower_http::cors::CorsLayer;
use tower_http::trace::TraceLayer;

#[cfg(feature = "postgres")]
use sqlx::postgres::PgPoolOptions;

pub mod state;
pub mod handlers;

pub type PeerId = String;
pub type ServerId = String;
pub type SigningPubkey = String;
pub type WebSocketSender = mpsc::UnboundedSender<tokio_tungstenite::tungstenite::Message>;
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
    pub user_id: String,
    pub last_event_id: String,
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

#[cfg(feature = "postgres")]
use handlers::db::init_db;
#[cfg(feature = "postgres")]
use handlers::db::gc_old_events_db;
#[cfg(feature = "redis-backend")]
use handlers::redis::redis_presence_refresh;

type SharedState = Arc<AppState>;

// ============================================
// Status page HTML
// ============================================

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
    .time-block { font-size: 0.875rem; margin-top: 0.5rem; display: flex; gap: 3rem; justify-content: center; flex-wrap: wrap; }
    .time-col { display: flex; flex-direction: column; align-items: center; }
    .time-label { color: #888; margin-bottom: 0.15rem; }
    .time-val { font-variant-numeric: tabular-nums; min-width: 4em; text-align: center; }
    .time-val.uptime { color: #22c55e; }
    .time-val.downtime { color: #ef4444; }
    .separator { width: 50%; max-width: 10rem; margin: 0.75rem auto; border: none; border-top: 1px solid #444; }
    .network-block { font-size: 0.875rem; display: flex; flex-direction: column; align-items: center; gap: 0.25rem; }
    .network-row { display: flex; gap: 3.5rem; justify-content: center; }
    .network-label { color: #888; }
    .network-val { font-variant-numeric: tabular-nums; text-align: center; }
    .network-val.upload { color: #22c55e; }
    .network-val.download { color: #ef4444; }
    .resources-block { font-size: 0.875rem; margin-top: 0; display: flex; gap: 3rem; justify-content: center; flex-wrap: wrap; }
    .resource-col { display: flex; flex-direction: column; align-items: center; }
    .resource-label { color: #888; margin-bottom: 0.15rem; }
    .resource-val { font-variant-numeric: tabular-nums; min-width: 4em; text-align: center; color: #e0e0e0; }
  </style>
</head>
<body>
  <h1>Cordia Beacon</h1>
  <p class="muted">Connections</p>
  <p id="count">—</p>
  <div class="time-block">
    <div class="time-col"><span class="time-label">Uptime</span><span id="uptime" class="time-val uptime">—</span></div>
    <div class="time-col"><span class="time-label">Downtime</span><span id="downtime" class="time-val downtime">—</span></div>
  </div>
  <hr class="separator" />
  <div class="network-block">
    <div class="network-row"><span class="network-label">Upload</span><span class="network-label">Download</span></div>
    <div class="network-row"><span id="tx" class="network-val upload">—</span><span id="rx" class="network-val download">—</span></div>
  </div>
  <hr class="separator" />
  <div class="resources-block">
    <div class="resource-col"><span class="resource-label">RAM</span><span id="ram" class="resource-val">—</span></div>
    <div class="resource-col"><span class="resource-label">CPU</span><span id="cpu" class="resource-val">—</span></div>
  </div>
  <script>
    function formatUptime(secs) {
      if (secs < 60) return secs + 's';
      if (secs < 3600) return Math.floor(secs / 60) + 'm';
      if (secs < 86400) return Math.floor(secs / 3600) + 'h ' + Math.floor((secs % 3600) / 60) + 'm';
      var d = Math.floor(secs / 86400);
      var h = Math.floor((secs % 86400) / 3600);
      return d + 'd ' + h + 'h';
    }
    function formatBps(bps) {
      if (bps == null || bps === undefined) return '—';
      if (bps >= 1048576) return (bps / 1048576).toFixed(2) + ' MB/s';
      if (bps >= 1024) return (bps / 1024).toFixed(1) + ' KB/s';
      return bps + ' B/s';
    }
    function formatMemory(bytes) {
      if (bytes == null || bytes === undefined) return '—';
      if (bytes >= 1073741824) return (bytes / 1073741824).toFixed(2) + ' GB';
      if (bytes >= 1048576) return (bytes / 1048576).toFixed(1) + ' MB';
      if (bytes >= 1024) return (bytes / 1024).toFixed(0) + ' KB';
      return bytes + ' B';
    }
    var currentCount = null;
    var countAnimationId = null;
    var TICK_MS = 55;
    var MAX_TICKS = 28;
    function animateCount(el, from, to) {
      if (countAnimationId) cancelAnimationFrame(countAnimationId);
      var diff = to - from;
      if (diff === 0) { currentCount = to; countAnimationId = null; return; }
      var stepVal = diff > 0 ? Math.max(1, Math.ceil(diff / MAX_TICKS)) : Math.min(-1, Math.floor(diff / MAX_TICKS));
      var display = from;
      var lastTick = performance.now();
      function tick(now) {
        if (display === to) {
          currentCount = to;
          countAnimationId = null;
          return;
        }
        if (now - lastTick >= TICK_MS) {
          lastTick = now;
          display += stepVal;
          if (stepVal > 0 && display > to) display = to;
          if (stepVal < 0 && display < to) display = to;
          el.textContent = String(display);
        }
        countAnimationId = requestAnimationFrame(tick);
      }
      countAnimationId = requestAnimationFrame(tick);
    }
    function setCount(value) {
      var el = document.getElementById('count');
      if (value === null || value === undefined || typeof value !== 'number') {
        el.textContent = value == null ? '—' : String(value);
        currentCount = null;
        return;
      }
      var target = Math.max(0, value);
      if (currentCount === null) {
        el.textContent = String(target);
        currentCount = target;
        return;
      }
      if (currentCount === target) return;
      animateCount(el, currentCount, target);
    }
    function update() {
      fetch(window.location.origin + '/api/status').then(r => {
        if (!r.ok) throw new Error(r.status);
        return r.json();
      }).then(d => {
        setCount(d.connections);
        document.getElementById('count').style.color = '';
        document.getElementById('uptime').textContent = formatUptime(d.uptime_secs || 0);
        document.getElementById('downtime').textContent = d.downtime_secs != null ? formatUptime(d.downtime_secs) : '—';
        document.getElementById('tx').textContent = '↑ ' + formatBps(d.tx_bps);
        document.getElementById('rx').textContent = '↓ ' + formatBps(d.rx_bps);
        document.getElementById('ram').textContent = formatMemory(d.memory_bytes);
        document.getElementById('cpu').textContent = d.cpu_percent != null ? d.cpu_percent.toFixed(1) + '%' : '—';
      }).catch(() => {
        if (countAnimationId) cancelAnimationFrame(countAnimationId);
        countAnimationId = null;
        currentCount = null;
        document.getElementById('count').textContent = '?';
        document.getElementById('count').style.color = '#888';
        document.getElementById('uptime').textContent = '—';
        document.getElementById('downtime').textContent = '—';
        document.getElementById('tx').textContent = '—';
        document.getElementById('rx').textContent = '—';
        document.getElementById('ram').textContent = '—';
        document.getElementById('cpu').textContent = '—';
      });
    }
    update();
    setInterval(update, 3000);
  </script>
</body>
</html>"#;

async fn status_page_handler() -> Html<&'static str> {
    Html(STATUS_HTML)
}

// ============================================
// Last-stop file (for downtime on status page)
// ============================================

fn last_stop_file_path() -> PathBuf {
    env::var("SIGNALING_DATA_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|_| env::temp_dir())
        .join("cordia-beacon-last-stop")
}

/// Read last-stop timestamp and return previous shutdown duration in seconds (started_at - last_stopped).
fn read_downtime_secs() -> Option<u64> {
    let path = last_stop_file_path();
    let s = fs::read_to_string(&path).ok()?;
    let stopped = chrono::DateTime::parse_from_rfc3339(s.trim()).ok()?.with_timezone(&Utc);
    let now = Utc::now();
    let secs = (now - stopped).num_seconds();
    if secs < 0 || secs > 7 * 24 * 3600 {
        return None;
    }
    Some(secs as u64)
}

fn write_last_stop_file() {
    let path = last_stop_file_path();
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let s = Utc::now().to_rfc3339();
    if let Err(e) = fs::write(&path, s) {
        log::warn!("Failed to write last-stop file: {}", e);
    }
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

    let downtime_secs = read_downtime_secs();
    let addr: SocketAddr = "0.0.0.0:9001".parse().expect("Invalid address");
    let state = Arc::new(AppState::new(downtime_secs));

    // Optional Postgres durability (profiles first; others later)
    #[cfg(feature = "postgres")]
    {
        if let Ok(db_url) = std::env::var("SIGNALING_DB_URL") {
            match PgPoolOptions::new().max_connections(8).connect(&db_url).await {
                Ok(pool) => {
                    if let Err(e) = init_db(&pool).await {
                        log::warn!("DB init failed; continuing without DB: {}", e);
                    } else {
                        let mut backends = state.backends.lock().await;
                        backends.db = Some(pool);
                        info!("Postgres enabled (SIGNALING_DB_URL set).");
                    }
                }
                Err(e) => log::warn!("Failed to connect to Postgres; continuing without DB: {}", e),
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
                                Err(e) => log::warn!("Redis PING failed; continuing without Redis: {}", e),
                            }
                        }
                        Err(e) => log::warn!("Failed to connect to Redis; continuing without Redis: {}", e),
                    }
                }
                Err(e) => log::warn!("Invalid Redis URL; continuing without Redis: {}", e),
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
                    log::warn!("DB GC failed: {}", e);
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
                        log::warn!("Redis presence refresh failed: {}", e);
                    }
                }
            }
        });
    }

    let server_routes = Router::new()
        .route("/register", axum::routing::post(handlers::http::register_server_hint))
        .route("/hint", get(handlers::http::get_server_hint))
        .route("/invites", axum::routing::post(handlers::http::create_house_invite))
        .route("/events", get(handlers::http::get_events).post(handlers::http::post_event))
        .route("/events/ack", axum::routing::post(handlers::http::ack_events))
        .route("/ack", axum::routing::post(handlers::http::ack_events));

    let app = Router::new()
        .route("/api/status", get(handlers::http::get_status))
        .route("/api/invites/:code", get(handlers::http::get_invite))
        .route("/api/invites/:code/redeem", axum::routing::post(handlers::http::redeem_invite))
        .route("/api/invites/:code/revoke", axum::routing::post(handlers::http::revoke_invite))
        .nest("/api/servers/:signing_pubkey", server_routes)
        .route("/health", get(|| async { "ok" }))
        .route("/", get(status_page_handler))
        .route("/status", get(status_page_handler))
        .route("/ws", get(handlers::ws::ws_handler))
        .fallback(|| async { (StatusCode::NOT_FOUND, "Not found. Use / or /status, /health, /api/*, or /ws for WebSocket.") })
        .layer(CorsLayer::permissive())
        .layer(TraceLayer::new_for_http())
        .with_state(state);

    let listener = tokio::net::TcpListener::bind(&addr).await.expect("bind");
    info!("Beacon listening on http://{}", addr);
    info!("WebSocket endpoint: ws://{}/ws", addr);
    info!("REST API: http://{}/api/servers/{{signing_pubkey}}/... (server hints)", addr);
    info!("Health check: http://{}/health", addr);

    let graceful = axum::serve(listener, app).with_graceful_shutdown(async {
        tokio::signal::ctrl_c().await.ok();
        write_last_stop_file();
    });

    if let Err(e) = graceful.await {
        error!("Server error: {}", e);
    }
}
