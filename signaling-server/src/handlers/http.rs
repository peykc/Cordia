use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    response::IntoResponse,
    Json,
};
use chrono::Utc;
use log::info;
use std::sync::Arc;
use std::time::Instant as StdInstant;
use sysinfo::{get_current_pid, Networks, System};

use crate::{
    decode_path_segment,
    state::AppState,
    AckRequest, EncryptedServerHint, InviteTokenCreateRequest, ServerEvent,
};

type SharedState = Arc<AppState>;

#[cfg(feature = "postgres")]
use crate::handlers::db::{
    ack_events_db, gc_expired_invites_db, get_events_db, get_invite_db, get_server_hint_db,
    insert_event_db, redeem_invite_db, revoke_invite_db, upsert_invite_db, upsert_server_hint_db,
};

// ---------- Status ----------

pub async fn get_status(State(state): State<SharedState>) -> impl IntoResponse {
    let connections = {
        let presence = state.presence.lock().await;
        presence.presence_users.len()
    };
    let uptime_secs = state.started_at.elapsed().as_secs();
    let started_at_utc = state.started_at_utc.clone();
    let memory_bytes = {
        let mut sys = System::new_all();
        sys.refresh_all();
        get_current_pid()
            .ok()
            .and_then(|pid| sys.process(pid))
            .map(|p| p.memory())
            .unwrap_or(0)
    };
    let cpu_percent = *state.cpu_percent_cache.lock().await;
    let (rx_bps, tx_bps) = {
        let networks = Networks::new_with_refreshed_list();
        let cur_rx: u64 = networks.list().values().map(|d| d.total_received()).sum();
        let cur_tx: u64 = networks.list().values().map(|d| d.total_transmitted()).sum();
        let now = StdInstant::now();
        let mut prev_guard = state.network_prev.lock().await;
        let (rx_bps, tx_bps) = if let Some((prx, ptx, t)) = *prev_guard {
            let elapsed_secs = (now - t).as_secs().max(1);
            (
                cur_rx.saturating_sub(prx) / elapsed_secs,
                cur_tx.saturating_sub(ptx) / elapsed_secs,
            )
        } else {
            (0u64, 0u64)
        };
        *prev_guard = Some((cur_rx, cur_tx, now));
        (rx_bps, tx_bps)
    };
    let json = serde_json::json!({
        "connections": connections,
        "uptime_secs": uptime_secs,
        "started_at_utc": started_at_utc,
        "downtime_secs": state.downtime_secs,
        "memory_bytes": memory_bytes,
        "cpu_percent": cpu_percent,
        "rx_bps": rx_bps,
        "tx_bps": tx_bps
    });
    Json(json)
}

// ---------- Invites ----------

pub async fn get_invite(
    State(state): State<SharedState>,
    Path(code): Path<String>,
) -> impl IntoResponse {
    let code = decode_path_segment(&code).trim().to_string();

    #[cfg(feature = "postgres")]
    {
        let db = {
            let backends = state.backends.lock().await;
            backends.db.clone()
        };
        if let Some(pool) = db {
            let _ = gc_expired_invites_db(&pool).await;
            if let Ok(Some(rec)) = get_invite_db(&pool, &code).await {
                return (StatusCode::OK, Json(serde_json::to_value(&rec).unwrap())).into_response();
            }
            return (StatusCode::NOT_FOUND, "Invite not found").into_response();
        }
    }

    let events = state.events.lock().await;
    match events.get_invite_token(&code) {
        Some(rec) => (StatusCode::OK, Json(serde_json::to_value(rec).unwrap())).into_response(),
        None => (StatusCode::NOT_FOUND, "Invite not found").into_response(),
    }
}

