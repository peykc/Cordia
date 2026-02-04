//! Friend API: requests, codes, redemptions. Auth via X-User-Id + X-Timestamp + HMAC(X-Signature).

use axum::{
    extract::{State, rejection::JsonRejection},
    http::{HeaderMap, StatusCode},
    response::IntoResponse,
    Json,
};
use chrono::Utc;
use hmac::{Hmac, Mac};
use serde::Deserialize;
use sha2::Sha256;
use std::sync::Arc;

use crate::state::AppState;
use crate::state::friends::{CodeRedemption, FriendCode, FriendRequest};
use crate::SignalingMessage;

type SharedState = Arc<AppState>;

/// Constant-time equality to avoid timing leaks.
fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b.iter()).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// Verify X-User-Id, X-Timestamp, X-Signature (HMAC-SHA256 of user_id+timestamp with shared secret).
/// Returns (user_id,) or Err status + body.
fn verify_friend_auth(
    headers: &HeaderMap,
    secret: &str,
) -> Result<String, (StatusCode, &'static str)> {
    let user_id = headers
        .get("x-user-id")
        .and_then(|v| v.to_str().ok())
        .ok_or((StatusCode::UNAUTHORIZED, "Missing X-User-Id"))?
        .trim();
    let timestamp = headers
        .get("x-timestamp")
        .and_then(|v| v.to_str().ok())
        .ok_or((StatusCode::UNAUTHORIZED, "Missing X-Timestamp"))?
        .trim();
    let signature = headers
        .get("x-signature")
        .and_then(|v| v.to_str().ok())
        .ok_or((StatusCode::UNAUTHORIZED, "Missing X-Signature"))?
        .trim();

    let ts: i64 = timestamp
        .parse()
        .map_err(|_| (StatusCode::UNAUTHORIZED, "Invalid X-Timestamp"))?;
    let now = Utc::now().timestamp();
    if (ts - now).abs() > 300 {
        return Err((StatusCode::UNAUTHORIZED, "X-Timestamp expired"));
    }

    let payload = format!("{}{}", user_id, timestamp);
    type HmacSha256 = Hmac<Sha256>;
    let mut mac =
        HmacSha256::new_from_slice(secret.as_bytes()).map_err(|_| (StatusCode::INTERNAL_SERVER_ERROR, "HMAC init"))?;
    mac.update(payload.as_bytes());
    let result = mac.finalize();
    let expected = hex::encode(result.into_bytes());
    let sig_bytes = hex::decode(signature).map_err(|_| (StatusCode::UNAUTHORIZED, "Invalid X-Signature hex"))?;
    let expected_bytes = hex::decode(&expected).map_err(|_| (StatusCode::INTERNAL_SERVER_ERROR, "hex"))?;
    if !constant_time_eq(&sig_bytes, &expected_bytes) {
        return Err((StatusCode::UNAUTHORIZED, "Invalid X-Signature"));
    }
    Ok(user_id.to_string())
}

/// Extract authenticated user for friend API. Use in handlers that need State + HeaderMap.
async fn auth_user(
    State(state): State<SharedState>,
    headers: HeaderMap,
) -> Result<String, (StatusCode, &'static str)> {
    let secret = state
        .friend_api_secret
        .as_deref()
        .ok_or((StatusCode::SERVICE_UNAVAILABLE, "Friend API not configured"))?;
    verify_friend_auth(&headers, secret)
}

// ---------- Request bodies ----------

