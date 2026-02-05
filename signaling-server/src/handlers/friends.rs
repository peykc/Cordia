//! Friend API: requests, codes, redemptions. Auth via Ed25519-signed envelope (no shared secret).

use axum::{
    extract::{State, Extension, rejection::JsonRejection},
    http::{Method, StatusCode},
    response::IntoResponse,
    Json,
};
use chrono::Utc;
use ed25519_dalek::Verifier;
use serde::Deserialize;
use sha2::{Sha256, Digest};
use std::sync::Arc;

use crate::state::AppState;
use crate::state::friends::{CodeRedemption, FriendCode, FriendRequest};
use crate::SignalingMessage;

type SharedState = Arc<AppState>;

/// Verified friend API user id (set by middleware). Newtype so Extension is uniquely keyed.
#[derive(Clone)]
pub struct VerifiedFriendUserId(pub String);

impl std::ops::Deref for VerifiedFriendUserId {
    type Target = str;
    fn deref(&self) -> &str {
        &self.0
    }
}

/// Verify Ed25519-signed friend API request. Envelope: method + "\n" + path + "\n" + timestamp + "\n" + sha256(body).hex().
/// Returns verified user_id or error. No shared secret; mailbox-style.
pub fn verify_friend_sig_ed25519(
    method: &Method,
    path: &str,
    headers: &axum::http::HeaderMap,
    body_bytes: &[u8],
) -> Result<String, (StatusCode, &'static str)> {
    let user_id = headers
        .get("x-user-id")
        .and_then(|v| v.to_str().ok())
        .ok_or((StatusCode::UNAUTHORIZED, "Missing X-User-Id"))?
        .trim()
        .to_string();
    let timestamp = headers
        .get("x-timestamp")
        .and_then(|v| v.to_str().ok())
        .ok_or((StatusCode::UNAUTHORIZED, "Missing X-Timestamp"))?
        .trim();
    let public_key_hex = headers
        .get("x-public-key")
        .and_then(|v| v.to_str().ok())
        .ok_or((StatusCode::UNAUTHORIZED, "Missing X-Public-Key"))?
        .trim();
    let signature_b64 = headers
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

    let body_hash = if body_bytes.is_empty() {
        String::new()
    } else {
        let mut hasher = Sha256::new();
        hasher.update(body_bytes);
        hex::encode(hasher.finalize())
    };
    let envelope = format!(
        "{}\n{}\n{}\n{}",
        method.as_str().to_uppercase(),
        path.trim(),
        ts,
        body_hash,
    );

    let pubkey_bytes = hex::decode(public_key_hex)
        .map_err(|_| (StatusCode::UNAUTHORIZED, "Invalid X-Public-Key hex"))?;
    let verifying_key = ed25519_dalek::VerifyingKey::from_bytes(
        pubkey_bytes
            .as_slice()
            .try_into()
            .map_err(|_| (StatusCode::UNAUTHORIZED, "Invalid X-Public-Key length"))?,
    ).map_err(|_| (StatusCode::UNAUTHORIZED, "Invalid X-Public-Key"))?;
    let sig_bytes = base64::Engine::decode(&base64::engine::general_purpose::STANDARD, signature_b64)
        .map_err(|_| (StatusCode::UNAUTHORIZED, "Invalid X-Signature base64"))?;
    let signature = ed25519_dalek::Signature::from_bytes(
        sig_bytes
            .as_slice()
            .try_into()
            .map_err(|_| (StatusCode::UNAUTHORIZED, "Invalid X-Signature length"))?,
    );

    verifying_key
        .verify(envelope.as_bytes(), &signature)
        .map_err(|_| (StatusCode::UNAUTHORIZED, "Invalid X-Signature"))?;

    Ok(user_id)
}

// ---------- Request bodies ----------

