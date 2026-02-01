use chrono::Utc;
use hyper::{Body, Method, Request, Response, StatusCode};
use log::{info, warn};
use std::time::Instant as StdInstant;
use sysinfo::{Networks, System, get_current_pid};
use crate::{
    decode_path_segment, EncryptedServerHint, InviteTokenCreateRequest,
    ServerEvent, AckRequest,
    state::AppState,
};
use std::sync::Arc;

type SharedState = Arc<AppState>;

#[cfg(feature = "postgres")]
use crate::handlers::db::{
    gc_expired_invites_db, upsert_invite_db, get_invite_db, redeem_invite_db, revoke_invite_db,
    upsert_server_hint_db, get_server_hint_db, insert_event_db, get_events_db, ack_events_db,
};

pub async fn handle_api_request(
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
        // GET /api/status - Live stats for beacon landing page (connections, uptime, sysinfo)
        "status" => {
            if method == Method::GET && path_parts.len() == 3 {
                let connections = {
                    let signaling = state.signaling.lock().await;
                    signaling.conn_peers.len()
                };
                let uptime_secs = state.started_at.elapsed().as_secs();
                let started_at_utc = state.started_at_utc.clone();
                let (memory_mb, cpu_percent) = {
                    let mut sys = System::new_all();
                    sys.refresh_all();
                    get_current_pid()
                        .ok()
                        .and_then(|pid| sys.process(pid))
                        .map(|p| (p.memory() / 1024 / 1024, p.cpu_usage()))
                        .unwrap_or((0, 0.0))
                };
                let (rx_bps, tx_bps) = {
                    let networks = Networks::new_with_refreshed_list();
                    let cur_rx: u64 = networks.list().values().map(|d| d.total_received()).sum();
                    let cur_tx: u64 = networks.list().values().map(|d| d.total_transmitted()).sum();
                    let now = StdInstant::now();
                    let mut prev_guard = state.network_prev.lock().await;
                    let (rx_bps, tx_bps) = if let Some((prx, ptx, t)) = *prev_guard {
                        let elapsed_secs = (now - t).as_secs().max(1);
                        (
                            (cur_rx.saturating_sub(prx) / elapsed_secs),
                            (cur_tx.saturating_sub(ptx) / elapsed_secs),
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
                    "memory_mb": memory_mb,
                    "cpu_percent": cpu_percent,
                    "rx_bps": rx_bps,
                    "tx_bps": tx_bps
                })
                .to_string();
                return Ok(Response::builder()
                    .status(StatusCode::OK)
                    .header("Content-Type", "application/json")
                    .body(Body::from(json))
                    .unwrap());
            }
            return Ok(Response::builder()
                .status(StatusCode::NOT_FOUND)
                .body(Body::from("Not found"))
                .unwrap());
        }
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
                // LOCK BOUNDARY: Extract data here, unlock before IO
                let db = {
                    let backends = state.backends.lock().await;
                    backends.db.clone()
                };
                if let Some(pool) = db {
                    // IO operation happens after lock is released
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

            let mut events = state.events.lock().await;
            events.gc_expired_invites();

            match (method, maybe_sub) {
                (Method::POST, Some("redeem")) => {
                    match events.redeem_invite_token(&code) {
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
                    let existed = events.invite_tokens.remove(&code).is_some();
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
                    match events.get_invite_token(&code) {
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
        // /api/servers/{signing_pubkey}/...
        "servers" => {
            if path_parts.len() < 4 {
                return Ok(Response::builder()
                    .status(StatusCode::NOT_FOUND)
                    .body(Body::from("Server endpoint not found"))
                    .unwrap());
            }

            let signing_pubkey = decode_path_segment(path_parts[3]);
            let endpoint = path_parts.get(4).map(|s| *s);

            match (method, endpoint) {
        // POST /api/servers/{signing_pubkey}/register - Register/update server hint
        (Method::POST, Some("register")) => {
            let body_bytes = hyper::body::to_bytes(req.into_body()).await?;
            match serde_json::from_slice::<EncryptedServerHint>(&body_bytes) {
                Ok(hint) => {
                    #[cfg(feature = "postgres")]
                    {
                        let db = {
                            let backends = state.backends.lock().await;
                            backends.db.clone()
                        };
                        if let Some(pool) = db {
                            if let Err(e) = upsert_server_hint_db(&pool, &hint).await {
                                warn!("Failed to persist server hint: {}", e);
                            }
                        } else {
                            let mut events = state.events.lock().await;
                            events.register_server_hint(signing_pubkey.clone(), hint.clone());
                        }
                    }
                    #[cfg(not(feature = "postgres"))]
                    {
                        let mut events = state.events.lock().await;
                        events.register_server_hint(signing_pubkey.clone(), hint.clone());
                    }
                    // Broadcast snapshot update to any subscribed peers
                    {
                        let signaling = state.signaling.lock().await;
                        signaling.broadcast_server_hint_updated(&signing_pubkey, &hint);
                    }
                    info!("Registered server hint");
                    Ok(Response::builder()
                        .status(StatusCode::OK)
                        .header("Content-Type", "application/json")
                        .body(Body::from(r#"{"status":"ok"}"#))
                        .unwrap())
                }
                Err(e) => {
                    warn!("Failed to parse server hint: {}", e);
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
                        let db = {
                            let backends = state.backends.lock().await;
                            backends.db.clone()
                        };
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
                    let mut events = state.events.lock().await;
                    events.gc_expired_invites();
                    match events.put_invite_token(&signing_pubkey, inv) {
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

        // GET /api/servers/{signing_pubkey}/hint - Get server hint
        (Method::GET, Some("hint")) => {
            #[cfg(feature = "postgres")]
            {
                let db = {
                    let backends = state.backends.lock().await;
                    backends.db.clone()
                };
                if let Some(pool) = db {
                    return match get_server_hint_db(&pool, &signing_pubkey).await.unwrap_or(None) {
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
                            .body(Body::from("Server hint not found"))
                            .unwrap()),
                    };
                }
            }
            let events = state.events.lock().await;
            match events.get_server_hint(&signing_pubkey) {
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
                    .body(Body::from("Server hint not found"))
                    .unwrap()),
            }
        }

        // POST /api/servers/{signing_pubkey}/events - Post new event
        // Check if it's actually /events/ack first
        (Method::POST, Some("events")) if path_parts.get(5) == Some(&"ack") => {
            let body_bytes = hyper::body::to_bytes(req.into_body()).await?;
            match serde_json::from_slice::<AckRequest>(&body_bytes) {
                Ok(ack) => {
                    #[cfg(feature = "postgres")]
                    {
                        let db = {
                            let backends = state.backends.lock().await;
                            backends.db.clone()
                        };
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
                    let mut events = state.events.lock().await;
                    events.ack_events(signing_pubkey, ack.user_id, ack.last_event_id);
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

        // POST /api/servers/{signing_pubkey}/events - Post new event (no ack)
        (Method::POST, Some("events")) => {
            let body_bytes = hyper::body::to_bytes(req.into_body()).await?;
            match serde_json::from_slice::<ServerEvent>(&body_bytes) {
                Ok(event) => {
                    let mut event = event;
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
                            return Ok(Response::builder()
                                .status(StatusCode::CREATED)
                                .header("Content-Type", "application/json")
                                .body(Body::from(r#"{"status":"created"}"#))
                                .unwrap());
                        }
                    }

                    let mut events = state.events.lock().await;
                    events.post_event(signing_pubkey, event);
                    info!("Posted server event");
                    Ok(Response::builder()
                        .status(StatusCode::CREATED)
                        .header("Content-Type", "application/json")
                        .body(Body::from(r#"{"status":"created"}"#))
                        .unwrap())
                }
                Err(e) => {
                    warn!("Failed to parse server event: {}", e);
                    Ok(Response::builder()
                        .status(StatusCode::BAD_REQUEST)
                        .body(Body::from(format!("Invalid request body: {}", e)))
                        .unwrap())
                }
            }
        }

        // GET /api/servers/{signing_pubkey}/events?since={event_id} - Poll events
        (Method::GET, Some("events")) => {
            let query = req.uri().query().unwrap_or("");
            let since: Option<&str> = query
                .split('&')
                .find(|p| p.starts_with("since="))
                .map(|p| &p[6..]);
            #[cfg(feature = "postgres")]
            {
                let db = {
                    let backends = state.backends.lock().await;
                    backends.db.clone()
                };
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

            let events = state.events.lock().await;
            let events_list = events.get_events(&signing_pubkey, since);
            let json = serde_json::to_string(&events_list).unwrap();
            Ok(Response::builder()
                .status(StatusCode::OK)
                .header("Content-Type", "application/json")
                .body(Body::from(json))
                .unwrap())
        }

        // POST /api/servers/{signing_pubkey}/ack - Acknowledge events (alternative path)
        (Method::POST, Some("ack")) => {
            let body_bytes = hyper::body::to_bytes(req.into_body()).await?;
            match serde_json::from_slice::<AckRequest>(&body_bytes) {
                Ok(ack) => {
                    #[cfg(feature = "postgres")]
                    {
                        let db = {
                            let backends = state.backends.lock().await;
                            backends.db.clone()
                        };
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
                    let mut events = state.events.lock().await;
                    events.ack_events(signing_pubkey, ack.user_id, ack.last_event_id);
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
