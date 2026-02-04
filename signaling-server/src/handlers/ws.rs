use axum::extract::ws::{Message as AxumMessage, WebSocket, WebSocketUpgrade};
use axum::extract::{State, Extension};
use axum::http::StatusCode;
use axum::response::IntoResponse;
use futures_util::{SinkExt, StreamExt};
use log::{error, info, warn};
use std::sync::Arc;
use tokio::sync::mpsc;

use crate::handlers::message::handle_message;
use crate::security::ClientIp;
use crate::state::AppState;
use crate::{ConnId, SignalingMessage};

type SharedState = Arc<AppState>;

#[cfg(feature = "redis-backend")]
use crate::handlers::redis::redis_presence_disconnect;

fn tungstenite_to_axum(msg: tokio_tungstenite::tungstenite::Message) -> AxumMessage {
    use tokio_tungstenite::tungstenite::Message as WsMsg;
    match msg {
        WsMsg::Text(s) => AxumMessage::Text(s),
        WsMsg::Binary(v) => AxumMessage::Binary(v),
        WsMsg::Ping(v) => AxumMessage::Ping(v),
        WsMsg::Pong(v) => AxumMessage::Pong(v),
        WsMsg::Close(_) => AxumMessage::Close(None),
        WsMsg::Frame(_) => unreachable!(),
    }
}

pub async fn ws_handler(
    ws: WebSocketUpgrade,
    State(state): State<SharedState>,
    Extension(ClientIp(client_ip)): Extension<ClientIp>,
) -> axum::response::Response {
    {
        let tracker = state.connection_tracker.read().await;
        if !tracker.can_accept(&client_ip) {
            return (StatusCode::SERVICE_UNAVAILABLE, "Connection limit reached").into_response();
        }
    }
    ws.on_upgrade(move |socket| handle_connection_axum(socket, state, client_ip))
}

async fn handle_connection_axum(socket: WebSocket, state: SharedState, client_ip: String) {
    if state.connection_tracker.write().await.try_register(&client_ip).is_err() {
        return;
    }

    info!("WebSocket connection established");

    let conn_id: ConnId = uuid::Uuid::new_v4().to_string();
    let (tx, mut rx) = mpsc::unbounded_channel::<tokio_tungstenite::tungstenite::Message>();

    let (mut ws_sender, mut ws_receiver) = socket.split();

    let mut send_task = tokio::spawn(async move {
        while let Some(msg) = rx.recv().await {
            let axum_msg = tungstenite_to_axum(msg);
            if ws_sender.send(axum_msg).await.is_err() {
                break;
            }
        }
    });

    loop {
        tokio::select! {
            msg_opt = ws_receiver.next() => {
                match msg_opt {
                    Some(Ok(AxumMessage::Text(text))) => {
                        if let Some(ref limiter) = state.ws_rate_limiter {
                            if !limiter.check_key(&client_ip) {
                                let error_msg = SignalingMessage::Error {
                                    message: "Rate limit exceeded".to_string(),
                                };
                                if let Ok(json) = serde_json::to_string(&error_msg) {
                                    let _ = tx.send(tokio_tungstenite::tungstenite::Message::Text(json));
                                }
                                continue;
                            }
                        }
                        match serde_json::from_str::<SignalingMessage>(&text) {
                            Ok(msg) => {
                                if let Err(e) = handle_message(msg, &conn_id, &state, &tx).await {
                                    warn!("Error handling message: {}", e);
                                    let error_msg = SignalingMessage::Error {
                                        message: e.to_string(),
                                    };
                                    if let Ok(json) = serde_json::to_string(&error_msg) {
                                        let _ = tx.send(tokio_tungstenite::tungstenite::Message::Text(json));
                                    }
                                }
                            }
                            Err(e) => {
                                warn!("Failed to parse message: {}", e);
                                let error_msg = SignalingMessage::Error {
                                    message: format!("Invalid message format: {}", e),
                                };
                                if let Ok(json) = serde_json::to_string(&error_msg) {
                                    let _ = tx.send(tokio_tungstenite::tungstenite::Message::Text(json));
                                }
                            }
                        }
                    }
                    Some(Ok(AxumMessage::Close(_))) => {
                        info!("Client closed connection");
                        break;
                    }
                    Some(Ok(AxumMessage::Ping(data))) => {
                        let _ = tx.send(tokio_tungstenite::tungstenite::Message::Pong(data));
                    }
                    Some(Ok(_)) => {}
                    Some(Err(e)) => {
                        error!("WebSocket error: {}", e);
                        break;
                    }
                    None => break,
                }
            }
            _ = &mut send_task => break,
        }
    }

    let server_signing_map = {
        let voice = state.voice.read().await;
        voice.server_signing_pubkeys.clone()
    };

    let (presence_removed, voice_removed, redis_client) = {
        let mut signaling = state.signaling.write().await;

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

        let mut voice = state.voice.write().await;
        let voice_removed = voice.handle_voice_disconnect(&conn_id);
        drop(voice);

        let mut presence = state.presence.write().await;
        let presence_removed = presence.remove_presence_conn(&conn_id);
        drop(presence);

        #[cfg(feature = "redis-backend")]
        let redis_client = {
            let backends = state.backends.read().await;
            backends.redis.clone()
        };
        #[cfg(not(feature = "redis-backend"))]
        let redis_client: Option<()> = None;

        (presence_removed, voice_removed, redis_client)
    };

    if !voice_removed.is_empty() {
        for (server_id, chat_id, peer_id, user_id) in voice_removed.clone() {
            info!(
                "Voice peer {} (user {}) disconnected from chat {}",
                peer_id, user_id, chat_id
            );
            let msg = SignalingMessage::VoicePeerLeft {
                peer_id,
                user_id: user_id.clone(),
                chat_id: chat_id.clone(),
            };
            state
                .broadcast_to_voice_room(&server_id, &chat_id, &msg, None)
                .await;
        }

        for (server_id, chat_id, _, user_id) in voice_removed {
            if let Some(signing_pubkey) = server_signing_map.get(&server_id) {
                state
                    .broadcast_voice_presence(signing_pubkey, &user_id, &chat_id, false)
                    .await;
            }
        }
    }

    if let Some((user_id, spks)) = presence_removed {
        state.friends.write().await.unregister_connection(&user_id, &conn_id);

        #[cfg(feature = "redis-backend")]
        if let Some(client) = redis_client.as_ref() {
            if let Err(e) = redis_presence_disconnect(client, &user_id, &spks).await {
                warn!("Redis presence disconnect failed: {}", e);
            }
        }

        for spk in spks {
            state
                .broadcast_presence_update(&spk, &user_id, false, None)
                .await;
        }
        state.broadcast_friend_presence_update(&user_id, false, None).await;
    }

    send_task.abort();

    state.connection_tracker.write().await.unregister(&client_ip);
}
