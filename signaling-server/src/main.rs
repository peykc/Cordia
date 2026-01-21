// Allow unused code during WebRTC scaffolding phase
#![allow(dead_code, unused_variables)]

use std::collections::{HashMap, HashSet};
use std::net::SocketAddr;
use std::sync::Arc;

use chrono::{DateTime, Duration, Utc};
use futures_util::{SinkExt, StreamExt};
use hyper::service::{make_service_fn, service_fn};
use hyper::{Body, Method, Request, Response, Server, StatusCode};
use log::{error, info, warn};
use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;
use tokio::sync::mpsc;

#[cfg(feature = "postgres")]
use sqlx::{PgPool, postgres::PgPoolOptions, Row};
#[cfg(feature = "redis-backend")]
use redis::AsyncCommands;

type PeerId = String;
type HouseId = String;
type SigningPubkey = String;
type WebSocketSender = mpsc::UnboundedSender<hyper_tungstenite::tungstenite::Message>;
type ConnId = String;

fn decode_path_segment(seg: &str) -> String {
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
enum SignalingMessage {
    /// Client registers with house_id and peer_id
    Register {
        house_id: HouseId,
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
    /// Broadcast when a new member joins the house
    HouseMemberJoined {
        house_id: HouseId,
        member_user_id: String,
        member_display_name: String,
    },

    /// Broadcast when a house hint (snapshot) is updated via REST API
    HouseHintUpdated {
        signing_pubkey: SigningPubkey,
        encrypted_state: String,
        signature: String,
        last_updated: DateTime<Utc>,
    },

    // ============================
    // Presence (online/offline + active house)
    // ============================

    /// Client declares it is online for a set of houses and optionally which house is currently active.
    PresenceHello {
        user_id: String,
        signing_pubkeys: Vec<SigningPubkey>,
        #[serde(default)]
        active_signing_pubkey: Option<SigningPubkey>,
    },

    /// Client updates which house is currently active (or clears it to indicate "neighborhood").
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

    /// Client asks for the latest known profile metadata for a set of user_ids relevant to a house.
    /// (House member lists are opaque to the server, so clients provide the user_ids they care about.)
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

    /// Client registers for voice in a specific room
    VoiceRegister {
        house_id: HouseId,
        room_id: String,
        peer_id: PeerId,      // Ephemeral session ID (UUID per join)
        user_id: String,      // Stable identity (public key hash)
    },

    /// Server response to voice registration
    VoiceRegistered {
        peer_id: PeerId,
        room_id: String,
        peers: Vec<VoicePeerInfo>,  // Other peers in this room only
    },

    /// Client unregisters from voice
    VoiceUnregister {
        peer_id: PeerId,
        room_id: String,
    },

    /// Broadcast when a peer joins voice in a room
    VoicePeerJoined {
        peer_id: PeerId,
        user_id: String,
        room_id: String,
    },

    /// Broadcast when a peer leaves voice in a room
    VoicePeerLeft {
        peer_id: PeerId,
        user_id: String,
        room_id: String,
    },

    /// Voice SDP offer (room-scoped)
    VoiceOffer {
        from_peer: PeerId,
        from_user: String,
        to_peer: PeerId,
        room_id: String,
        sdp: String,
    },

    /// Voice SDP answer (room-scoped)
    VoiceAnswer {
        from_peer: PeerId,
        from_user: String,
        to_peer: PeerId,
        room_id: String,
        sdp: String,
    },

    /// Voice ICE candidate (room-scoped)
    VoiceIceCandidate {
        from_peer: PeerId,
        to_peer: PeerId,
        room_id: String,
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
struct ProfileSnapshotRecord {
    user_id: String,
    display_name: String,
    #[serde(default)]
    real_name: Option<String>,
    #[serde(default)]
    show_real_name: bool,
    rev: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct PresenceUserStatus {
    user_id: String,
    #[serde(default)]
    active_signing_pubkey: Option<SigningPubkey>,
}

/// Info about a peer in a voice room (sent to other peers)
#[derive(Debug, Clone, Serialize, Deserialize)]
struct VoicePeerInfo {
    peer_id: PeerId,
    user_id: String,
}

/// Internal tracking for a voice peer
#[derive(Debug, Clone)]
struct VoicePeer {
    peer_id: PeerId,
    user_id: String,
    conn_id: ConnId,  // For cleanup on WebSocket disconnect
}

// ============================================
// Event Queue Types (REST API)
// ============================================

/// House hint - NOT authoritative, just a cache/recovery aid
/// Any member can overwrite at any time (no creator lock)
#[derive(Debug, Clone, Serialize, Deserialize)]
struct EncryptedHouseHint {
    signing_pubkey: String,
    encrypted_state: String,  // Server cannot decrypt
    signature: String,        // Signed by member's Ed25519 key
    last_updated: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct InviteTokenCreateRequest {
    code: String,
    max_uses: u32, // 0 = unlimited
    encrypted_payload: String, // Server cannot decrypt
    signature: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct InviteTokenRecord {
    code: String,
    signing_pubkey: String,
    encrypted_payload: String,
    signature: String,
    created_at: DateTime<Utc>,
    expires_at: DateTime<Utc>,
    max_uses: u32,
    remaining_uses: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct HouseEvent {
    event_id: String,
    signing_pubkey: String,
    event_type: String,        // "MemberJoin", "MemberLeave", "NameChange"
    encrypted_payload: String, // Server cannot decrypt
    signature: String,         // Signed by member's Ed25519 key
    timestamp: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct AckRequest {
    user_id: String,
    last_event_id: String,
}

// ============================================
// Server State
// ============================================

/// Connection info for each peer
#[derive(Debug, Clone)]
struct PeerConnection {
    peer_id: PeerId,
    house_id: HouseId,
    signing_pubkey: Option<SigningPubkey>,
}

#[derive(Debug, Clone)]
struct PresenceConn {
    user_id: String,
    signing_pubkeys: HashSet<SigningPubkey>,
}

#[derive(Debug, Clone)]
struct PresenceUser {
    conns: HashSet<ConnId>,
    signing_pubkeys: HashSet<SigningPubkey>,
    active_signing_pubkey: Option<SigningPubkey>,
}

#[derive(Debug, Clone)]
struct ProfileRecord {
    display_name: String,
    real_name: Option<String>,
    show_real_name: bool,
    rev: i64,
}

#[cfg(feature = "postgres")]
async fn init_db(pool: &PgPool) -> Result<(), String> {
    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS profiles (
          user_id TEXT PRIMARY KEY,
          display_name TEXT NOT NULL,
          real_name TEXT,
          show_real_name BOOLEAN NOT NULL,
          rev BIGINT NOT NULL,
          updated_at TIMESTAMPTZ NOT NULL
        );
        "#,
    )
    .execute(pool)
    .await
    .map_err(|e| format!("init_db profiles: {}", e))?;

    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS house_hints (
          signing_pubkey TEXT PRIMARY KEY,
          encrypted_state TEXT NOT NULL,
          signature TEXT NOT NULL,
          last_updated TIMESTAMPTZ NOT NULL
        );
        "#,
    )
    .execute(pool)
    .await
    .map_err(|e| format!("init_db house_hints: {}", e))?;

    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS invite_tokens (
          code TEXT PRIMARY KEY,
          signing_pubkey TEXT NOT NULL,
          encrypted_payload TEXT NOT NULL,
          signature TEXT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL,
          expires_at TIMESTAMPTZ NOT NULL,
          max_uses INTEGER NOT NULL,
          remaining_uses INTEGER NOT NULL
        );
        "#,
    )
    .execute(pool)
    .await
    .map_err(|e| format!("init_db invite_tokens: {}", e))?;

    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS house_events (
          event_id TEXT PRIMARY KEY,
          signing_pubkey TEXT NOT NULL,
          event_type TEXT NOT NULL,
          encrypted_payload TEXT NOT NULL,
          signature TEXT NOT NULL,
          timestamp TIMESTAMPTZ NOT NULL
        );
        "#,
    )
    .execute(pool)
    .await
    .map_err(|e| format!("init_db house_events: {}", e))?;

    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS member_acks (
          signing_pubkey TEXT NOT NULL,
          user_id TEXT NOT NULL,
          last_event_id TEXT NOT NULL,
          updated_at TIMESTAMPTZ NOT NULL,
          PRIMARY KEY (signing_pubkey, user_id)
        );
        "#,
    )
    .execute(pool)
    .await
    .map_err(|e| format!("init_db member_acks: {}", e))?;
    Ok(())
}

#[cfg(feature = "postgres")]
async fn upsert_profile_db(pool: &PgPool, user_id: &str, rec: &ProfileRecord) -> Result<(), String> {
    sqlx::query(
        r#"
        INSERT INTO profiles (user_id, display_name, real_name, show_real_name, rev, updated_at)
        VALUES ($1, $2, $3, $4, $5, NOW())
        ON CONFLICT (user_id) DO UPDATE
        SET display_name = EXCLUDED.display_name,
            real_name = EXCLUDED.real_name,
            show_real_name = EXCLUDED.show_real_name,
            rev = EXCLUDED.rev,
            updated_at = NOW()
        WHERE profiles.rev < EXCLUDED.rev;
        "#,
    )
    .bind(user_id)
    .bind(&rec.display_name)
    .bind(&rec.real_name)
    .bind(rec.show_real_name)
    .bind(rec.rev)
    .execute(pool)
    .await
    .map_err(|e| format!("upsert_profile_db: {}", e))?;
    Ok(())
}

#[cfg(feature = "postgres")]
async fn load_profiles_db(pool: &PgPool, user_ids: &[String]) -> Result<Vec<ProfileSnapshotRecord>, String> {
    // NOTE: We intentionally don’t expose updated_at; rev is the authoritative ordering.
    let rows = sqlx::query(
        r#"
        SELECT user_id, display_name, real_name, show_real_name, rev
        FROM profiles
        WHERE user_id = ANY($1)
        "#,
    )
    .bind(user_ids)
    .fetch_all(pool)
    .await
    .map_err(|e| format!("load_profiles_db: {}", e))?;

    let mut out = Vec::with_capacity(rows.len());
    for row in rows {
        out.push(ProfileSnapshotRecord {
            user_id: row.try_get("user_id").map_err(|e| format!("load_profiles_db user_id: {}", e))?,
            display_name: row
                .try_get("display_name")
                .map_err(|e| format!("load_profiles_db display_name: {}", e))?,
            real_name: row
                .try_get::<Option<String>, _>("real_name")
                .map_err(|e| format!("load_profiles_db real_name: {}", e))?,
            show_real_name: row
                .try_get("show_real_name")
                .map_err(|e| format!("load_profiles_db show_real_name: {}", e))?,
            rev: row.try_get("rev").map_err(|e| format!("load_profiles_db rev: {}", e))?,
        });
    }
    Ok(out)
}

#[cfg(feature = "postgres")]
async fn upsert_house_hint_db(pool: &PgPool, hint: &EncryptedHouseHint) -> Result<(), String> {
    sqlx::query(
        r#"
        INSERT INTO house_hints (signing_pubkey, encrypted_state, signature, last_updated)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (signing_pubkey) DO UPDATE
        SET encrypted_state = EXCLUDED.encrypted_state,
            signature = EXCLUDED.signature,
            last_updated = EXCLUDED.last_updated;
        "#,
    )
    .bind(&hint.signing_pubkey)
    .bind(&hint.encrypted_state)
    .bind(&hint.signature)
    .bind(hint.last_updated)
    .execute(pool)
    .await
    .map_err(|e| format!("upsert_house_hint_db: {}", e))?;
    Ok(())
}

#[cfg(feature = "postgres")]
async fn get_house_hint_db(pool: &PgPool, signing_pubkey: &str) -> Result<Option<EncryptedHouseHint>, String> {
    let row = sqlx::query(
        r#"
        SELECT signing_pubkey, encrypted_state, signature, last_updated
        FROM house_hints
        WHERE signing_pubkey = $1
        "#,
    )
    .bind(signing_pubkey)
    .fetch_optional(pool)
    .await
    .map_err(|e| format!("get_house_hint_db: {}", e))?;

    Ok(row.map(|r| EncryptedHouseHint {
        signing_pubkey: r.try_get("signing_pubkey").unwrap_or_default(),
        encrypted_state: r.try_get("encrypted_state").unwrap_or_default(),
        signature: r.try_get("signature").unwrap_or_default(),
        last_updated: r.try_get("last_updated").unwrap_or_else(|_| Utc::now()),
    }))
}

#[cfg(feature = "postgres")]
async fn gc_expired_invites_db(pool: &PgPool) -> Result<(), String> {
    sqlx::query("DELETE FROM invite_tokens WHERE expires_at <= NOW()")
        .execute(pool)
        .await
        .map_err(|e| format!("gc_expired_invites_db: {}", e))?;
    Ok(())
}

#[cfg(feature = "postgres")]
async fn upsert_invite_db(pool: &PgPool, signing_pubkey: &str, req: InviteTokenCreateRequest) -> Result<InviteTokenRecord, String> {
    let code = req.code.trim().to_string();
    if code.len() < 10 || code.len() > 64 {
        return Err("Invalid invite code length".to_string());
    }
    let now = Utc::now();
    let expires_at = now + Duration::days(30);
    let max_uses = req.max_uses;
    let remaining_uses = req.max_uses;

    sqlx::query(
        r#"
        INSERT INTO invite_tokens (code, signing_pubkey, encrypted_payload, signature, created_at, expires_at, max_uses, remaining_uses)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        ON CONFLICT (code) DO UPDATE
        SET signing_pubkey = EXCLUDED.signing_pubkey,
            encrypted_payload = EXCLUDED.encrypted_payload,
            signature = EXCLUDED.signature,
            created_at = EXCLUDED.created_at,
            expires_at = EXCLUDED.expires_at,
            max_uses = EXCLUDED.max_uses,
            remaining_uses = EXCLUDED.remaining_uses;
        "#,
    )
    .bind(&code)
    .bind(signing_pubkey)
    .bind(&req.encrypted_payload)
    .bind(&req.signature)
    .bind(now)
    .bind(expires_at)
    .bind(max_uses as i32)
    .bind(remaining_uses as i32)
    .execute(pool)
    .await
    .map_err(|e| format!("upsert_invite_db: {}", e))?;

    Ok(InviteTokenRecord {
        code,
        signing_pubkey: signing_pubkey.to_string(),
        encrypted_payload: req.encrypted_payload,
        signature: req.signature,
        created_at: now,
        expires_at,
        max_uses,
        remaining_uses,
    })
}

#[cfg(feature = "postgres")]
async fn get_invite_db(pool: &PgPool, code: &str) -> Result<Option<InviteTokenRecord>, String> {
    let row = sqlx::query(
        r#"
        SELECT code, signing_pubkey, encrypted_payload, signature, created_at, expires_at, max_uses, remaining_uses
        FROM invite_tokens
        WHERE code = $1 AND expires_at > NOW()
        "#,
    )
    .bind(code)
    .fetch_optional(pool)
    .await
    .map_err(|e| format!("get_invite_db: {}", e))?;

    Ok(row.map(|r| InviteTokenRecord {
        code: r.try_get("code").unwrap_or_default(),
        signing_pubkey: r.try_get("signing_pubkey").unwrap_or_default(),
        encrypted_payload: r.try_get("encrypted_payload").unwrap_or_default(),
        signature: r.try_get("signature").unwrap_or_default(),
        created_at: r.try_get("created_at").unwrap_or_else(|_| Utc::now()),
        expires_at: r.try_get("expires_at").unwrap_or_else(|_| Utc::now()),
        max_uses: r.try_get::<i32, _>("max_uses").unwrap_or(0) as u32,
        remaining_uses: r.try_get::<i32, _>("remaining_uses").unwrap_or(0) as u32,
    }))
}

#[cfg(feature = "postgres")]
async fn redeem_invite_db(pool: &PgPool, code: &str) -> Result<Option<InviteTokenRecord>, String> {
    let row = sqlx::query(
        r#"
        UPDATE invite_tokens
        SET remaining_uses = CASE WHEN max_uses = 0 THEN remaining_uses ELSE remaining_uses - 1 END
        WHERE code = $1
          AND expires_at > NOW()
          AND (max_uses = 0 OR remaining_uses > 0)
        RETURNING code, signing_pubkey, encrypted_payload, signature, created_at, expires_at, max_uses, remaining_uses
        "#,
    )
    .bind(code)
    .fetch_optional(pool)
    .await
    .map_err(|e| format!("redeem_invite_db: {}", e))?;

    Ok(row.map(|r| InviteTokenRecord {
        code: r.try_get("code").unwrap_or_default(),
        signing_pubkey: r.try_get("signing_pubkey").unwrap_or_default(),
        encrypted_payload: r.try_get("encrypted_payload").unwrap_or_default(),
        signature: r.try_get("signature").unwrap_or_default(),
        created_at: r.try_get("created_at").unwrap_or_else(|_| Utc::now()),
        expires_at: r.try_get("expires_at").unwrap_or_else(|_| Utc::now()),
        max_uses: r.try_get::<i32, _>("max_uses").unwrap_or(0) as u32,
        remaining_uses: r.try_get::<i32, _>("remaining_uses").unwrap_or(0) as u32,
    }))
}

#[cfg(feature = "postgres")]
async fn revoke_invite_db(pool: &PgPool, code: &str) -> Result<bool, String> {
    let res = sqlx::query("DELETE FROM invite_tokens WHERE code = $1")
        .bind(code)
        .execute(pool)
        .await
        .map_err(|e| format!("revoke_invite_db: {}", e))?;
    Ok(res.rows_affected() > 0)
}

#[cfg(feature = "postgres")]
async fn insert_event_db(pool: &PgPool, event: &HouseEvent) -> Result<(), String> {
    sqlx::query(
        r#"
        INSERT INTO house_events (event_id, signing_pubkey, event_type, encrypted_payload, signature, timestamp)
        VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT (event_id) DO NOTHING;
        "#,
    )
    .bind(&event.event_id)
    .bind(&event.signing_pubkey)
    .bind(&event.event_type)
    .bind(&event.encrypted_payload)
    .bind(&event.signature)
    .bind(event.timestamp)
    .execute(pool)
    .await
    .map_err(|e| format!("insert_event_db: {}", e))?;
    Ok(())
}

#[cfg(feature = "postgres")]
async fn get_event_timestamp_db(pool: &PgPool, signing_pubkey: &str, event_id: &str) -> Result<Option<DateTime<Utc>>, String> {
    let row = sqlx::query(
        r#"
        SELECT timestamp
        FROM house_events
        WHERE signing_pubkey = $1 AND event_id = $2
        "#,
    )
    .bind(signing_pubkey)
    .bind(event_id)
    .fetch_optional(pool)
    .await
    .map_err(|e| format!("get_event_timestamp_db: {}", e))?;

    Ok(row.and_then(|r| r.try_get("timestamp").ok()))
}

#[cfg(feature = "postgres")]
async fn get_events_db(pool: &PgPool, signing_pubkey: &str, since: Option<&str>) -> Result<Vec<HouseEvent>, String> {
    let rows = if let Some(since_id) = since {
        let Some(since_ts) = get_event_timestamp_db(pool, signing_pubkey, since_id).await? else {
            return Ok(Vec::new());
        };
        sqlx::query(
            r#"
            SELECT event_id, signing_pubkey, event_type, encrypted_payload, signature, timestamp
            FROM house_events
            WHERE signing_pubkey = $1
              AND (timestamp > $2 OR (timestamp = $2 AND event_id > $3))
            ORDER BY timestamp ASC, event_id ASC
            "#,
        )
        .bind(signing_pubkey)
        .bind(since_ts)
        .bind(since_id)
        .fetch_all(pool)
        .await
        .map_err(|e| format!("get_events_db since: {}", e))?
    } else {
        sqlx::query(
            r#"
            SELECT event_id, signing_pubkey, event_type, encrypted_payload, signature, timestamp
            FROM house_events
            WHERE signing_pubkey = $1
            ORDER BY timestamp ASC, event_id ASC
            "#,
        )
        .bind(signing_pubkey)
        .fetch_all(pool)
        .await
        .map_err(|e| format!("get_events_db: {}", e))?
    };

    let mut out = Vec::with_capacity(rows.len());
    for row in rows {
        out.push(HouseEvent {
            event_id: row.try_get("event_id").unwrap_or_default(),
            signing_pubkey: row.try_get("signing_pubkey").unwrap_or_default(),
            event_type: row.try_get("event_type").unwrap_or_default(),
            encrypted_payload: row.try_get("encrypted_payload").unwrap_or_default(),
            signature: row.try_get("signature").unwrap_or_default(),
            timestamp: row.try_get("timestamp").unwrap_or_else(|_| Utc::now()),
        });
    }
    Ok(out)
}

#[cfg(feature = "postgres")]
async fn ack_events_db(pool: &PgPool, signing_pubkey: &str, user_id: &str, last_event_id: &str) -> Result<(), String> {
    sqlx::query(
        r#"
        INSERT INTO member_acks (signing_pubkey, user_id, last_event_id, updated_at)
        VALUES ($1, $2, $3, NOW())
        ON CONFLICT (signing_pubkey, user_id) DO UPDATE
        SET last_event_id = EXCLUDED.last_event_id,
            updated_at = NOW();
        "#,
    )
    .bind(signing_pubkey)
    .bind(user_id)
    .bind(last_event_id)
    .execute(pool)
    .await
    .map_err(|e| format!("ack_events_db: {}", e))?;
    Ok(())
}

#[cfg(feature = "postgres")]
async fn gc_old_events_db(pool: &PgPool, cutoff: DateTime<Utc>) -> Result<(), String> {
    sqlx::query("DELETE FROM house_events WHERE timestamp <= $1")
        .bind(cutoff)
        .execute(pool)
        .await
        .map_err(|e| format!("gc_old_events_db: {}", e))?;
    Ok(())
}

#[cfg(feature = "redis-backend")]
fn redis_user_key(user_id: &str) -> String {
    format!("presence:user:{}", user_id)
}

#[cfg(feature = "redis-backend")]
fn redis_house_key(signing_pubkey: &str) -> String {
    format!("presence:house:{}", signing_pubkey)
}

#[cfg(feature = "redis-backend")]
async fn redis_presence_hello(
    client: &redis::Client,
    ttl_secs: u64,
    user_id: &str,
    signing_pubkeys: &[SigningPubkey],
    active_signing_pubkey: &Option<SigningPubkey>,
) -> Result<(), String> {
    let mut conn = client
        .get_multiplexed_tokio_connection()
        .await
        .map_err(|e| format!("redis_presence_hello conn: {}", e))?;
    let user_key = redis_user_key(user_id);
    let active_value = active_signing_pubkey.clone().unwrap_or_default();

    let mut pipe = redis::pipe();
    pipe.hset(&user_key, "active_signing_pubkey", active_value)
        .expire(&user_key, ttl_secs as i64);
    for spk in signing_pubkeys {
        let house_key = redis_house_key(spk);
        pipe.sadd(house_key, user_id);
    }
    pipe.query_async::<_, ()>(&mut conn)
        .await
        .map_err(|e| format!("redis_presence_hello query: {}", e))?;
    Ok(())
}

#[cfg(feature = "redis-backend")]
async fn redis_presence_active(
    client: &redis::Client,
    ttl_secs: u64,
    user_id: &str,
    active_signing_pubkey: &Option<SigningPubkey>,
) -> Result<(), String> {
    let mut conn = client
        .get_multiplexed_tokio_connection()
        .await
        .map_err(|e| format!("redis_presence_active conn: {}", e))?;
    let user_key = redis_user_key(user_id);
    let active_value = active_signing_pubkey.clone().unwrap_or_default();
    let mut pipe = redis::pipe();
    pipe.hset(&user_key, "active_signing_pubkey", active_value)
        .expire(&user_key, ttl_secs as i64);
    pipe.query_async::<_, ()>(&mut conn)
        .await
        .map_err(|e| format!("redis_presence_active query: {}", e))?;
    Ok(())
}

#[cfg(feature = "redis-backend")]
async fn redis_presence_disconnect(
    client: &redis::Client,
    user_id: &str,
    signing_pubkeys: &[SigningPubkey],
) -> Result<(), String> {
    let mut conn = client
        .get_multiplexed_tokio_connection()
        .await
        .map_err(|e| format!("redis_presence_disconnect conn: {}", e))?;
    let user_key = redis_user_key(user_id);
    let mut pipe = redis::pipe();
    pipe.del(&user_key);
    for spk in signing_pubkeys {
        let house_key = redis_house_key(spk);
        pipe.srem(house_key, user_id);
    }
    pipe.query_async::<_, ()>(&mut conn)
        .await
        .map_err(|e| format!("redis_presence_disconnect query: {}", e))?;
    Ok(())
}

#[cfg(feature = "redis-backend")]
async fn redis_presence_snapshot(
    client: &redis::Client,
    signing_pubkey: &SigningPubkey,
) -> Result<Vec<PresenceUserStatus>, String> {
    let mut conn = client
        .get_multiplexed_tokio_connection()
        .await
        .map_err(|e| format!("redis_presence_snapshot conn: {}", e))?;
    let house_key = redis_house_key(signing_pubkey);
    let user_ids: Vec<String> = conn
        .smembers::<_, Vec<String>>(&house_key)
        .await
        .map_err(|e| format!("redis_presence_snapshot smembers: {}", e))?;
    if user_ids.is_empty() {
        return Ok(Vec::new());
    }

    let mut pipe = redis::pipe();
    for user_id in user_ids.iter() {
        let user_key = redis_user_key(user_id);
        pipe.hget(user_key, "active_signing_pubkey");
    }
    let active_values: Vec<Option<String>> = pipe
        .query_async::<_, Vec<Option<String>>>(&mut conn)
        .await
        .map_err(|e| format!("redis_presence_snapshot hget: {}", e))?;

    let mut out = Vec::new();
    let mut stale_users = Vec::new();
    for (user_id, active) in user_ids.into_iter().zip(active_values.into_iter()) {
        if let Some(active_value) = active {
            let active_signing_pubkey = if active_value.is_empty() {
                None
            } else {
                Some(active_value)
            };
            out.push(PresenceUserStatus {
                user_id,
                active_signing_pubkey,
            });
        } else {
            stale_users.push(user_id);
        }
    }

    if !stale_users.is_empty() {
        let _: () = redis::cmd("SREM")
            .arg(&house_key)
            .arg(stale_users)
            .query_async::<_, ()>(&mut conn)
            .await
            .map_err(|e| format!("redis_presence_snapshot cleanup: {}", e))?;
    }

    Ok(out)
}

#[cfg(feature = "redis-backend")]
async fn redis_presence_refresh(
    client: &redis::Client,
    ttl_secs: u64,
    users: &[(String, Vec<SigningPubkey>, Option<SigningPubkey>)],
) -> Result<(), String> {
    if users.is_empty() {
        return Ok(());
    }
    let mut conn = client
        .get_multiplexed_tokio_connection()
        .await
        .map_err(|e| format!("redis_presence_refresh conn: {}", e))?;
    let mut pipe = redis::pipe();
    for (user_id, spks, active) in users.iter() {
        let user_key = redis_user_key(user_id);
        let active_value = active.clone().unwrap_or_default();
        pipe.hset(&user_key, "active_signing_pubkey", active_value)
            .expire(&user_key, ttl_secs as i64);
        for spk in spks.iter() {
            let house_key = redis_house_key(spk);
            pipe.sadd(house_key, user_id);
        }
    }
    pipe.query_async::<_, ()>(&mut conn)
        .await
        .map_err(|e| format!("redis_presence_refresh query: {}", e))?;
    Ok(())
}

const EVENT_RETENTION_DAYS: i64 = 30;
#[cfg(feature = "redis-backend")]
const DEFAULT_REDIS_PRESENCE_TTL_SECS: u64 = 120;

/// Shared state across all connections
struct ServerState {
    // === WebSocket signaling state ===
    /// Map of peer_id -> PeerConnection
    peers: HashMap<PeerId, PeerConnection>,
    /// Map of house_id -> list of peer_ids in that house
    houses: HashMap<HouseId, Vec<PeerId>>,
    /// Map of signing_pubkey -> list of peer_ids subscribed to that house
    signing_houses: HashMap<SigningPubkey, Vec<PeerId>>,
    /// Map of peer_id -> WebSocket sender (for message forwarding)
    peer_senders: HashMap<PeerId, WebSocketSender>,

    /// Map of conn_id -> peer_ids registered on that websocket connection (allows correct cleanup)
    conn_peers: HashMap<ConnId, Vec<PeerId>>,

    // === Voice chat state (room-scoped) ===
    /// Map of (house_id, room_id) -> list of VoicePeers in that room
    voice_rooms: HashMap<(HouseId, String), Vec<VoicePeer>>,

    // === Presence state ===
    presence_conns: HashMap<ConnId, PresenceConn>,
    presence_users: HashMap<String, PresenceUser>,

    // Latest profile metadata per user (no media)
    profiles: HashMap<String, ProfileRecord>,

    // Optional durable backends
    #[cfg(feature = "postgres")]
    db: Option<PgPool>,
    #[cfg(feature = "redis-backend")]
    redis: Option<redis::Client>,
    #[cfg(feature = "redis-backend")]
    redis_presence_ttl_secs: u64,

    // === Event queue state (REST API) ===
    /// Hints only - clients treat local state as authoritative
    house_hints: HashMap<SigningPubkey, EncryptedHouseHint>,
    /// Temporary invite tokens (short code -> encrypted payload)
    invite_tokens: HashMap<String, InviteTokenRecord>,
    /// Event queue - time-limited, not consensus-based
    event_queues: HashMap<SigningPubkey, Vec<HouseEvent>>,
    /// Best-effort acks - soft tracking, not hard requirement
    member_acks: HashMap<(SigningPubkey, String), String>, // (signing_pubkey, user_id) -> last_event_id
}

impl ServerState {
    fn new() -> Self {
        Self {
            peers: HashMap::new(),
            houses: HashMap::new(),
            signing_houses: HashMap::new(),
            peer_senders: HashMap::new(),
            conn_peers: HashMap::new(),
            voice_rooms: HashMap::new(),
            presence_conns: HashMap::new(),
            presence_users: HashMap::new(),
            profiles: HashMap::new(),
            #[cfg(feature = "postgres")]
            db: None,
            #[cfg(feature = "redis-backend")]
            redis: None,
            #[cfg(feature = "redis-backend")]
            redis_presence_ttl_secs: DEFAULT_REDIS_PRESENCE_TTL_SECS,
            house_hints: HashMap::new(),
            invite_tokens: HashMap::new(),
            event_queues: HashMap::new(),
            member_acks: HashMap::new(),
        }
    }

    fn register_peer(
        &mut self,
        peer_id: PeerId,
        house_id: HouseId,
        signing_pubkey: Option<SigningPubkey>,
    ) -> Vec<PeerId> {
        // Add peer connection
        self.peers.insert(
            peer_id.clone(),
            PeerConnection {
                peer_id: peer_id.clone(),
                house_id: house_id.clone(),
                signing_pubkey: signing_pubkey.clone(),
            },
        );

        // Add peer to house
        let peers_in_house = self.houses.entry(house_id.clone()).or_insert_with(Vec::new);
        if !peers_in_house.contains(&peer_id) {
            peers_in_house.push(peer_id.clone());
        }

        // If a signing_pubkey was provided, treat this peer as subscribed for house-hint broadcasts
        if let Some(spk) = signing_pubkey {
            let peers_for_signing = self.signing_houses.entry(spk).or_insert_with(Vec::new);
            if !peers_for_signing.contains(&peer_id) {
                peers_for_signing.push(peer_id.clone());
            }
        }

        // Return other peers in the same house
        peers_in_house
            .iter()
            .filter(|p| **p != peer_id)
            .cloned()
            .collect()
    }

    fn unregister_peer(&mut self, peer_id: &PeerId) {
        if let Some(conn) = self.peers.remove(peer_id) {
            // Remove from house list
            if let Some(peers_in_house) = self.houses.get_mut(&conn.house_id) {
                peers_in_house.retain(|p| p != peer_id);
                if peers_in_house.is_empty() {
                    self.houses.remove(&conn.house_id);
                }
            }

            // Remove from signing house list (if subscribed)
            if let Some(spk) = conn.signing_pubkey {
                if let Some(peers_for_signing) = self.signing_houses.get_mut(&spk) {
                    peers_for_signing.retain(|p| p != peer_id);
                    if peers_for_signing.is_empty() {
                        self.signing_houses.remove(&spk);
                    }
                }
            }
        }
        // Remove WebSocket sender
        self.peer_senders.remove(peer_id);
    }

    fn broadcast_house_hint_updated(&self, signing_pubkey: &SigningPubkey, hint: &EncryptedHouseHint) {
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
                let _ = sender.send(hyper_tungstenite::tungstenite::Message::Text(json.clone()));
            }
        }
    }

    fn get_house(&self, peer_id: &PeerId) -> Option<HouseId> {
        self.peers.get(peer_id).map(|c| c.house_id.clone())
    }

    // === Event Queue Methods ===

    /// Register/update house hint (any member can call this at any time)
    fn register_house_hint(&mut self, signing_pubkey: String, hint: EncryptedHouseHint) {
        self.house_hints.insert(signing_pubkey, hint);
    }

    /// Get house hint
    fn get_house_hint(&self, signing_pubkey: &str) -> Option<&EncryptedHouseHint> {
        self.house_hints.get(signing_pubkey)
    }

    fn put_invite_token(&mut self, signing_pubkey: &str, req: InviteTokenCreateRequest) -> Result<InviteTokenRecord, String> {
        let code = req.code.trim().to_string();
        if code.len() < 10 || code.len() > 64 {
            return Err("Invalid invite code length".to_string());
        }
        let now = Utc::now();
        // Keep server-side cleanup; not user-facing.
        let expires_at = now + Duration::days(30);
        let max_uses = req.max_uses;
        let remaining_uses = req.max_uses; // 0 = unlimited
        let record = InviteTokenRecord {
            code: code.clone(),
            signing_pubkey: signing_pubkey.to_string(),
            encrypted_payload: req.encrypted_payload,
            signature: req.signature,
            created_at: now,
            expires_at,
            max_uses,
            remaining_uses,
        };
        self.invite_tokens.insert(code.clone(), record.clone());
        Ok(record)
    }

    fn get_invite_token(&self, code: &str) -> Option<&InviteTokenRecord> {
        self.invite_tokens.get(code)
    }

    fn redeem_invite_token(&mut self, code: &str) -> Option<InviteTokenRecord> {
        let Some(rec) = self.invite_tokens.get_mut(code) else {
            return None;
        };
        // unlimited
        if rec.max_uses == 0 {
            return Some(rec.clone());
        }
        if rec.remaining_uses == 0 {
            return None;
        }
        rec.remaining_uses = rec.remaining_uses.saturating_sub(1);
        Some(rec.clone())
    }

    fn gc_expired_invites(&mut self) {
        let now = Utc::now();
        self.invite_tokens.retain(|_, v| v.expires_at > now);
    }

    /// Post event to queue
    fn post_event(&mut self, signing_pubkey: String, mut event: HouseEvent) {
        event.timestamp = Utc::now();
        if event.event_id.is_empty() {
            event.event_id = uuid::Uuid::new_v4().to_string();
        }
        self.event_queues
            .entry(signing_pubkey)
            .or_insert_with(Vec::new)
            .push(event);
    }

    /// Get events since a given event ID
    fn get_events(&self, signing_pubkey: &str, since: Option<&str>) -> Vec<HouseEvent> {
        let events = match self.event_queues.get(signing_pubkey) {
            Some(events) => events.clone(),
            None => return Vec::new(),
        };

        if let Some(since_id) = since {
            events
                .into_iter()
                .skip_while(|e| e.event_id != since_id)
                .skip(1)
                .collect()
        } else {
            events
        }
    }

    /// Acknowledge events (best-effort)
    fn ack_events(&mut self, signing_pubkey: String, user_id: String, last_event_id: String) {
        self.member_acks.insert((signing_pubkey, user_id), last_event_id);
    }

    /// Garbage collect old events (called periodically)
    fn gc_old_events(&mut self) {
        let cutoff = Utc::now() - Duration::days(EVENT_RETENTION_DAYS);

        for events in self.event_queues.values_mut() {
            events.retain(|e| e.timestamp > cutoff);
        }

        // Also clean up empty queues
        self.event_queues.retain(|_, events| !events.is_empty());
    }

    fn broadcast_presence_update(&self, signing_pubkey: &SigningPubkey, user_id: &str, online: bool, active: Option<SigningPubkey>) {
        let Some(peers) = self.signing_houses.get(signing_pubkey) else {
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
            if let Some(sender) = self.peer_senders.get(peer_id) {
                let _ = sender.send(hyper_tungstenite::tungstenite::Message::Text(json.clone()));
            }
        }
    }

    fn presence_snapshot_for(&self, signing_pubkey: &SigningPubkey) -> Vec<PresenceUserStatus> {
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

    fn upsert_presence_hello(
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

    fn update_presence_active(&mut self, user_id: &str, active_signing_pubkey: Option<SigningPubkey>) -> Option<Vec<SigningPubkey>> {
        let u = self.presence_users.get_mut(user_id)?;
        u.active_signing_pubkey = active_signing_pubkey;
        Some(u.signing_pubkeys.iter().cloned().collect())
    }

    fn remove_presence_conn(&mut self, conn_id: &ConnId) -> Option<(String, Vec<SigningPubkey>)> {
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

    fn broadcast_profile_update(&self, signing_pubkey: &SigningPubkey, user_id: &str, rec: &ProfileRecord) {
        let Some(peers) = self.signing_houses.get(signing_pubkey) else {
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
            if let Some(sender) = self.peer_senders.get(peer_id) {
                let _ = sender.send(hyper_tungstenite::tungstenite::Message::Text(json.clone()));
            }
        }
    }

    // === Voice Chat Methods ===

    /// Register a peer for voice in a specific room.
    /// Returns list of other peers in the room.
    fn register_voice_peer(
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
    fn unregister_voice_peer(&mut self, peer_id: &PeerId, house_id: &HouseId, room_id: &str) -> Option<String> {
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
    fn handle_voice_disconnect(&mut self, conn_id: &ConnId) -> Vec<(HouseId, String, PeerId, String)> {
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

    /// Broadcast a message to all peers in a voice room (except optionally one peer).
    fn broadcast_to_voice_room(&self, house_id: &HouseId, room_id: &str, msg: &SignalingMessage, exclude_peer: Option<&PeerId>) {
        let key = (house_id.clone(), room_id.to_string());
        let Some(peers) = self.voice_rooms.get(&key) else {
            return;
        };

        let Ok(json) = serde_json::to_string(msg) else {
            return;
        };

        for peer in peers {
            // Skip excluded peer
            if let Some(excluded) = exclude_peer {
                if &peer.peer_id == excluded {
                    continue;
                }
            }

            if let Some(sender) = self.peer_senders.get(&peer.peer_id) {
                let _ = sender.send(hyper_tungstenite::tungstenite::Message::Text(json.clone()));
            }
        }
    }

    /// Broadcast a message to all peers in a house (for house-wide presence).
    fn broadcast_to_house(&self, house_id: &HouseId, msg: &SignalingMessage, exclude_peer: Option<&PeerId>) {
        let Some(peers) = self.houses.get(house_id) else {
            return;
        };

        let Ok(json) = serde_json::to_string(msg) else {
            return;
        };

        for peer_id in peers {
            // Skip excluded peer
            if let Some(excluded) = exclude_peer {
                if peer_id == excluded {
                    continue;
                }
            }

            if let Some(sender) = self.peer_senders.get(peer_id) {
                let _ = sender.send(hyper_tungstenite::tungstenite::Message::Text(json.clone()));
            }
        }
    }

    /// Get the sender for a specific peer in a voice room (for targeted messages).
    fn get_voice_peer_sender(&self, house_id: &HouseId, room_id: &str, peer_id: &PeerId) -> Option<&WebSocketSender> {
        let key = (house_id.clone(), room_id.to_string());
        let peers = self.voice_rooms.get(&key)?;

        // Verify peer is in this room
        if !peers.iter().any(|p| &p.peer_id == peer_id) {
            return None;
        }

        self.peer_senders.get(peer_id)
    }
}

type SharedState = Arc<Mutex<ServerState>>;

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
    let (presence_removed, voice_removed, redis_client) = {
        let mut state = state.lock().await;

        if let Some(peer_ids) = state.conn_peers.remove(&conn_id) {
            for peer_id in peer_ids {
                state.unregister_peer(&peer_id);
            }
        }

        // Handle voice disconnect
        let voice_removed = state.handle_voice_disconnect(&conn_id);

        let presence_removed = state.remove_presence_conn(&conn_id);
        #[cfg(feature = "redis-backend")]
        let redis_client = state.redis.clone();
        #[cfg(not(feature = "redis-backend"))]
        let redis_client: Option<()> = None;

        (presence_removed, voice_removed, redis_client)
    };

    // Broadcast VoicePeerLeft to remaining peers in each affected room
    if !voice_removed.is_empty() {
        let state = state.lock().await;
        for (house_id, room_id, peer_id, user_id) in voice_removed {
            info!("Voice peer {} (user {}) disconnected from room {}", peer_id, user_id, room_id);
            let msg = SignalingMessage::VoicePeerLeft {
                peer_id,
                user_id,
                room_id: room_id.clone(),
            };
            // Broadcast to voice room
            state.broadcast_to_voice_room(&house_id, &room_id, &msg, None);
            // Also broadcast to entire house for presence visibility
            state.broadcast_to_house(&house_id, &msg, None);
        }
    }

    if let Some((user_id, spks)) = presence_removed {
        #[cfg(feature = "redis-backend")]
        if let Some(client) = redis_client.as_ref() {
            if let Err(e) = redis_presence_disconnect(client, &user_id, &spks).await {
                warn!("Redis presence disconnect failed: {}", e);
            }
        }

        let state = state.lock().await;
        for spk in spks {
            state.broadcast_presence_update(&spk, &user_id, false, None);
        }
    }

    send_task.abort();
}

async fn handle_message(
    msg: SignalingMessage,
    conn_id: &ConnId,
    state: &SharedState,
    sender: &WebSocketSender,
) -> Result<(), String> {
    match msg {
        SignalingMessage::Register { house_id, peer_id, signing_pubkey } => {
            let mut state = state.lock().await;
            let peers = state.register_peer(peer_id.clone(), house_id.clone(), signing_pubkey);

            // Store the sender for this peer
            state.peer_senders.insert(peer_id.clone(), sender.clone());

            // Track all peer_ids for this ws connection (fixes leaks when a single ws registers multiple peer_ids).
            state
                .conn_peers
                .entry(conn_id.clone())
                .or_insert_with(Vec::new)
                .push(peer_id.clone());

            info!("Registered peer {} in house {}", peer_id, house_id);

            let response = SignalingMessage::Registered {
                peer_id: peer_id.clone(),
                peers,
            };

            let json = serde_json::to_string(&response)
                .map_err(|e| format!("Failed to serialize response: {}", e))?;

            sender
                .send(hyper_tungstenite::tungstenite::Message::Text(json))
                .map_err(|e| format!("Failed to send response: {}", e))?;

            Ok(())
        }
        SignalingMessage::PresenceHello { user_id, signing_pubkeys, active_signing_pubkey } => {
            let (affected_spks, redis_client, redis_ttl, local_snaps) = {
                let mut st = state.lock().await;
                // Upsert presence
                let affected_spks = st.upsert_presence_hello(conn_id, user_id.clone(), signing_pubkeys.clone(), active_signing_pubkey.clone());
                #[cfg(feature = "redis-backend")]
                let redis_client = st.redis.clone();
                #[cfg(not(feature = "redis-backend"))]
                let redis_client: Option<()> = None;
                #[cfg(feature = "redis-backend")]
                let redis_ttl = st.redis_presence_ttl_secs;
                #[cfg(not(feature = "redis-backend"))]
                let redis_ttl: u64 = 0;

                let local_snaps: Vec<(SigningPubkey, Vec<PresenceUserStatus>)> = if redis_client.is_none() {
                    signing_pubkeys
                        .iter()
                        .map(|spk| (spk.clone(), st.presence_snapshot_for(spk)))
                        .collect()
                } else {
                    Vec::new()
                };
                (affected_spks, redis_client, redis_ttl, local_snaps)
            };

            #[cfg(feature = "redis-backend")]
            if let Some(client) = redis_client.as_ref() {
                if let Err(e) = redis_presence_hello(client, redis_ttl, &user_id, &signing_pubkeys, &active_signing_pubkey).await {
                    warn!("Redis presence hello failed: {}", e);
                }
                for spk in signing_pubkeys.iter() {
                    let users = redis_presence_snapshot(client, spk).await.unwrap_or_default();
                    let snap = SignalingMessage::PresenceSnapshot {
                        signing_pubkey: spk.clone(),
                        users,
                    };
                    if let Ok(json) = serde_json::to_string(&snap) {
                        let _ = sender.send(hyper_tungstenite::tungstenite::Message::Text(json));
                    }
                }
            } else {
                for (spk, users) in local_snaps {
                    let snap = SignalingMessage::PresenceSnapshot {
                        signing_pubkey: spk,
                        users,
                    };
                    if let Ok(json) = serde_json::to_string(&snap) {
                        let _ = sender.send(hyper_tungstenite::tungstenite::Message::Text(json));
                    }
                }
            }

            #[cfg(not(feature = "redis-backend"))]
            {
                for (spk, users) in local_snaps {
                    let snap = SignalingMessage::PresenceSnapshot {
                        signing_pubkey: spk,
                        users,
                    };
                    if let Ok(json) = serde_json::to_string(&snap) {
                        let _ = sender.send(hyper_tungstenite::tungstenite::Message::Text(json));
                    }
                }
            }

            // Broadcast this user's presence to relevant houses
            {
                let st = state.lock().await;
                for spk in affected_spks {
                    st.broadcast_presence_update(&spk, &user_id, true, active_signing_pubkey.clone());
                }
            }

            Ok(())
        }
        SignalingMessage::PresenceActive { user_id, active_signing_pubkey } => {
            let (spks, redis_client, redis_ttl) = {
                let mut st = state.lock().await;
                let spks = st.update_presence_active(&user_id, active_signing_pubkey.clone());
                #[cfg(feature = "redis-backend")]
                let redis_client = st.redis.clone();
                #[cfg(not(feature = "redis-backend"))]
                let redis_client: Option<()> = None;
                #[cfg(feature = "redis-backend")]
                let redis_ttl = st.redis_presence_ttl_secs;
                #[cfg(not(feature = "redis-backend"))]
                let redis_ttl: u64 = 0;
                (spks, redis_client, redis_ttl)
            };

            #[cfg(feature = "redis-backend")]
            if let Some(client) = redis_client.as_ref() {
                if let Err(e) = redis_presence_active(client, redis_ttl, &user_id, &active_signing_pubkey).await {
                    warn!("Redis presence active failed: {}", e);
                }
            }

            if let Some(spks) = spks {
                let st = state.lock().await;
                for spk in spks {
                    st.broadcast_presence_update(&spk, &user_id, true, active_signing_pubkey.clone());
                }
            }
            Ok(())
        }
        SignalingMessage::ProfileAnnounce { user_id, display_name, real_name, show_real_name, rev, signing_pubkeys } => {
            let (rec_opt, db_opt) = {
                let mut st = state.lock().await;
                let update = match st.profiles.get(&user_id) {
                    Some(existing) => rev > existing.rev,
                    None => true,
                };

                if update {
                    st.profiles.insert(
                        user_id.clone(),
                        ProfileRecord {
                            display_name: display_name.clone(),
                            real_name: real_name.clone(),
                            show_real_name,
                            rev,
                        },
                    );
                }

                let rec = st.profiles.get(&user_id).cloned();
                if let Some(ref r) = rec {
                    for spk in signing_pubkeys.iter() {
                        st.broadcast_profile_update(spk, &user_id, r);
                    }
                }

                #[cfg(feature = "postgres")]
                let db = st.db.clone();
                #[cfg(not(feature = "postgres"))]
                let db: Option<()> = None;

                (rec, db)
            };

            // Persist the latest profile so offline users can catch up even after restarts.
            #[cfg(feature = "postgres")]
            if let (Some(pool), Some(rec)) = (db_opt, rec_opt.as_ref()) {
                let _ = upsert_profile_db(&pool, &user_id, rec).await;
            }

            Ok(())
        }
        SignalingMessage::ProfileHello { signing_pubkey, user_ids } => {
            // Prefer DB if available; otherwise fall back to in-memory cache.
            #[cfg(feature = "postgres")]
            let db = { state.lock().await.db.clone() };

            #[cfg(feature = "postgres")]
            let out: Vec<ProfileSnapshotRecord> = if let Some(pool) = db {
                load_profiles_db(&pool, &user_ids).await.unwrap_or_default()
            } else {
                let st = state.lock().await;
                user_ids
                    .iter()
                    .filter_map(|uid| st.profiles.get(uid).map(|rec| ProfileSnapshotRecord {
                        user_id: uid.clone(),
                        display_name: rec.display_name.clone(),
                        real_name: rec.real_name.clone(),
                        show_real_name: rec.show_real_name,
                        rev: rec.rev,
                    }))
                    .collect()
            };

            #[cfg(not(feature = "postgres"))]
            let out: Vec<ProfileSnapshotRecord> = {
                let st = state.lock().await;
                user_ids
                    .iter()
                    .filter_map(|uid| st.profiles.get(uid).map(|rec| ProfileSnapshotRecord {
                        user_id: uid.clone(),
                        display_name: rec.display_name.clone(),
                        real_name: rec.real_name.clone(),
                        show_real_name: rec.show_real_name,
                        rev: rec.rev,
                    }))
                    .collect()
            };

            let snap = SignalingMessage::ProfileSnapshot { signing_pubkey, profiles: out };
            if let Ok(json) = serde_json::to_string(&snap) {
                let _ = sender.send(hyper_tungstenite::tungstenite::Message::Text(json));
            }
            Ok(())
        }
        SignalingMessage::Offer { from_peer, to_peer, sdp } => {
            info!("Forwarding offer from {} to {}", from_peer, to_peer);

            let state = state.lock().await;
            if let Some(target_sender) = state.peer_senders.get(&to_peer) {
                let forward_msg = SignalingMessage::Offer {
                    from_peer,
                    to_peer,
                    sdp,
                };
                let json = serde_json::to_string(&forward_msg)
                    .map_err(|e| format!("Failed to serialize offer: {}", e))?;

                target_sender
                    .send(hyper_tungstenite::tungstenite::Message::Text(json))
                    .map_err(|e| format!("Failed to forward offer: {}", e))?;
            } else {
                warn!("Target peer {} not found for offer", to_peer);
            }

            Ok(())
        }
        SignalingMessage::Answer { from_peer, to_peer, sdp } => {
            info!("Forwarding answer from {} to {}", from_peer, to_peer);

            let state = state.lock().await;
            if let Some(target_sender) = state.peer_senders.get(&to_peer) {
                let forward_msg = SignalingMessage::Answer {
                    from_peer,
                    to_peer,
                    sdp,
                };
                let json = serde_json::to_string(&forward_msg)
                    .map_err(|e| format!("Failed to serialize answer: {}", e))?;

                target_sender
                    .send(hyper_tungstenite::tungstenite::Message::Text(json))
                    .map_err(|e| format!("Failed to forward answer: {}", e))?;
            } else {
                warn!("Target peer {} not found for answer", to_peer);
            }

            Ok(())
        }
        SignalingMessage::IceCandidate { from_peer, to_peer, candidate } => {
            info!("Forwarding ICE candidate from {} to {}", from_peer, to_peer);

            let state = state.lock().await;
            if let Some(target_sender) = state.peer_senders.get(&to_peer) {
                let forward_msg = SignalingMessage::IceCandidate {
                    from_peer,
                    to_peer,
                    candidate,
                };
                let json = serde_json::to_string(&forward_msg)
                    .map_err(|e| format!("Failed to serialize ICE candidate: {}", e))?;

                target_sender
                    .send(hyper_tungstenite::tungstenite::Message::Text(json))
                    .map_err(|e| format!("Failed to forward ICE candidate: {}", e))?;
            } else {
                warn!("Target peer {} not found for ICE candidate", to_peer);
            }

            Ok(())
        }

        // === Voice Chat Messages ===

        SignalingMessage::VoiceRegister { house_id, room_id, peer_id, user_id } => {
            info!("Voice register: peer={} user={} house={} room={}", peer_id, user_id, house_id, room_id);

            let peers = {
                let mut state = state.lock().await;

                // Store the sender for this peer (voice peers need this for Offer/Answer/ICE forwarding)
                state.peer_senders.insert(peer_id.clone(), sender.clone());

                // Register the voice peer
                state.register_voice_peer(
                    peer_id.clone(),
                    user_id.clone(),
                    house_id.clone(),
                    room_id.clone(),
                    conn_id.clone(),
                )
            };

            // Send VoiceRegistered response
            let response = SignalingMessage::VoiceRegistered {
                peer_id: peer_id.clone(),
                room_id: room_id.clone(),
                peers: peers.clone(),
            };
            let json = serde_json::to_string(&response)
                .map_err(|e| format!("Failed to serialize VoiceRegistered: {}", e))?;
            sender
                .send(hyper_tungstenite::tungstenite::Message::Text(json))
                .map_err(|e| format!("Failed to send VoiceRegistered: {}", e))?;

            // Broadcast VoicePeerJoined to entire house (so everyone can see who's in voice)
            let join_msg = SignalingMessage::VoicePeerJoined {
                peer_id: peer_id.clone(),
                user_id,
                room_id: room_id.clone(),
            };
            {
                let state = state.lock().await;
                // Broadcast to voice room for WebRTC negotiation
                state.broadcast_to_voice_room(&house_id, &room_id, &join_msg, Some(&peer_id));
                // Also broadcast to entire house for presence visibility
                state.broadcast_to_house(&house_id, &join_msg, Some(&peer_id));
            }

            Ok(())
        }

        SignalingMessage::VoiceUnregister { peer_id, room_id } => {
            info!("Voice unregister: peer={} room={}", peer_id, room_id);

            // Find the house_id for this peer and unregister
            let removed = {
                let mut state = state.lock().await;

                // We need to find which house this room is in
                // Look through voice_rooms to find a match
                let mut found_house: Option<HouseId> = None;
                for ((h, r), peers) in state.voice_rooms.iter() {
                    if r == &room_id && peers.iter().any(|p| p.peer_id == peer_id) {
                        found_house = Some(h.clone());
                        break;
                    }
                }

                if let Some(house_id) = found_house {
                    state.unregister_voice_peer(&peer_id, &house_id, &room_id)
                        .map(|user_id| (house_id, user_id))
                } else {
                    None
                }
            };

            // Broadcast VoicePeerLeft if peer was found
            if let Some((house_id, user_id)) = removed {
                let leave_msg = SignalingMessage::VoicePeerLeft {
                    peer_id,
                    user_id,
                    room_id: room_id.clone(),
                };
                let state = state.lock().await;
                // Broadcast to voice room
                state.broadcast_to_voice_room(&house_id, &room_id, &leave_msg, None);
                // Also broadcast to entire house for presence visibility
                state.broadcast_to_house(&house_id, &leave_msg, None);
            }

            Ok(())
        }

        SignalingMessage::VoiceOffer { from_peer, from_user, to_peer, room_id, sdp } => {
            info!("Voice offer from {} to {} in room {}", from_peer, to_peer, room_id);

            let state = state.lock().await;

            // Find the target peer's sender (they must be in the same room)
            // First find which house this room is in
            let mut target_sender = None;
            for ((house_id, r), _) in state.voice_rooms.iter() {
                if r == &room_id {
                    if let Some(s) = state.get_voice_peer_sender(house_id, &room_id, &to_peer) {
                        target_sender = Some(s.clone());
                        break;
                    }
                }
            }

            if let Some(target) = target_sender {
                let forward_msg = SignalingMessage::VoiceOffer {
                    from_peer,
                    from_user,
                    to_peer,
                    room_id,
                    sdp,
                };
                let json = serde_json::to_string(&forward_msg)
                    .map_err(|e| format!("Failed to serialize VoiceOffer: {}", e))?;
                target
                    .send(hyper_tungstenite::tungstenite::Message::Text(json))
                    .map_err(|e| format!("Failed to forward VoiceOffer: {}", e))?;
            } else {
                warn!("Target peer {} not found in room {} for VoiceOffer", to_peer, room_id);
            }

            Ok(())
        }

        SignalingMessage::VoiceAnswer { from_peer, from_user, to_peer, room_id, sdp } => {
            info!("Voice answer from {} to {} in room {}", from_peer, to_peer, room_id);

            let state = state.lock().await;

            // Find the target peer's sender
            let mut target_sender = None;
            for ((house_id, r), _) in state.voice_rooms.iter() {
                if r == &room_id {
                    if let Some(s) = state.get_voice_peer_sender(house_id, &room_id, &to_peer) {
                        target_sender = Some(s.clone());
                        break;
                    }
                }
            }

            if let Some(target) = target_sender {
                let forward_msg = SignalingMessage::VoiceAnswer {
                    from_peer,
                    from_user,
                    to_peer,
                    room_id,
                    sdp,
                };
                let json = serde_json::to_string(&forward_msg)
                    .map_err(|e| format!("Failed to serialize VoiceAnswer: {}", e))?;
                target
                    .send(hyper_tungstenite::tungstenite::Message::Text(json))
                    .map_err(|e| format!("Failed to forward VoiceAnswer: {}", e))?;
            } else {
                warn!("Target peer {} not found in room {} for VoiceAnswer", to_peer, room_id);
            }

            Ok(())
        }

        SignalingMessage::VoiceIceCandidate { from_peer, to_peer, room_id, candidate } => {
            // Don't log every ICE candidate - too noisy
            let state = state.lock().await;

            // Find the target peer's sender
            let mut target_sender = None;
            for ((house_id, r), _) in state.voice_rooms.iter() {
                if r == &room_id {
                    if let Some(s) = state.get_voice_peer_sender(house_id, &room_id, &to_peer) {
                        target_sender = Some(s.clone());
                        break;
                    }
                }
            }

            if let Some(target) = target_sender {
                let forward_msg = SignalingMessage::VoiceIceCandidate {
                    from_peer,
                    to_peer,
                    room_id,
                    candidate,
                };
                let json = serde_json::to_string(&forward_msg)
                    .map_err(|e| format!("Failed to serialize VoiceIceCandidate: {}", e))?;
                target
                    .send(hyper_tungstenite::tungstenite::Message::Text(json))
                    .map_err(|e| format!("Failed to forward VoiceIceCandidate: {}", e))?;
            }
            // Don't warn on missing peer for ICE candidates - they may have left

            Ok(())
        }

        SignalingMessage::Ping => {
            // Client keepalive - respond with Pong
            let pong = SignalingMessage::Pong;
            let json = serde_json::to_string(&pong)
                .map_err(|e| format!("Failed to serialize Pong: {}", e))?;
            sender.send(hyper_tungstenite::tungstenite::Message::Text(json))
                .map_err(|e| format!("Failed to send Pong: {}", e))?;
            Ok(())
        }

        SignalingMessage::Pong => {
            // Server shouldn't receive Pong, ignore
            Ok(())
        }

        _ => Err("Invalid message type".to_string()),
    }
}

// ============================================
// HTTP REST API Handlers (Event Queue)
// ============================================

async fn handle_api_request(
    req: Request<Body>,
    state: SharedState,
) -> Result<Response<Body>, hyper::Error> {
    let path = req.uri().path().to_string();
    let method = req.method().clone();

    // Parse path: /api/...
    let path_parts: Vec<&str> = path.split('/').collect();

    // Check if it's an API request
    if path_parts.len() < 3 || path_parts[1] != "api" {
        return Ok(Response::builder()
            .status(StatusCode::NOT_FOUND)
            .body(Body::from("API endpoint not found"))
            .unwrap());
    }

    match path_parts[2] {
        // GET /api/invites/{code} - Fetch invite token (opaque encrypted payload)
        // POST /api/invites/{code}/redeem - Atomically redeem (decrement remaining_uses) and return payload
        // POST /api/invites/{code}/revoke - Revoke (delete) the invite token
        "invites" => {
            if path_parts.len() < 4 {
                return Ok(Response::builder()
                    .status(StatusCode::NOT_FOUND)
                    .body(Body::from("Invite endpoint not found"))
                    .unwrap());
            }

            let code = decode_path_segment(path_parts[3]).trim().to_string();
            let maybe_sub = path_parts.get(4).copied();

            #[cfg(feature = "postgres")]
            {
                let db = { state.lock().await.db.clone() };
                if let Some(pool) = db {
                    let _ = gc_expired_invites_db(&pool).await;
                    return match (method, maybe_sub) {
                        (Method::POST, Some("redeem")) => {
                            match redeem_invite_db(&pool, &code).await.unwrap_or(None) {
                                Some(rec) => {
                                    let json = serde_json::to_string(&rec).unwrap();
                                    Ok(Response::builder()
                                        .status(StatusCode::OK)
                                        .header("Content-Type", "application/json")
                                        .body(Body::from(json))
                                        .unwrap())
                                }
                                None => Ok(Response::builder()
                                    .status(StatusCode::NOT_FOUND)
                                    .body(Body::from("Invite expired or fully redeemed"))
                                    .unwrap()),
                            }
                        }
                        (Method::POST, Some("revoke")) => {
                            let existed = revoke_invite_db(&pool, &code).await.unwrap_or(false);
                            if existed {
                                Ok(Response::builder()
                                    .status(StatusCode::OK)
                                    .header("Content-Type", "application/json")
                                    .body(Body::from(r#"{"status":"revoked"}"#))
                                    .unwrap())
                            } else {
                                Ok(Response::builder()
                                    .status(StatusCode::NOT_FOUND)
                                    .body(Body::from("Invite not found"))
                                    .unwrap())
                            }
                        }
                        (Method::GET, None) => {
                            match get_invite_db(&pool, &code).await.unwrap_or(None) {
                                Some(rec) => {
                                    let json = serde_json::to_string(&rec).unwrap();
                                    Ok(Response::builder()
                                        .status(StatusCode::OK)
                                        .header("Content-Type", "application/json")
                                        .body(Body::from(json))
                                        .unwrap())
                                }
                                None => Ok(Response::builder()
                                    .status(StatusCode::NOT_FOUND)
                                    .body(Body::from("Invite not found"))
                                    .unwrap()),
                            }
                        }
                        _ => Ok(Response::builder()
                            .status(StatusCode::METHOD_NOT_ALLOWED)
                            .body(Body::from("Method not allowed"))
                            .unwrap()),
                    };
                }
            }

            let mut state = state.lock().await;
            state.gc_expired_invites();

            match (method, maybe_sub) {
                (Method::POST, Some("redeem")) => {
                    match state.redeem_invite_token(&code) {
                        Some(rec) => {
                            let json = serde_json::to_string(&rec).unwrap();
                            Ok(Response::builder()
                                .status(StatusCode::OK)
                                .header("Content-Type", "application/json")
                                .body(Body::from(json))
                                .unwrap())
                        }
                        None => Ok(Response::builder()
                            .status(StatusCode::NOT_FOUND)
                            .body(Body::from("Invite expired or fully redeemed"))
                            .unwrap()),
                    }
                }
                (Method::POST, Some("revoke")) => {
                    let existed = state.invite_tokens.remove(&code).is_some();
                    if existed {
                        Ok(Response::builder()
                            .status(StatusCode::OK)
                            .header("Content-Type", "application/json")
                            .body(Body::from(r#"{"status":"revoked"}"#))
                            .unwrap())
                    } else {
                        Ok(Response::builder()
                            .status(StatusCode::NOT_FOUND)
                            .body(Body::from("Invite not found"))
                            .unwrap())
                    }
                }
                (Method::GET, None) => {
                    match state.get_invite_token(&code) {
                        Some(rec) => {
                            let json = serde_json::to_string(rec).unwrap();
                            Ok(Response::builder()
                                .status(StatusCode::OK)
                                .header("Content-Type", "application/json")
                                .body(Body::from(json))
                                .unwrap())
                        }
                        None => Ok(Response::builder()
                            .status(StatusCode::NOT_FOUND)
                            .body(Body::from("Invite not found"))
                            .unwrap()),
                    }
                }
                _ => Ok(Response::builder()
                    .status(StatusCode::METHOD_NOT_ALLOWED)
                    .body(Body::from("Method not allowed"))
                    .unwrap()),
            }
        }
        // /api/houses/{signing_pubkey}/...
        "houses" => {
            if path_parts.len() < 4 {
                return Ok(Response::builder()
                    .status(StatusCode::NOT_FOUND)
                    .body(Body::from("House endpoint not found"))
                    .unwrap());
            }

            let signing_pubkey = decode_path_segment(path_parts[3]);
            let endpoint = path_parts.get(4).map(|s| *s);

            match (method, endpoint) {
        // POST /api/houses/{signing_pubkey}/register - Register/update house hint
        (Method::POST, Some("register")) => {
            let body_bytes = hyper::body::to_bytes(req.into_body()).await?;
            match serde_json::from_slice::<EncryptedHouseHint>(&body_bytes) {
                Ok(hint) => {
                    #[cfg(feature = "postgres")]
                    {
                        let db = { state.lock().await.db.clone() };
                        if let Some(pool) = db {
                            if let Err(e) = upsert_house_hint_db(&pool, &hint).await {
                                warn!("Failed to persist house hint: {}", e);
                            }
                        } else {
                            let mut state = state.lock().await;
                            // Store the hint
                            state.register_house_hint(signing_pubkey.clone(), hint.clone());
                        }
                    }
                    #[cfg(not(feature = "postgres"))]
                    {
                        let mut state = state.lock().await;
                        // Store the hint
                        state.register_house_hint(signing_pubkey.clone(), hint.clone());
                    }
                    // Broadcast snapshot update to any subscribed peers
                    let state = state.lock().await;
                    state.broadcast_house_hint_updated(&signing_pubkey, &hint);
                    info!("Registered house hint");
                    Ok(Response::builder()
                        .status(StatusCode::OK)
                        .header("Content-Type", "application/json")
                        .body(Body::from(r#"{"status":"ok"}"#))
                        .unwrap())
                }
                Err(e) => {
                    warn!("Failed to parse house hint: {}", e);
                    Ok(Response::builder()
                        .status(StatusCode::BAD_REQUEST)
                        .body(Body::from(format!("Invalid request body: {}", e)))
                        .unwrap())
                }
            }
        }

        // POST /api/houses/{signing_pubkey}/invites - Create/update a temporary invite token
        (Method::POST, Some("invites")) => {
            let body_bytes = hyper::body::to_bytes(req.into_body()).await?;
            match serde_json::from_slice::<InviteTokenCreateRequest>(&body_bytes) {
                Ok(inv) => {
                    #[cfg(feature = "postgres")]
                    {
                        let db = { state.lock().await.db.clone() };
                        if let Some(pool) = db {
                            let _ = gc_expired_invites_db(&pool).await;
                            return match upsert_invite_db(&pool, &signing_pubkey, inv).await {
                                Ok(record) => {
                                    let json = serde_json::to_string(&record).unwrap();
                                    Ok(Response::builder()
                                        .status(StatusCode::OK)
                                        .header("Content-Type", "application/json")
                                        .body(Body::from(json))
                                        .unwrap())
                                }
                                Err(e) => Ok(Response::builder()
                                    .status(StatusCode::BAD_REQUEST)
                                    .body(Body::from(e))
                                    .unwrap()),
                            };
                        }
                    }
                    let mut state = state.lock().await;
                    state.gc_expired_invites();
                    match state.put_invite_token(&signing_pubkey, inv) {
                        Ok(record) => {
                            let json = serde_json::to_string(&record).unwrap();
                            Ok(Response::builder()
                                .status(StatusCode::OK)
                                .header("Content-Type", "application/json")
                                .body(Body::from(json))
                                .unwrap())
                        }
                        Err(e) => Ok(Response::builder()
                            .status(StatusCode::BAD_REQUEST)
                            .body(Body::from(e))
                            .unwrap()),
                    }
                }
                Err(e) => {
                    warn!("Failed to parse invite create request: {}", e);
                    Ok(Response::builder()
                        .status(StatusCode::BAD_REQUEST)
                        .body(Body::from(format!("Invalid request body: {}", e)))
                        .unwrap())
                }
            }
        }

        // GET /api/houses/{signing_pubkey}/hint - Get house hint
        (Method::GET, Some("hint")) => {
            #[cfg(feature = "postgres")]
            {
                let db = { state.lock().await.db.clone() };
                if let Some(pool) = db {
                    return match get_house_hint_db(&pool, &signing_pubkey).await.unwrap_or(None) {
                        Some(hint) => {
                            let json = serde_json::to_string(&hint).unwrap();
                            Ok(Response::builder()
                                .status(StatusCode::OK)
                                .header("Content-Type", "application/json")
                                .body(Body::from(json))
                                .unwrap())
                        }
                        None => Ok(Response::builder()
                            .status(StatusCode::NOT_FOUND)
                            .body(Body::from("House hint not found"))
                            .unwrap()),
                    };
                }
            }
            let state = state.lock().await;
            match state.get_house_hint(&signing_pubkey) {
                Some(hint) => {
                    let json = serde_json::to_string(hint).unwrap();
                    Ok(Response::builder()
                        .status(StatusCode::OK)
                        .header("Content-Type", "application/json")
                        .body(Body::from(json))
                        .unwrap())
                }
                None => Ok(Response::builder()
                    .status(StatusCode::NOT_FOUND)
                    .body(Body::from("House hint not found"))
                    .unwrap()),
            }
        }

        // POST /api/houses/{signing_pubkey}/events - Post new event
        // Check if it's actually /events/ack first
        (Method::POST, Some("events")) if path_parts.get(5) == Some(&"ack") => {
            let body_bytes = hyper::body::to_bytes(req.into_body()).await?;
            match serde_json::from_slice::<AckRequest>(&body_bytes) {
                Ok(ack) => {
                    #[cfg(feature = "postgres")]
                    {
                        let db = { state.lock().await.db.clone() };
                        if let Some(pool) = db {
                            let _ = ack_events_db(&pool, &signing_pubkey, &ack.user_id, &ack.last_event_id).await;
                            info!("Acknowledged events (db)");
                            return Ok(Response::builder()
                                .status(StatusCode::OK)
                                .header("Content-Type", "application/json")
                                .body(Body::from(r#"{"status":"ok"}"#))
                                .unwrap());
                        }
                    }
                    let mut state = state.lock().await;
                    state.ack_events(signing_pubkey, ack.user_id, ack.last_event_id);
                    info!("Acknowledged events");
                    Ok(Response::builder()
                        .status(StatusCode::OK)
                        .header("Content-Type", "application/json")
                        .body(Body::from(r#"{"status":"ok"}"#))
                        .unwrap())
                }
                Err(e) => {
                    warn!("Failed to parse ack request: {}", e);
                    Ok(Response::builder()
                        .status(StatusCode::BAD_REQUEST)
                        .body(Body::from(format!("Invalid request body: {}", e)))
                        .unwrap())
                }
            }
        }

        // POST /api/houses/{signing_pubkey}/events - Post new event (no ack)
        (Method::POST, Some("events")) => {
            let body_bytes = hyper::body::to_bytes(req.into_body()).await?;
            match serde_json::from_slice::<HouseEvent>(&body_bytes) {
                Ok(event) => {
                    let mut event = event;
                    event.signing_pubkey = signing_pubkey.clone();
                    event.timestamp = Utc::now();
                    if event.event_id.is_empty() {
                        event.event_id = uuid::Uuid::new_v4().to_string();
                    }

                    #[cfg(feature = "postgres")]
                    {
                        let db = { state.lock().await.db.clone() };
                        if let Some(pool) = db {
                            let _ = insert_event_db(&pool, &event).await;
                            info!("Posted house event (db)");
                            return Ok(Response::builder()
                                .status(StatusCode::CREATED)
                                .header("Content-Type", "application/json")
                                .body(Body::from(r#"{"status":"created"}"#))
                                .unwrap());
                        }
                    }

                    let mut state = state.lock().await;
                    state.post_event(signing_pubkey, event);
                    info!("Posted house event");
                    Ok(Response::builder()
                        .status(StatusCode::CREATED)
                        .header("Content-Type", "application/json")
                        .body(Body::from(r#"{"status":"created"}"#))
                        .unwrap())
                }
                Err(e) => {
                    warn!("Failed to parse house event: {}", e);
                    Ok(Response::builder()
                        .status(StatusCode::BAD_REQUEST)
                        .body(Body::from(format!("Invalid request body: {}", e)))
                        .unwrap())
                }
            }
        }

        // GET /api/houses/{signing_pubkey}/events?since={event_id} - Poll events
        (Method::GET, Some("events")) => {
            let query = req.uri().query().unwrap_or("");
            let since: Option<&str> = query
                .split('&')
                .find(|p| p.starts_with("since="))
                .map(|p| &p[6..]);
            #[cfg(feature = "postgres")]
            {
                let db = { state.lock().await.db.clone() };
                if let Some(pool) = db {
                    let events = get_events_db(&pool, &signing_pubkey, since).await.unwrap_or_default();
                    let json = serde_json::to_string(&events).unwrap();
                    return Ok(Response::builder()
                        .status(StatusCode::OK)
                        .header("Content-Type", "application/json")
                        .body(Body::from(json))
                        .unwrap());
                }
            }

            let state = state.lock().await;
            let events = state.get_events(&signing_pubkey, since);
            let json = serde_json::to_string(&events).unwrap();
            Ok(Response::builder()
                .status(StatusCode::OK)
                .header("Content-Type", "application/json")
                .body(Body::from(json))
                .unwrap())
        }

        // POST /api/houses/{signing_pubkey}/ack - Acknowledge events (alternative path)
        (Method::POST, Some("ack")) => {
            let body_bytes = hyper::body::to_bytes(req.into_body()).await?;
            match serde_json::from_slice::<AckRequest>(&body_bytes) {
                Ok(ack) => {
                    #[cfg(feature = "postgres")]
                    {
                        let db = { state.lock().await.db.clone() };
                        if let Some(pool) = db {
                            let _ = ack_events_db(&pool, &signing_pubkey, &ack.user_id, &ack.last_event_id).await;
                            info!("Acknowledged events (db)");
                            return Ok(Response::builder()
                                .status(StatusCode::OK)
                                .header("Content-Type", "application/json")
                                .body(Body::from(r#"{"status":"ok"}"#))
                                .unwrap());
                        }
                    }
                    let mut state = state.lock().await;
                    state.ack_events(signing_pubkey, ack.user_id, ack.last_event_id);
                    info!("Acknowledged events");
                    Ok(Response::builder()
                        .status(StatusCode::OK)
                        .header("Content-Type", "application/json")
                        .body(Body::from(r#"{"status":"ok"}"#))
                        .unwrap())
                }
                Err(e) => {
                    warn!("Failed to parse ack request: {}", e);
                    Ok(Response::builder()
                        .status(StatusCode::BAD_REQUEST)
                        .body(Body::from(format!("Invalid request body: {}", e)))
                        .unwrap())
                }
            }
        }

        _ => {
            Ok(Response::builder()
                .status(StatusCode::METHOD_NOT_ALLOWED)
                .body(Body::from("Method not allowed"))
                .unwrap())
        }
            }
        }
        _ => Ok(Response::builder()
            .status(StatusCode::NOT_FOUND)
            .body(Body::from("API endpoint not found"))
            .unwrap()),
    }
}

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

    // API endpoints (REST)
    if path.starts_with("/api/") {
        let mut resp = handle_api_request(req, state).await?;
        let headers = resp.headers_mut();
        headers.insert("Access-Control-Allow-Origin", "*".parse().unwrap());
        headers.insert("Access-Control-Allow-Methods", "GET, POST, OPTIONS".parse().unwrap());
        headers.insert("Access-Control-Allow-Headers", "Content-Type".parse().unwrap());
        return Ok(resp);
    }

    // WebSocket upgrade
    if hyper_tungstenite::is_upgrade_request(&req) {
        match hyper_tungstenite::upgrade(&mut req, None) {
            Ok((response, websocket)) => {
                // Spawn a task to handle the WebSocket connection
                tokio::spawn(async move {
                    if let Ok(ws) = websocket.await {
                        let addr = "0.0.0.0:9001".parse().unwrap(); // Placeholder for actual client addr
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

    // Default response for other requests
    Ok(Response::builder()
        .status(StatusCode::NOT_FOUND)
        .body(Body::from("Not found. Use /health for health check, /api/* for REST API, or upgrade to WebSocket."))
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
    let state = Arc::new(Mutex::new(ServerState::new()));

    // Optional Postgres durability (profiles first; others later)
    #[cfg(feature = "postgres")]
    {
        if let Ok(db_url) = std::env::var("SIGNALING_DB_URL") {
            match PgPoolOptions::new().max_connections(8).connect(&db_url).await {
                Ok(pool) => {
                    if let Err(e) = init_db(&pool).await {
                        warn!("DB init failed; continuing without DB: {}", e);
                    } else {
                        state.lock().await.db = Some(pool);
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
                                    let mut st = state.lock().await;
                                    st.redis = Some(client);
                                    st.redis_presence_ttl_secs = ttl_secs;
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
                let mut state = gc_state.lock().await;
                state.gc_old_events();
                #[cfg(feature = "postgres")]
                let db = state.db.clone();
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
                    let st = refresh_state.lock().await;
                    let client = st.redis.clone();
                    let ttl = st.redis_presence_ttl_secs;
                    let users = st
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

    info!("Signaling server listening on http://{}", addr);
    info!("WebSocket endpoint: ws://{}", addr);
    info!("REST API: http://{}/api/houses/{{signing_pubkey}}/...", addr);
    info!("Health check: http://{}/health", addr);

    if let Err(e) = server.await {
        error!("Server error: {}", e);
    }
}
