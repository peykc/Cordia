use chrono::Utc;
use hyper::{Body, Method, Request, Response, StatusCode};
use log::{info, warn};
use crate::{
    decode_path_segment, EncryptedHouseHint, InviteTokenCreateRequest,
    HouseEvent, AckRequest,
    state::AppState,
};
use std::sync::Arc;

type SharedState = Arc<AppState>;

#[cfg(feature = "postgres")]
use crate::handlers::db::{
    gc_expired_invites_db, upsert_invite_db, get_invite_db, redeem_invite_db, revoke_invite_db,
    upsert_house_hint_db, get_house_hint_db, insert_event_db, get_events_db, ack_events_db,
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
                        let db = {
                            let backends = state.backends.lock().await;
                            backends.db.clone()
                        };
                        if let Some(pool) = db {
                            if let Err(e) = upsert_house_hint_db(&pool, &hint).await {
                                warn!("Failed to persist house hint: {}", e);
                            }
                        } else {
                            let mut events = state.events.lock().await;
                            // Store the hint
                            events.register_house_hint(signing_pubkey.clone(), hint.clone());
                        }
                    }
                    #[cfg(not(feature = "postgres"))]
                    {
                        let mut events = state.events.lock().await;
                        // Store the hint
                        events.register_house_hint(signing_pubkey.clone(), hint.clone());
                    }
                    // Broadcast snapshot update to any subscribed peers
                    {
                        let signaling = state.signaling.lock().await;
                        signaling.broadcast_house_hint_updated(&signing_pubkey, &hint);
                    }
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

        // GET /api/houses/{signing_pubkey}/hint - Get house hint
        (Method::GET, Some("hint")) => {
            #[cfg(feature = "postgres")]
            {
                let db = {
                    let backends = state.backends.lock().await;
                    backends.db.clone()
                };
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
            let events = state.events.lock().await;
            match events.get_house_hint(&signing_pubkey) {
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
                        let db = {
                            let backends = state.backends.lock().await;
                            backends.db.clone()
                        };
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

                    let mut events = state.events.lock().await;
                    events.post_event(signing_pubkey, event);
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

        // POST /api/houses/{signing_pubkey}/ack - Acknowledge events (alternative path)
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
