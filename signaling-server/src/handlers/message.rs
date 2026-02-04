use std::sync::Arc;
use log::{info, warn};
use crate::{
    SignalingMessage, ConnId, ServerId, SigningPubkey, WebSocketSender,
    ProfileRecord, ProfileSnapshotRecord,
    FriendRequestIncomingItem, CodeRedemptionItem,
    state::AppState,
    state::presence::PresenceUserStatus,
    state::signaling::{FRIENDS_PEER_PREFIX, FRIENDS_SIGNING_PUBKEY},
};

type SharedState = Arc<AppState>;

#[cfg(feature = "postgres")]
use crate::handlers::db::{upsert_profile_db, load_profiles_db};
#[cfg(feature = "redis-backend")]
use crate::handlers::redis::{redis_presence_hello, redis_presence_active, redis_presence_snapshot};

pub async fn handle_message(
    msg: SignalingMessage,
    conn_id: &ConnId,
    state: &SharedState,
    sender: &WebSocketSender,
) -> Result<(), String> {
    match msg {
        SignalingMessage::Register { server_id, peer_id, signing_pubkey } => {
            let mut signaling = state.signaling.write().await;
            let peers = signaling.register_peer(peer_id.clone(), server_id.clone(), signing_pubkey, conn_id.clone());

            // Store the sender for this peer
            signaling.peer_senders.insert(peer_id.clone(), sender.clone());
            drop(signaling);

            info!("Registered peer {} in server {}", peer_id, server_id);

            let response = SignalingMessage::Registered {
                peer_id: peer_id.clone(),
                peers,
            };

            let json = serde_json::to_string(&response)
                .map_err(|e| format!("Failed to serialize response: {}", e))?;

            sender
                .send(tokio_tungstenite::tungstenite::Message::Text(json))
                .map_err(|e| format!("Failed to send response: {}", e))?;

            Ok(())
        }
        SignalingMessage::PresenceHello { user_id, signing_pubkeys, active_signing_pubkey, friend_user_ids } => {
            let (affected_spks, redis_client, redis_ttl, local_snaps) = {
                let mut presence = state.presence.write().await;
                // Upsert presence
                let affected_spks = presence.upsert_presence_hello(conn_id, user_id.clone(), signing_pubkeys.clone(), active_signing_pubkey.clone());
                drop(presence);
                
                // LOCK BOUNDARY: Extract data here, unlock before IO
                #[cfg(feature = "redis-backend")]
                let redis_client = {
                    let backends = state.backends.read().await;
                    backends.redis.clone()
                };
                #[cfg(not(feature = "redis-backend"))]
                let redis_client: Option<()> = None;
                #[cfg(feature = "redis-backend")]
                let redis_ttl = {
                    let backends = state.backends.read().await;
                    backends.redis_presence_ttl_secs
                };
                #[cfg(not(feature = "redis-backend"))]
                let redis_ttl: u64 = 0;

                let local_snaps: Vec<(SigningPubkey, Vec<PresenceUserStatus>)> = if redis_client.is_none() {
                    let presence = state.presence.read().await;
                    let snaps: Vec<_> = signing_pubkeys
                        .iter()
                        .map(|spk| (spk.clone(), presence.presence_snapshot_for(spk)))
                        .collect();
                    drop(presence);
                    snaps
                } else {
                    Vec::new()
                };
                (affected_spks, redis_client, redis_ttl, local_snaps)
            };

            // IO operations happen after lock is released
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
                        let _ = sender.send(tokio_tungstenite::tungstenite::Message::Text(json));
                    }
                }
            } else {
                for (spk, users) in local_snaps {
                    let snap = SignalingMessage::PresenceSnapshot {
                        signing_pubkey: spk,
                        users,
                    };
                    if let Ok(json) = serde_json::to_string(&snap) {
                        let _ = sender.send(tokio_tungstenite::tungstenite::Message::Text(json));
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
                        let _ = sender.send(tokio_tungstenite::tungstenite::Message::Text(json));
                    }
                }
            }

            // Broadcast this user's presence to relevant houses
            for spk in affected_spks {
                state.broadcast_presence_update(&spk, &user_id, true, active_signing_pubkey.clone()).await;
            }

            // Friend-scoped presence: subscribe this connection to friend_user_ids and broadcast this user to friends
            const MAX_FRIEND_IDS: usize = 1000;
            let friend_user_ids: Vec<String> = friend_user_ids.into_iter().take(MAX_FRIEND_IDS).collect();
            if !friend_user_ids.is_empty() {
                let friend_snap: Vec<PresenceUserStatus> = {
                    let presence = state.presence.read().await;
                    friend_user_ids
                        .iter()
                        .filter_map(|uid| {
                            presence.presence_users.get(uid).map(|u| PresenceUserStatus {
                                user_id: uid.clone(),
                                active_signing_pubkey: u.active_signing_pubkey.clone(),
                            })
                        })
                        .collect()
                };
                let friend_ids_set: std::collections::HashSet<String> = friend_user_ids.iter().cloned().collect();
                let mut signaling = state.signaling.write().await;
                let friends_peer_id = format!("{}{}", FRIENDS_PEER_PREFIX, conn_id);
                // If this conn already had a friend subscription, remove it before re-adding (e.g. friends list changed)
                if let Some(old_ids) = signaling.conn_friend_ids.remove(conn_id) {
                    for uid in &old_ids {
                        if let Some(subs) = signaling.friend_presence_subscribers.get_mut(uid) {
                            subs.remove(&friends_peer_id);
                            if subs.is_empty() {
                                signaling.friend_presence_subscribers.remove(uid);
                            }
                        }
                    }
                }
                signaling.peer_senders.insert(friends_peer_id.clone(), sender.clone());
                signaling.conn_peers.entry(conn_id.clone()).or_default().insert(friends_peer_id.clone());
                signaling.conn_friend_ids.insert(conn_id.clone(), friend_ids_set.clone());
                for uid in &friend_ids_set {
                    signaling.friend_presence_subscribers.entry(uid.clone()).or_default().insert(friends_peer_id.clone());
                }
                drop(signaling);
                let snap = SignalingMessage::PresenceSnapshot {
                    signing_pubkey: FRIENDS_SIGNING_PUBKEY.to_string(),
                    users: friend_snap,
                };
                if let Ok(json) = serde_json::to_string(&snap) {
                    let _ = sender.send(tokio_tungstenite::tungstenite::Message::Text(json));
                }
                state.broadcast_friend_presence_update(&user_id, true, active_signing_pubkey.clone()).await;
            }

            // Register this connection for friend delivery and send pending snapshot
            {
                let mut friends = state.friends.write().await;
                friends.register_connection(&user_id, conn_id.clone(), sender.clone());
                let pending_incoming: Vec<FriendRequestIncomingItem> = friends
                    .friend_requests
                    .iter()
                    .filter(|((_, to), _)| to == &user_id)
                    .map(|(_, req)| FriendRequestIncomingItem {
                        from_user_id: req.from_user_id.clone(),
                        from_display_name: req.from_display_name.clone(),
                        from_account_created_at: req.from_account_created_at.clone(),
                        created_at: req.created_at.to_rfc3339(),
                    })
                    .collect();
                let pending_outgoing: Vec<String> = friends
                    .friend_requests
                    .iter()
                    .filter(|((from, _), _)| from == &user_id)
                    .map(|((_, to), _)| to.clone())
                    .collect();
                let pending_code_redemptions: Vec<CodeRedemptionItem> = friends
                    .code_redemptions
                    .get(&user_id)
                    .map(|v| {
                        v.iter()
                            .map(|r| CodeRedemptionItem {
                                redeemer_user_id: r.redeemer_user_id.clone(),
                                redeemer_display_name: r.redeemer_display_name.clone(),
                                redeemer_account_created_at: r.redeemer_account_created_at.clone(),
                                code: r.code.clone(),
                                created_at: r.created_at.to_rfc3339(),
                            })
                            .collect()
                    })
                    .unwrap_or_default();
                drop(friends);
                let snap = SignalingMessage::FriendPendingSnapshot {
                    pending_incoming,
                    pending_outgoing,
                    pending_code_redemptions,
                };
                if let Ok(json) = serde_json::to_string(&snap) {
                    let _ = sender.send(tokio_tungstenite::tungstenite::Message::Text(json));
                }
            }

            Ok(())
        }
        SignalingMessage::PresenceActive { user_id, active_signing_pubkey } => {
            let (spks, redis_client, redis_ttl) = {
                let mut presence = state.presence.write().await;
                let spks = presence.update_presence_active(&user_id, active_signing_pubkey.clone());
                drop(presence);
                
                #[cfg(feature = "redis-backend")]
                let redis_client = {
                    let backends = state.backends.read().await;
                    backends.redis.clone()
                };
                #[cfg(not(feature = "redis-backend"))]
                let redis_client: Option<()> = None;
                #[cfg(feature = "redis-backend")]
                let redis_ttl = {
                    let backends = state.backends.read().await;
                    backends.redis_presence_ttl_secs
                };
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
                for spk in spks {
                    state.broadcast_presence_update(&spk, &user_id, true, active_signing_pubkey.clone()).await;
                }
            }
            state.broadcast_friend_presence_update(&user_id, true, active_signing_pubkey.clone()).await;
            Ok(())
        }
        SignalingMessage::ProfileAnnounce { user_id, display_name, real_name, show_real_name, rev, signing_pubkeys } => {
            let (rec_opt, db_opt) = {
                let mut profiles = state.profiles.write().await;
                let update = match profiles.profiles.get(&user_id) {
                    Some(existing) => rev > existing.rev,
                    None => true,
                };

                if update {
                    profiles.profiles.insert(
                        user_id.clone(),
                        ProfileRecord {
                            display_name: display_name.clone(),
                            real_name: real_name.clone(),
                            show_real_name,
                            rev,
                        },
                    );
                }

                let rec = profiles.profiles.get(&user_id).cloned();
                drop(profiles);
                
                // Broadcast profile updates to servers and to friends
                if let Some(ref r) = rec {
                    for spk in signing_pubkeys.iter() {
                        state.broadcast_profile_update(spk, &user_id, r).await;
                    }
                    state.broadcast_profile_update_to_friends(&user_id, r).await;
                }

                // LOCK BOUNDARY: Extract data here, unlock before IO
                #[cfg(feature = "postgres")]
                let db = {
                    let backends = state.backends.read().await;
                    backends.db.clone()
                };
                #[cfg(not(feature = "postgres"))]
                let db: Option<()> = None;

                (rec, db)
            };

            // Persist the latest profile so offline users can catch up even after restarts.
            // IO operation happens after lock is released
            #[cfg(feature = "postgres")]
            if let (Some(pool), Some(rec)) = (db_opt, rec_opt.as_ref()) {
                let _ = upsert_profile_db(&pool, &user_id, rec).await;
            }

            Ok(())
        }
        SignalingMessage::ProfileHello { signing_pubkey, user_ids } => {
            // Prefer DB if available; otherwise fall back to in-memory cache.
            // LOCK BOUNDARY: Extract data here, unlock before IO
            #[cfg(feature = "postgres")]
            let db = {
                let backends = state.backends.read().await;
                backends.db.clone()
            };

            #[cfg(feature = "postgres")]
            let out: Vec<ProfileSnapshotRecord> = if let Some(pool) = db {
                load_profiles_db(&pool, &user_ids).await.unwrap_or_default()
            } else {
                let profiles = state.profiles.read().await;
                user_ids
                    .iter()
                    .filter_map(|uid| profiles.profiles.get(uid).map(|rec| ProfileSnapshotRecord {
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
                let profiles = state.profiles.read().await;
                user_ids
                    .iter()
                    .filter_map(|uid| profiles.profiles.get(uid).map(|rec| ProfileSnapshotRecord {
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
                let _ = sender.send(tokio_tungstenite::tungstenite::Message::Text(json));
            }
            Ok(())
        }
        SignalingMessage::Offer { from_peer, to_peer, sdp } => {
            info!("Forwarding offer from {} to {}", from_peer, to_peer);

            let target_sender = state.signaling.read().await.validate_and_get_target_sender(&from_peer, conn_id, &to_peer);
            match target_sender {
                Ok(Some(sender)) => {
                    let forward_msg = SignalingMessage::Offer { from_peer, to_peer, sdp };
                    let json = serde_json::to_string(&forward_msg).map_err(|e| format!("Failed to serialize offer: {}", e))?;
                    sender.send(tokio_tungstenite::tungstenite::Message::Text(json)).map_err(|e| format!("Failed to forward offer: {}", e))?;
                }
                Ok(None) => warn!("Target peer {} not found for offer", to_peer),
                Err(()) => return Err(format!("Invalid peer_id {} for connection {}", from_peer, conn_id)),
            }
            Ok(())
        }
        SignalingMessage::Answer { from_peer, to_peer, sdp } => {
            info!("Forwarding answer from {} to {}", from_peer, to_peer);

            let target_sender = state.signaling.read().await.validate_and_get_target_sender(&from_peer, conn_id, &to_peer);
            match target_sender {
                Ok(Some(sender)) => {
                    let forward_msg = SignalingMessage::Answer { from_peer, to_peer, sdp };
                    let json = serde_json::to_string(&forward_msg).map_err(|e| format!("Failed to serialize answer: {}", e))?;
                    sender.send(tokio_tungstenite::tungstenite::Message::Text(json)).map_err(|e| format!("Failed to forward answer: {}", e))?;
                }
                Ok(None) => warn!("Target peer {} not found for answer", to_peer),
                Err(()) => return Err(format!("Invalid peer_id {} for connection {}", from_peer, conn_id)),
            }
            Ok(())
        }
        SignalingMessage::IceCandidate { from_peer, to_peer, candidate } => {
            info!("Forwarding ICE candidate from {} to {}", from_peer, to_peer);

            let target_sender = state.signaling.read().await.validate_and_get_target_sender(&from_peer, conn_id, &to_peer);
            match target_sender {
                Ok(Some(sender)) => {
                    let forward_msg = SignalingMessage::IceCandidate { from_peer, to_peer, candidate };
                    let json = serde_json::to_string(&forward_msg).map_err(|e| format!("Failed to serialize ICE candidate: {}", e))?;
                    sender.send(tokio_tungstenite::tungstenite::Message::Text(json)).map_err(|e| format!("Failed to forward ICE candidate: {}", e))?;
                }
                Ok(None) => warn!("Target peer {} not found for ICE candidate", to_peer),
                Err(()) => return Err(format!("Invalid peer_id {} for connection {}", from_peer, conn_id)),
            }
            Ok(())
        }

        // === Voice Chat Messages ===

        SignalingMessage::VoiceRegister { server_id, chat_id, peer_id, user_id, signing_pubkey } => {
            info!("Voice register: peer={} user={} server={} chat={}", peer_id, user_id, server_id, chat_id);

            let peers = {
                let mut signaling = state.signaling.write().await;

                // Register peer if not already registered (allows voice-first registration)
                if !signaling.peers.contains_key(&peer_id) {
                    signaling.register_peer(peer_id.clone(), server_id.clone(), Some(signing_pubkey.clone()), conn_id.clone());
                } else {
                    if !signaling.validate_peer_connection(&peer_id, conn_id) {
                        return Err(format!("Invalid peer_id {} for connection {}", peer_id, conn_id));
                    }
                }

                signaling.peer_senders.insert(peer_id.clone(), sender.clone());
            };

            {
                let mut voice = state.voice.write().await;
                voice.server_signing_pubkeys.insert(server_id.clone(), signing_pubkey.clone());
            }

            let peers = {
                let mut voice = state.voice.write().await;
                voice.register_voice_peer(
                    peer_id.clone(),
                    user_id.clone(),
                    server_id.clone(),
                    chat_id.clone(),
                    conn_id.clone(),
                )
            };

            let response = SignalingMessage::VoiceRegistered {
                peer_id: peer_id.clone(),
                chat_id: chat_id.clone(),
                peers: peers.clone(),
            };
            let json = serde_json::to_string(&response)
                .map_err(|e| format!("Failed to serialize VoiceRegistered: {}", e))?;
            sender
                .send(tokio_tungstenite::tungstenite::Message::Text(json))
                .map_err(|e| format!("Failed to send VoiceRegistered: {}", e))?;

            let join_msg = SignalingMessage::VoicePeerJoined {
                peer_id: peer_id.clone(),
                user_id: user_id.clone(),
                chat_id: chat_id.clone(),
            };
            state.broadcast_to_voice_room(&server_id, &chat_id, &join_msg, Some(&peer_id)).await;

            state.broadcast_voice_presence(&signing_pubkey, &user_id, &chat_id, true).await;

            Ok(())
        }

        SignalingMessage::VoiceUnregister { peer_id, chat_id } => {
            info!("Voice unregister: peer={} chat={}", peer_id, chat_id);

            {
                let signaling = state.signaling.read().await;
                if !signaling.validate_peer_connection(&peer_id, conn_id) {
                    return Err(format!("Invalid peer_id {} for connection {}", peer_id, conn_id));
                }
            }

            let removed = {
                let voice = state.voice.read().await;
                let mut found_server: Option<ServerId> = None;
                for ((s, c), peers) in voice.voice_chats.iter() {
                    if c == &chat_id && peers.iter().any(|p| p.peer_id == peer_id) {
                        found_server = Some(s.clone());
                        break;
                    }
                }

                if let Some(server_id) = found_server.clone() {
                    let signing_pubkey = voice.server_signing_pubkeys.get(&server_id).cloned();
                    drop(voice);
                    let mut voice = state.voice.write().await;
                    if let Some(user_id) = voice.unregister_voice_peer(&peer_id, &server_id, &chat_id) {
                        Some((server_id, user_id, signing_pubkey))
                    } else {
                        None
                    }
                } else {
                    None
                }
            };

            if let Some((server_id, user_id, signing_pubkey_opt)) = removed {
                let leave_msg = SignalingMessage::VoicePeerLeft {
                    peer_id,
                    user_id: user_id.clone(),
                    chat_id: chat_id.clone(),
                };
                state.broadcast_to_voice_room(&server_id, &chat_id, &leave_msg, None).await;
                if let Some(signing_pubkey) = signing_pubkey_opt {
                    state.broadcast_voice_presence(&signing_pubkey, &user_id, &chat_id, false).await;
                }
            }

            Ok(())
        }

        SignalingMessage::VoiceOffer { from_peer, from_user, to_peer, chat_id, sdp } => {
            info!("Voice offer from {} to {} in chat {}", from_peer, to_peer, chat_id);

            {
                let signaling = state.signaling.read().await;
                if !signaling.validate_peer_connection(&from_peer, conn_id) {
                    return Err(format!("Invalid peer_id {} for connection {}", from_peer, conn_id));
                }
            }

            let target_sender = {
                let voice = state.voice.read().await;
                let mut found_server: Option<ServerId> = None;
                for ((server_id, c), _) in voice.voice_chats.iter() {
                    if c == &chat_id {
                        found_server = Some(server_id.clone());
                        break;
                    }
                }
                drop(voice);
                if let Some(server_id) = found_server {
                    state.get_voice_peer_sender(&server_id, &chat_id, &to_peer).await
                } else {
                    None
                }
            };

            if let Some(target) = target_sender {
                let forward_msg = SignalingMessage::VoiceOffer {
                    from_peer,
                    from_user,
                    to_peer,
                    chat_id,
                    sdp,
                };
                let json = serde_json::to_string(&forward_msg)
                    .map_err(|e| format!("Failed to serialize VoiceOffer: {}", e))?;
                target
                    .send(tokio_tungstenite::tungstenite::Message::Text(json))
                    .map_err(|e| format!("Failed to forward VoiceOffer: {}", e))?;
            } else {
                warn!("Target peer {} not found in chat {} for VoiceOffer", to_peer, chat_id);
            }

            Ok(())
        }

        SignalingMessage::VoiceAnswer { from_peer, from_user, to_peer, chat_id, sdp } => {
            info!("Voice answer from {} to {} in chat {}", from_peer, to_peer, chat_id);

            {
                let signaling = state.signaling.read().await;
                if !signaling.validate_peer_connection(&from_peer, conn_id) {
                    return Err(format!("Invalid peer_id {} for connection {}", from_peer, conn_id));
                }
            }

            let target_sender = {
                let voice = state.voice.read().await;
                let mut found_server: Option<ServerId> = None;
                for ((server_id, c), _) in voice.voice_chats.iter() {
                    if c == &chat_id {
                        found_server = Some(server_id.clone());
                        break;
                    }
                }
                drop(voice);
                if let Some(server_id) = found_server {
                    state.get_voice_peer_sender(&server_id, &chat_id, &to_peer).await
                } else {
                    None
                }
            };

            if let Some(target) = target_sender {
                let forward_msg = SignalingMessage::VoiceAnswer {
                    from_peer,
                    from_user,
                    to_peer,
                    chat_id,
                    sdp,
                };
                let json = serde_json::to_string(&forward_msg)
                    .map_err(|e| format!("Failed to serialize VoiceAnswer: {}", e))?;
                target
                    .send(tokio_tungstenite::tungstenite::Message::Text(json))
                    .map_err(|e| format!("Failed to forward VoiceAnswer: {}", e))?;
            } else {
                warn!("Target peer {} not found in chat {} for VoiceAnswer", to_peer, chat_id);
            }

            Ok(())
        }

        SignalingMessage::VoiceIceCandidate { from_peer, to_peer, chat_id, candidate } => {
            {
                let signaling = state.signaling.read().await;
                if !signaling.validate_peer_connection(&from_peer, conn_id) {
                    return Err(format!("Invalid peer_id {} for connection {}", from_peer, conn_id));
                }
            }

            let target_sender = {
                let voice = state.voice.read().await;
                let mut found_server: Option<ServerId> = None;
                for ((server_id, c), _) in voice.voice_chats.iter() {
                    if c == &chat_id {
                        found_server = Some(server_id.clone());
                        break;
                    }
                }
                drop(voice);
                if let Some(server_id) = found_server {
                    state.get_voice_peer_sender(&server_id, &chat_id, &to_peer).await
                } else {
                    None
                }
            };

            if let Some(target) = target_sender {
                let forward_msg = SignalingMessage::VoiceIceCandidate {
                    from_peer,
                    to_peer,
                    chat_id,
                    candidate,
                };
                let json = serde_json::to_string(&forward_msg)
                    .map_err(|e| format!("Failed to serialize VoiceIceCandidate: {}", e))?;
                target
                    .send(tokio_tungstenite::tungstenite::Message::Text(json))
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
            sender.send(tokio_tungstenite::tungstenite::Message::Text(json))
                .map_err(|e| format!("Failed to send Pong: {}", e))?;
            Ok(())
        }

        SignalingMessage::Pong => {
            // Server shouldn't receive Pong, ignore
            Ok(())
        }

        SignalingMessage::ProfilePush { to_user_ids, display_name, real_name, show_real_name, rev, avatar_data_url, avatar_rev, account_created_at } => {
            const MAX_PROFILE_PUSH_RECIPIENTS: usize = 500;
            let from_user_id = match state.friends.read().await.get_user_id_for_conn(conn_id) {
                Some(uid) => uid,
                None => return Err("ProfilePush requires PresenceHello first".to_string()),
            };
            let incoming = SignalingMessage::ProfilePushIncoming {
                from_user_id: from_user_id.clone(),
                display_name: display_name.clone(),
                real_name: real_name.clone(),
                show_real_name,
                rev,
                avatar_data_url: avatar_data_url.clone(),
                avatar_rev,
                account_created_at: account_created_at.clone(),
            };
            let json = serde_json::to_string(&incoming)
                .map_err(|e| format!("Failed to serialize ProfilePushIncoming: {}", e))?;
            let friends = state.friends.read().await;
            for to_id in to_user_ids.into_iter().take(MAX_PROFILE_PUSH_RECIPIENTS) {
                if to_id.is_empty() || to_id == from_user_id {
                    continue;
                }
                friends.send_to_user(&to_id, &json);
            }
            Ok(())
        }

        _ => Err("Invalid message type".to_string()),
    }
}