pub async fn redeem_invite(
    State(state): State<SharedState>,
    Path(code): Path<String>,
) -> impl IntoResponse {
    let code = decode_path_segment(&code).trim().to_string();

    #[cfg(feature = "postgres")]
    {
        let db = {
            let backends = state.backends.lock().await;
            backends.db.clone()
        };
        if let Some(pool) = db {
            let _ = gc_expired_invites_db(&pool).await;
            match redeem_invite_db(&pool, &code).await.unwrap_or(None) {
                Some(rec) => {
                    return (StatusCode::OK, Json(serde_json::to_value(&rec).unwrap())).into_response()
                }
                None => {
                    return (StatusCode::NOT_FOUND, "Invite expired or fully redeemed").into_response()
                }
            }
        }
    }

    let mut events = state.events.lock().await;
    events.gc_expired_invites();
    match events.redeem_invite_token(&code) {
        Some(rec) => (StatusCode::OK, Json(serde_json::to_value(&rec).unwrap())).into_response(),
        None => (StatusCode::NOT_FOUND, "Invite expired or fully redeemed").into_response(),
    }
}

pub async fn revoke_invite(
    State(state): State<SharedState>,
    Path(code): Path<String>,
) -> impl IntoResponse {
    let code = decode_path_segment(&code).trim().to_string();

    #[cfg(feature = "postgres")]
    {
        let db = {
            let backends = state.backends.lock().await;
            backends.db.clone()
        };
        if let Some(pool) = db {
            let _ = gc_expired_invites_db(&pool).await;
            let existed = revoke_invite_db(&pool, &code).await.unwrap_or(false);
            if existed {
                return (
                    StatusCode::OK,
                    Json(serde_json::json!({"status": "revoked"})),
                )
                    .into_response();
            }
            return (StatusCode::NOT_FOUND, "Invite not found").into_response();
        }
    }

    let mut events = state.events.lock().await;
    events.gc_expired_invites();
    let existed = events.invite_tokens.remove(&code).is_some();
    if existed {
        (StatusCode::OK, Json(serde_json::json!({"status": "revoked"}))).into_response()
    } else {
        (StatusCode::NOT_FOUND, "Invite not found").into_response()
    }
}

// ---------- Servers (signing_pubkey) ----------

pub async fn register_server_hint(
    State(state): State<SharedState>,
    Path(signing_pubkey): Path<String>,
    Json(hint): Json<EncryptedServerHint>,
) -> impl IntoResponse {
    let signing_pubkey = decode_path_segment(&signing_pubkey);

    #[cfg(feature = "postgres")]
    {
        let db = {
            let backends = state.backends.lock().await;
            backends.db.clone()
        };
        if let Some(pool) = db {
            if let Err(e) = upsert_server_hint_db(&pool, &hint).await {
                log::warn!("Failed to persist server hint: {}", e);
            }
        } else {
            let mut events = state.events.lock().await;
            events.register_server_hint(signing_pubkey.to_string(), hint.clone());
        }
    }
    #[cfg(not(feature = "postgres"))]
    {
        let mut events = state.events.lock().await;
        events.register_server_hint(signing_pubkey.to_string(), hint.clone());
    }
    {
        let signaling = state.signaling.lock().await;
        signaling.broadcast_server_hint_updated(&signing_pubkey, &hint);
    }
    info!("Registered server hint");
    (StatusCode::OK, Json(serde_json::json!({"status": "ok"})))
}

pub async fn get_server_hint(
    State(state): State<SharedState>,
    Path(signing_pubkey): Path<String>,
) -> impl IntoResponse {
    let signing_pubkey = decode_path_segment(&signing_pubkey);

    #[cfg(feature = "postgres")]
    {
        let db = {
            let backends = state.backends.lock().await;
            backends.db.clone()
        };
        if let Some(pool) = db {
            if let Ok(Some(hint)) = get_server_hint_db(&pool, &signing_pubkey).await {
                return (StatusCode::OK, Json(serde_json::to_value(&hint).unwrap())).into_response();
            }
            return (StatusCode::NOT_FOUND, "Server hint not found").into_response();
        }
    }

    let events = state.events.lock().await;
    match events.get_server_hint(&signing_pubkey) {
        Some(hint) => (StatusCode::OK, Json(serde_json::to_value(hint).unwrap())).into_response(),
        None => (StatusCode::NOT_FOUND, "Server hint not found").into_response(),
    }
}