#[derive(Debug, Deserialize)]
pub struct SendFriendRequestBody {
    pub to_user_id: String,
    #[serde(default)]
    pub from_display_name: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct AcceptDeclineBody {
    pub from_user_id: String,
}

#[derive(Debug, Deserialize)]
pub struct RedeemCodeBody {
    pub code: String,
    pub redeemer_user_id: String,
    pub redeemer_display_name: String,
}

#[derive(Debug, Deserialize)]
pub struct AcceptDeclineRedemptionBody {
    pub redeemer_user_id: String,
}

// ---------- Handlers ----------

/// POST /api/friends/requests — send a friend request. Mutual auto-accept: if B already sent to A, accept both.
pub async fn send_friend_request(
    State(state): State<SharedState>,
    headers: HeaderMap,
    body: Result<Json<SendFriendRequestBody>, JsonRejection>,
) -> impl IntoResponse {
    let body = match body {
        Ok(Json(b)) => b,
        Err(_) => return (StatusCode::BAD_REQUEST, "Invalid JSON").into_response(),
    };
    let from_user_id = match auth_user(State(state.clone()), headers).await {
        Ok(u) => u,
        Err((code, msg)) => return (code, msg).into_response(),
    };
    let to_user_id = body.to_user_id.trim().to_string();
    if to_user_id.is_empty() || from_user_id == to_user_id {
        return (StatusCode::BAD_REQUEST, "Invalid to_user_id").into_response();
    }

    let mut friends = state.friends.write().await;
    let key_ab = (from_user_id.clone(), to_user_id.clone());
    let key_ba = (to_user_id.clone(), from_user_id.clone());

    // Mutual auto-accept: if B already sent request to A, accept both (no new request).
    if friends.friend_requests.contains_key(&key_ba) {
        friends.friend_requests.remove(&key_ba);
        drop(friends);

        let msg_accepted = SignalingMessage::FriendRequestAccepted {
            from_user_id: to_user_id.clone(),
            to_user_id: from_user_id.clone(),
        };
        let msg_accepted_json = serde_json::to_string(&msg_accepted).unwrap_or_default();
        let msg_for_requester = SignalingMessage::FriendRequestAccepted {
            from_user_id: from_user_id.clone(),
            to_user_id: to_user_id.clone(),
        };
        let msg_for_requester_json = serde_json::to_string(&msg_for_requester).unwrap_or_default();

        state.friends.read().await.send_to_user(&from_user_id, &msg_for_requester_json);
        state.friends.read().await.send_to_user(&to_user_id, &msg_accepted_json);
        return (StatusCode::OK, Json(serde_json::json!({ "accepted": true, "mutual": true }))).into_response();
    }

    if friends.friend_requests.contains_key(&key_ab) {
        return (StatusCode::OK, Json(serde_json::json!({ "accepted": false, "already_sent": true }))).into_response();
    }

    let req = FriendRequest {
        from_user_id: from_user_id.clone(),
        to_user_id: to_user_id.clone(),
        from_display_name: body.from_display_name.clone(),
        created_at: Utc::now(),
    };
    friends.friend_requests.insert(key_ab.clone(), req.clone());
    drop(friends);

    // If target is online, push FriendRequestIncoming.
    let incoming = SignalingMessage::FriendRequestIncoming {
        from_user_id: from_user_id.clone(),
        from_display_name: req.from_display_name.clone(),
        created_at: req.created_at.to_rfc3339(),
    };
    if let Ok(json) = serde_json::to_string(&incoming) {
        state.friends.read().await.send_to_user(&to_user_id, &json);
    }

    (StatusCode::OK, Json(serde_json::json!({ "accepted": false, "sent": true }))).into_response()
}

/// POST /api/friends/requests/accept
pub async fn accept_friend_request(
    State(state): State<SharedState>,
    headers: HeaderMap,
    body: Result<Json<AcceptDeclineBody>, JsonRejection>,
) -> impl IntoResponse {
    let body = match body {
        Ok(Json(b)) => b,
        Err(_) => return (StatusCode::BAD_REQUEST, "Invalid JSON").into_response(),
    };
    let to_user_id = match auth_user(State(state.clone()), headers).await {
        Ok(u) => u,
        Err((code, msg)) => return (code, msg).into_response(),
    };
    let from_user_id = body.from_user_id.trim().to_string();
    let key = (from_user_id.clone(), to_user_id.clone());
    let mut friends = state.friends.write().await;
    let Some(_req) = friends.friend_requests.remove(&key) else {
        return (StatusCode::NOT_FOUND, "Friend request not found").into_response();
    };
    drop(friends);

    let msg = SignalingMessage::FriendRequestAccepted {
        from_user_id: from_user_id.clone(),
        to_user_id: to_user_id.clone(),
    };
    if let Ok(json) = serde_json::to_string(&msg) {
        state.friends.read().await.send_to_user(&from_user_id, &json);
    }
    (StatusCode::OK, Json(serde_json::json!({ "accepted": true }))).into_response()
}

/// POST /api/friends/requests/decline
pub async fn decline_friend_request(
    State(state): State<SharedState>,
    headers: HeaderMap,
    body: Result<Json<AcceptDeclineBody>, JsonRejection>,
) -> impl IntoResponse {
    let body = match body {
        Ok(Json(b)) => b,
        Err(_) => return (StatusCode::BAD_REQUEST, "Invalid JSON").into_response(),
    };
    let to_user_id = match auth_user(State(state.clone()), headers).await {
        Ok(u) => u,
        Err((code, msg)) => return (code, msg).into_response(),
    };
    let from_user_id = body.from_user_id.trim().to_string();
    let key = (from_user_id.clone(), to_user_id.clone());
    let mut friends = state.friends.write().await;
    let existed = friends.friend_requests.remove(&key).is_some();
    drop(friends);
    if !existed {
        return (StatusCode::NOT_FOUND, "Friend request not found").into_response();
    }
    let msg = SignalingMessage::FriendRequestDeclined {
        from_user_id: from_user_id.clone(),
        to_user_id: to_user_id.clone(),
    };
    if let Ok(json) = serde_json::to_string(&msg) {
        state.friends.read().await.send_to_user(&from_user_id, &json);
    }
    (StatusCode::OK, Json(serde_json::json!({ "declined": true }))).into_response()
}

/// POST /api/friends/codes — create (or get existing) friend code.
pub async fn create_friend_code(
    State(state): State<SharedState>,
    headers: HeaderMap,
) -> impl IntoResponse {
    let owner_user_id = match auth_user(State(state.clone()), headers).await {
        Ok(u) => u,
        Err((code, msg)) => return (code, msg).into_response(),
    };
    const CODE_LEN: usize = 8;
    let code: String = (0..CODE_LEN)
        .map(|_| {
            const CHARS: &[u8] = b"ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
            let idx = (rand::random::<u32>() as usize) % CHARS.len();
            CHARS[idx] as char
        })
        .collect();
    let now = Utc::now();
    let record = FriendCode {
        owner_user_id: owner_user_id.clone(),
        code: code.clone(),
        created_at: now,
        revoked: false,
    };
    let mut friends = state.friends.write().await;
    // Revoke any previous code for this user (one active code per user).
    friends.friend_codes.retain(|_, v| v.owner_user_id != owner_user_id);
    friends.friend_codes.insert(code.clone(), record);
    drop(friends);
    (
        StatusCode::OK,
        Json(serde_json::json!({ "code": code, "created_at": now.to_rfc3339() })),
    )
        .into_response()
}

/// POST /api/friends/codes/revoke
pub async fn revoke_friend_code(
    State(state): State<SharedState>,
    headers: HeaderMap,
) -> impl IntoResponse {
    let owner_user_id = match auth_user(State(state.clone()), headers).await {
        Ok(u) => u,
        Err((code, msg)) => return (code, msg).into_response(),
    };
    let mut friends = state.friends.write().await;
    let mut revoked = false;
    for v in friends.friend_codes.values_mut() {
        if v.owner_user_id == owner_user_id {
            v.revoked = true;
            revoked = true;
        }
    }
    drop(friends);
    (StatusCode::OK, Json(serde_json::json!({ "revoked": revoked }))).into_response()
}

/// POST /api/friends/codes/redeem — use someone's code; they get a pending redemption.
pub async fn redeem_friend_code(
    State(state): State<SharedState>,
    headers: HeaderMap,
    body: Result<Json<RedeemCodeBody>, JsonRejection>,
) -> impl IntoResponse {
    let body = match body {
        Ok(Json(b)) => b,
        Err(_) => return (StatusCode::BAD_REQUEST, "Invalid JSON").into_response(),
    };
    let _redeemer = match auth_user(State(state.clone()), headers).await {
        Ok(u) => u,
        Err((code, msg)) => return (code, msg).into_response(),
    };
    let code = body.code.trim().to_uppercase();
    let redeemer_user_id = body.redeemer_user_id.trim().to_string();
    let redeemer_display_name = body.redeemer_display_name.trim().to_string();

    let mut friends = state.friends.write().await;
    let Some(fc) = friends.friend_codes.get(&code) else {
        return (StatusCode::NOT_FOUND, "Friend code not found").into_response();
    };
    if fc.revoked {
        return (StatusCode::GONE, "Friend code revoked").into_response();
    }
    let code_owner_id = fc.owner_user_id.clone();
    if code_owner_id == redeemer_user_id {
        return (StatusCode::BAD_REQUEST, "Cannot redeem your own code").into_response();
    }
    let redemptions = friends.code_redemptions.entry(code_owner_id.clone()).or_default();
    if redemptions.iter().any(|r| r.redeemer_user_id == redeemer_user_id) {
        return (StatusCode::OK, Json(serde_json::json!({ "pending": true }))).into_response();
    }
    let now = Utc::now();
    redemptions.push(CodeRedemption {
        code_owner_id: code_owner_id.clone(),
        redeemer_user_id: redeemer_user_id.clone(),
        redeemer_display_name: redeemer_display_name.clone(),
        code: code.clone(),
        created_at: now,
    });
    drop(friends);

    let incoming = SignalingMessage::FriendCodeRedemptionIncoming {
        redeemer_user_id: redeemer_user_id.clone(),
        redeemer_display_name: redeemer_display_name.clone(),
        code: code.clone(),
        created_at: now.to_rfc3339(),
    };
    if let Ok(json) = serde_json::to_string(&incoming) {
        state.friends.read().await.send_to_user(&code_owner_id, &json);
    }
    (StatusCode::OK, Json(serde_json::json!({ "pending": true }))).into_response()
}

/// POST /api/friends/codes/redemptions/accept
pub async fn accept_code_redemption(
    State(state): State<SharedState>,
    headers: HeaderMap,
    body: Result<Json<AcceptDeclineRedemptionBody>, JsonRejection>,
) -> impl IntoResponse {
    let body = match body {
        Ok(Json(b)) => b,
        Err(_) => return (StatusCode::BAD_REQUEST, "Invalid JSON").into_response(),
    };
    let code_owner_id = match auth_user(State(state.clone()), headers).await {
        Ok(u) => u,
        Err((code, msg)) => return (code, msg).into_response(),
    };
    let redeemer_user_id = body.redeemer_user_id.trim().to_string();
    let mut friends = state.friends.write().await;
    let Some(redemptions) = friends.code_redemptions.get_mut(&code_owner_id) else {
        return (StatusCode::NOT_FOUND, "No redemptions").into_response();
    };
    let Some(idx) = redemptions.iter().position(|r| r.redeemer_user_id == redeemer_user_id) else {
        return (StatusCode::NOT_FOUND, "Redemption not found").into_response();
    };
    redemptions.remove(idx);
    if redemptions.is_empty() {
        friends.code_redemptions.remove(&code_owner_id);
    }
    drop(friends);

    let msg = SignalingMessage::FriendCodeRedemptionAccepted {
        code_owner_id: code_owner_id.clone(),
        redeemer_user_id: redeemer_user_id.clone(),
    };
    if let Ok(json) = serde_json::to_string(&msg) {
        state.friends.read().await.send_to_user(&redeemer_user_id, &json);
    }
    (StatusCode::OK, Json(serde_json::json!({ "accepted": true }))).into_response()
}

/// POST /api/friends/codes/redemptions/decline
pub async fn decline_code_redemption(
    State(state): State<SharedState>,
    headers: HeaderMap,
    body: Result<Json<AcceptDeclineRedemptionBody>, JsonRejection>,
) -> impl IntoResponse {
    let body = match body {
        Ok(Json(b)) => b,
        Err(_) => return (StatusCode::BAD_REQUEST, "Invalid JSON").into_response(),
    };
    let code_owner_id = match auth_user(State(state.clone()), headers).await {
        Ok(u) => u,
        Err((code, msg)) => return (code, msg).into_response(),
    };
    let redeemer_user_id = body.redeemer_user_id.trim().to_string();
    let mut friends = state.friends.write().await;
    let redemptions = friends.code_redemptions.get_mut(&code_owner_id);
    let removed = redemptions
        .map(|r| {
            let idx = r.iter().position(|x| x.redeemer_user_id == redeemer_user_id);
            if let Some(i) = idx {
                r.remove(i);
                true
            } else {
                false
            }
        })
        .unwrap_or(false);
    if let Some(r) = friends.code_redemptions.get(&code_owner_id) {
        if r.is_empty() {
            friends.code_redemptions.remove(&code_owner_id);
        }
    }
    drop(friends);
    if !removed {
        return (StatusCode::NOT_FOUND, "Redemption not found").into_response();
    }
    let msg = SignalingMessage::FriendCodeRedemptionDeclined {
        code_owner_id: code_owner_id.clone(),
        redeemer_user_id: redeemer_user_id.clone(),
    };
    if let Ok(json) = serde_json::to_string(&msg) {
        state.friends.read().await.send_to_user(&redeemer_user_id, &json);
    }
    (StatusCode::OK, Json(serde_json::json!({ "declined": true }))).into_response()
}