#[derive(Debug, Deserialize)]
pub struct SendFriendRequestBody {
    pub to_user_id: String,
    #[serde(default)]
    pub from_display_name: Option<String>,
    #[serde(default)]
    pub from_account_created_at: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct AcceptDeclineBody {
    pub from_user_id: String,
    #[serde(default)]
    pub from_display_name: Option<String>,
    #[serde(default)]
    pub from_account_created_at: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct RedeemCodeBody {
    pub code: String,
    pub redeemer_user_id: String,
    pub redeemer_display_name: String,
    #[serde(default)]
    pub redeemer_account_created_at: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct AcceptDeclineRedemptionBody {
    pub redeemer_user_id: String,
    #[serde(default)]
    pub code_owner_display_name: Option<String>,
    #[serde(default)]
    pub code_owner_account_created_at: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct RemoveFriendBody {
    pub friend_user_id: String,
}

#[derive(Debug, Deserialize)]
pub struct CancelFriendRequestBody {
    pub to_user_id: String,
}

#[derive(Debug, Deserialize)]
pub struct CancelCodeRedemptionBody {
    pub code_owner_id: String,
}

// ---------- Handlers ----------

/// POST /api/friends/requests — send a friend request. Mutual auto-accept: if B already sent to A, accept both.
pub async fn send_friend_request(
    State(state): State<SharedState>,
    Extension(VerifiedFriendUserId(from_user_id)): Extension<VerifiedFriendUserId>,
    body: Result<Json<SendFriendRequestBody>, JsonRejection>,
) -> impl IntoResponse {
    let body = match body {
        Ok(Json(b)) => b,
        Err(_) => return (StatusCode::BAD_REQUEST, "Invalid JSON").into_response(),
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

        // To B: "A accepted you" (B is to_user_id, A is from_user_id); include A's name for B's list
        let msg_to_b = SignalingMessage::FriendRequestAccepted {
            from_user_id: from_user_id.clone(),
            to_user_id: to_user_id.clone(),
            from_display_name: body.from_display_name.clone(),
            from_account_created_at: body.from_account_created_at.clone(),
        };
        // To A: "B accepted you" so A adds B; we don't have B's name/account_created here (B didn't send it)
        let msg_to_a = SignalingMessage::FriendRequestAccepted {
            from_user_id: to_user_id.clone(),
            to_user_id: from_user_id.clone(),
            from_display_name: None,
            from_account_created_at: None,
        };
        if let Ok(jb) = serde_json::to_string(&msg_to_b) {
            state.friends.read().await.send_to_user(&to_user_id, &jb);
        }
        if let Ok(ja) = serde_json::to_string(&msg_to_a) {
            state.friends.read().await.send_to_user(&from_user_id, &ja);
        }
        return (StatusCode::OK, Json(serde_json::json!({ "accepted": true, "mutual": true }))).into_response();
    }

    if friends.friend_requests.contains_key(&key_ab) {
        return (StatusCode::OK, Json(serde_json::json!({ "accepted": false, "already_sent": true }))).into_response();
    }

    let req = FriendRequest {
        from_user_id: from_user_id.clone(),
        to_user_id: to_user_id.clone(),
        from_display_name: body.from_display_name.clone(),
        from_account_created_at: body.from_account_created_at.clone(),
        created_at: Utc::now(),
    };
    friends.friend_requests.insert(key_ab.clone(), req.clone());
    drop(friends);

    // If target is online, push FriendRequestIncoming.
    let incoming = SignalingMessage::FriendRequestIncoming {
        from_user_id: from_user_id.clone(),
        from_display_name: req.from_display_name.clone(),
        from_account_created_at: req.from_account_created_at.clone(),
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
    Extension(VerifiedFriendUserId(to_user_id)): Extension<VerifiedFriendUserId>,
    body: Result<Json<AcceptDeclineBody>, JsonRejection>,
) -> impl IntoResponse {
    let body = match body {
        Ok(Json(b)) => b,
        Err(_) => return (StatusCode::BAD_REQUEST, "Invalid JSON").into_response(),
    };
    let from_user_id = body.from_user_id.trim().to_string();
    let key = (from_user_id.clone(), to_user_id.clone());
    let mut friends = state.friends.write().await;
    let Some(_req) = friends.friend_requests.remove(&key) else {
        return (StatusCode::NOT_FOUND, "Friend request not found").into_response();
    };
    drop(friends);

    // Tell the requester (from_user_id): "to_user_id accepted you" and pass accepter's display name for their list.
    let msg_to_requester = SignalingMessage::FriendRequestAccepted {
        from_user_id: to_user_id.clone(),
        to_user_id: from_user_id.clone(),
        from_display_name: body.from_display_name.clone(),
        from_account_created_at: body.from_account_created_at.clone(),
    };
    if let Ok(json) = serde_json::to_string(&msg_to_requester) {
        state.friends.read().await.send_to_user(&from_user_id, &json);
    }
    (StatusCode::OK, Json(serde_json::json!({ "accepted": true }))).into_response()
}

/// POST /api/friends/requests/cancel — sender withdraws their request to to_user_id.
pub async fn cancel_friend_request(
    State(state): State<SharedState>,
    Extension(VerifiedFriendUserId(from_user_id)): Extension<VerifiedFriendUserId>,
    body: Result<Json<CancelFriendRequestBody>, JsonRejection>,
) -> impl IntoResponse {
    let body = match body {
        Ok(Json(b)) => b,
        Err(_) => return (StatusCode::BAD_REQUEST, "Invalid JSON").into_response(),
    };
    let to_user_id = body.to_user_id.trim().to_string();
    if to_user_id.is_empty() || from_user_id == to_user_id {
        return (StatusCode::BAD_REQUEST, "Invalid to_user_id").into_response();
    }
    let key = (from_user_id.clone(), to_user_id.clone());
    let mut friends = state.friends.write().await;
    let existed = friends.friend_requests.remove(&key).is_some();
    drop(friends);
    if existed {
        let msg = SignalingMessage::FriendRequestCancelled {
            from_user_id: from_user_id.clone(),
            to_user_id: to_user_id.clone(),
        };
        if let Ok(json) = serde_json::to_string(&msg) {
            state.friends.read().await.send_to_user(&to_user_id, &json);
        }
    }
    // Idempotent: return 200 even when not found (e.g. server restarted, or already cancelled)
    (StatusCode::OK, Json(serde_json::json!({ "cancelled": existed }))).into_response()
}

/// POST /api/friends/requests/decline
pub async fn decline_friend_request(
    State(state): State<SharedState>,
    Extension(VerifiedFriendUserId(to_user_id)): Extension<VerifiedFriendUserId>,
    body: Result<Json<AcceptDeclineBody>, JsonRejection>,
) -> impl IntoResponse {
    let body = match body {
        Ok(Json(b)) => b,
        Err(_) => return (StatusCode::BAD_REQUEST, "Invalid JSON").into_response(),
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

/// POST /api/friends/codes/redemptions/cancel — redeemer withdraws their redemption (removes from code owner's queue).
pub async fn cancel_code_redemption(
    State(state): State<SharedState>,
    Extension(VerifiedFriendUserId(redeemer_user_id)): Extension<VerifiedFriendUserId>,
    body: Result<Json<CancelCodeRedemptionBody>, JsonRejection>,
) -> impl IntoResponse {
    let body = match body {
        Ok(Json(b)) => b,
        Err(_) => return (StatusCode::BAD_REQUEST, "Invalid JSON").into_response(),
    };
    let code_owner_id = body.code_owner_id.trim().to_string();
    if code_owner_id.is_empty() || code_owner_id == redeemer_user_id {
        return (StatusCode::BAD_REQUEST, "Invalid code_owner_id").into_response();
    }
    let mut friends = state.friends.write().await;
    let Some(redemptions) = friends.code_redemptions.get_mut(&code_owner_id) else {
        return (StatusCode::NOT_FOUND, "Redemption not found").into_response();
    };
    let idx = redemptions.iter().position(|r| r.redeemer_user_id == redeemer_user_id);
    let removed = match idx {
        Some(i) => {
            redemptions.remove(i);
            true
        }
        None => false,
    };
    if friends.code_redemptions.get(&code_owner_id).map(|r| r.is_empty()).unwrap_or(false) {
        friends.code_redemptions.remove(&code_owner_id);
    }
    drop(friends);
    if removed {
        let msg = SignalingMessage::FriendCodeRedemptionCancelled {
            code_owner_id: code_owner_id.clone(),
            redeemer_user_id: redeemer_user_id.clone(),
        };
        if let Ok(json) = serde_json::to_string(&msg) {
            state.friends.read().await.send_to_user(&code_owner_id, &json);
        }
    }
    // Idempotent: return 200 even when not found (e.g. server restarted, or already cancelled)
    (StatusCode::OK, Json(serde_json::json!({ "cancelled": removed }))).into_response()
}

/// POST /api/friends/remove — remove a friend; notifies the other user so they remove you too (mutual unfriend).
pub async fn remove_friend(
    State(state): State<SharedState>,
    Extension(VerifiedFriendUserId(from_user_id)): Extension<VerifiedFriendUserId>,
    body: Result<Json<RemoveFriendBody>, JsonRejection>,
) -> impl IntoResponse {
    let body = match body {
        Ok(Json(b)) => b,
        Err(_) => return (StatusCode::BAD_REQUEST, "Invalid JSON").into_response(),
    };
    let friend_user_id = body.friend_user_id.trim().to_string();
    if friend_user_id.is_empty() || from_user_id == friend_user_id {
        return (StatusCode::BAD_REQUEST, "Invalid friend_user_id").into_response();
    }

    let msg = SignalingMessage::FriendRemoved {
        from_user_id: from_user_id.clone(),
    };
    if let Ok(json) = serde_json::to_string(&msg) {
        state.friends.read().await.send_to_user(&friend_user_id, &json);
    }
    (StatusCode::OK, Json(serde_json::json!({ "removed": true }))).into_response()
}

/// POST /api/friends/codes — create (or get existing) friend code.
pub async fn create_friend_code(
    State(state): State<SharedState>,
    Extension(VerifiedFriendUserId(owner_user_id)): Extension<VerifiedFriendUserId>,
) -> impl IntoResponse {
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
    Extension(VerifiedFriendUserId(owner_user_id)): Extension<VerifiedFriendUserId>,
) -> impl IntoResponse {
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
    Extension(VerifiedFriendUserId(_redeemer_user_id)): Extension<VerifiedFriendUserId>,
    body: Result<Json<RedeemCodeBody>, JsonRejection>,
) -> impl IntoResponse {
    let body = match body {
        Ok(Json(b)) => b,
        Err(_) => return (StatusCode::BAD_REQUEST, "Invalid JSON").into_response(),
    };
    let code = body.code.trim().to_uppercase();
    let redeemer_user_id = body.redeemer_user_id.trim().to_string();
    let redeemer_display_name = body.redeemer_display_name.trim().to_string();
    if redeemer_user_id != _redeemer_user_id {
        return (StatusCode::BAD_REQUEST, "redeemer_user_id must match authenticated user").into_response();
    }

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
        return (StatusCode::OK, Json(serde_json::json!({ "pending": true, "code_owner_id": code_owner_id }))).into_response();
    }
    let now = Utc::now();
    redemptions.push(CodeRedemption {
        code_owner_id: code_owner_id.clone(),
        redeemer_user_id: redeemer_user_id.clone(),
        redeemer_display_name: redeemer_display_name.clone(),
        redeemer_account_created_at: body.redeemer_account_created_at.clone(),
        code: code.clone(),
        created_at: now,
    });
    drop(friends);

    let incoming = SignalingMessage::FriendCodeRedemptionIncoming {
        redeemer_user_id: redeemer_user_id.clone(),
        redeemer_display_name: redeemer_display_name.clone(),
        redeemer_account_created_at: body.redeemer_account_created_at.clone(),
        code: code.clone(),
        created_at: now.to_rfc3339(),
    };
    if let Ok(json) = serde_json::to_string(&incoming) {
        state.friends.read().await.send_to_user(&code_owner_id, &json);
    }
    (StatusCode::OK, Json(serde_json::json!({ "pending": true, "code_owner_id": code_owner_id }))).into_response()
}

/// POST /api/friends/codes/redemptions/accept
pub async fn accept_code_redemption(
    State(state): State<SharedState>,
    Extension(VerifiedFriendUserId(code_owner_id)): Extension<VerifiedFriendUserId>,
    body: Result<Json<AcceptDeclineRedemptionBody>, JsonRejection>,
) -> impl IntoResponse {
    let body = match body {
        Ok(Json(b)) => b,
        Err(_) => return (StatusCode::BAD_REQUEST, "Invalid JSON").into_response(),
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
        code_owner_display_name: body.code_owner_display_name.clone(),
        code_owner_account_created_at: body.code_owner_account_created_at.clone(),
    };
    if let Ok(json) = serde_json::to_string(&msg) {
        state.friends.read().await.send_to_user(&redeemer_user_id, &json);
    }
    (StatusCode::OK, Json(serde_json::json!({ "accepted": true }))).into_response()
}

/// POST /api/friends/codes/redemptions/decline
pub async fn decline_code_redemption(
    State(state): State<SharedState>,
    Extension(VerifiedFriendUserId(code_owner_id)): Extension<VerifiedFriendUserId>,
    body: Result<Json<AcceptDeclineRedemptionBody>, JsonRejection>,
) -> impl IntoResponse {
    let body = match body {
        Ok(Json(b)) => b,
        Err(_) => return (StatusCode::BAD_REQUEST, "Invalid JSON").into_response(),
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