pub async fn create_house_invite(
    State(state): State<SharedState>,
    Path(signing_pubkey): Path<String>,
    Json(inv): Json<InviteTokenCreateRequest>,
) -> impl IntoResponse {
    let signing_pubkey = decode_path_segment(&signing_pubkey);

    #[cfg(feature = "postgres")]
    {
        let db = {
            let backends = state.backends.lock().await;
            backends.db.clone()
        };
        if let Some(pool) = db {
            let _ = gc_expired_invites_db(&pool).await;
            return match upsert_invite_db(&pool, &signing_pubkey, inv).await {
                Ok(record) => {
                    (StatusCode::OK, Json(serde_json::to_value(&record).unwrap())).into_response()
                }
                Err(e) => (StatusCode::BAD_REQUEST, e).into_response(),
            };
        }
    }

    let mut events = state.events.lock().await;
    events.gc_expired_invites();
    match events.put_invite_token(&signing_pubkey, inv) {
        Ok(record) => (StatusCode::OK, Json(serde_json::to_value(&record).unwrap())).into_response(),
        Err(e) => (StatusCode::BAD_REQUEST, e).into_response(),
    }
}

#[derive(serde::Deserialize)]
pub struct EventsQuery {
    pub since: Option<String>,
}

pub async fn get_events(
    State(state): State<SharedState>,
    Path(signing_pubkey): Path<String>,
    Query(params): Query<EventsQuery>,
) -> impl IntoResponse {
    let signing_pubkey = decode_path_segment(&signing_pubkey);
    let since = params.since.as_deref();

    #[cfg(feature = "postgres")]
    {
        let db = {
            let backends = state.backends.lock().await;
            backends.db.clone()
        };
        if let Some(pool) = db {
            let events_list = get_events_db(&pool, &signing_pubkey, since)
                .await
                .unwrap_or_default();
            return (StatusCode::OK, Json(serde_json::to_value(&events_list).unwrap())).into_response();
        }
    }

    let events = state.events.lock().await;
    let events_list = events.get_events(&signing_pubkey, since);
    (StatusCode::OK, Json(serde_json::to_value(&events_list).unwrap())).into_response()
}

pub async fn post_event(
    State(state): State<SharedState>,
    Path(signing_pubkey): Path<String>,
    Json(mut event): Json<ServerEvent>,
) -> impl IntoResponse {
    let signing_pubkey = decode_path_segment(&signing_pubkey);
    event.signing_pubkey = signing_pubkey.clone();
    event.timestamp = Utc::now();
    if event.event_id.is_empty() {
        event.event_id = uuid::Uuid::new_v4().to_string();
    }

    #[cfg(feature = "postgres")]
    {
        let db = {
            let backends = state.backends.lock().await;
            backends.db.clone()
        };
        if let Some(pool) = db {
            let _ = insert_event_db(&pool, &event).await;
            info!("Posted server event (db)");
            return (StatusCode::CREATED, Json(serde_json::json!({"status": "created"})));
        }
    }

    let mut events = state.events.lock().await;
    events.post_event(signing_pubkey.clone(), event);
    info!("Posted server event");
    (StatusCode::CREATED, Json(serde_json::json!({"status": "created"})))
}

pub async fn ack_events(
    State(state): State<SharedState>,
    Path(signing_pubkey): Path<String>,
    Json(ack): Json<AckRequest>,
) -> impl IntoResponse {
    let signing_pubkey = decode_path_segment(&signing_pubkey);

    #[cfg(feature = "postgres")]
    {
        let db = {
            let backends = state.backends.lock().await;
            backends.db.clone()
        };
        if let Some(pool) = db {
            let _ = ack_events_db(&pool, &signing_pubkey, &ack.user_id, &ack.last_event_id).await;
            info!("Acknowledged events (db)");
            return (StatusCode::OK, Json(serde_json::json!({"status": "ok"})));
        }
    }

    let mut events = state.events.lock().await;
    events.ack_events(signing_pubkey.clone(), ack.user_id, ack.last_event_id);
    info!("Acknowledged events");
    (StatusCode::OK, Json(serde_json::json!({"status": "ok"})))
}
