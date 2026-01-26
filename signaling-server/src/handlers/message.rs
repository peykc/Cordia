use std::sync::Arc;
use log::{info, warn};
use crate::{
    SignalingMessage, ConnId, HouseId, SigningPubkey, WebSocketSender,
    ProfileRecord, ProfileSnapshotRecord,
    state::AppState,
    state::presence::PresenceUserStatus,
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
        SignalingMessage::Register { house_id, peer_id, signing_pubkey } => {
            let mut signaling = state.signaling.lock().await;
            let peers = signaling.register_peer(peer_id.clone(), house_id.clone(), signing_pubkey, conn_id.clone());

            // Store the sender for this peer
            signaling.peer_senders.insert(peer_id.clone(), sender.clone());
            drop(signaling);

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
                let mut presence = state.presence.lock().await;
                // Upsert presence
                let affected_spks = presence.upsert_presence_hello(conn_id, user_id.clone(), signing_pubkeys.clone(), active_signing_pubkey.clone());
                drop(presence);
                
                // LOCK BOUNDARY: Extract data here, unlock before IO
                #[cfg(feature = "redis-backend")]
                let redis_client = {
                    let backends = state.backends.lock().await;
                    backends.redis.clone()
                };
                #[cfg(not(feature = "redis-backend"))]
                let redis_client: Option<()> = None;
                #[cfg(feature = "redis-backend")]
                let redis_ttl = {
                    let backends = state.backends.lock().await;
                    backends.redis_presence_ttl_secs
                };
                #[cfg(not(feature = "redis-backend"))]
                let redis_ttl: u64 = 0;

                let local_snaps: Vec<(SigningPubkey, Vec<PresenceUserStatus>)> = if redis_client.is_none() {
                    let presence = state.presence.lock().await;
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
            for spk in affected_spks {
                state.broadcast_presence_update(&spk, &user_id, true, active_signing_pubkey.clone()).await;
            }

            Ok(())
        }
        SignalingMessage::PresenceActive { user_id, active_signing_pubkey } => {
            let (spks, redis_client, redis_ttl) = {
                let mut presence = state.presence.lock().await;
                let spks = presence.update_presence_active(&user_id, active_signing_pubkey.clone());
                drop(presence);
                
                #[cfg(feature = "redis-backend")]
                let redis_client = {
                    let backends = state.backends.lock().await;
                    backends.redis.clone()
                };
                #[cfg(not(feature = "redis-backend"))]
                let redis_client: Option<()> = None;
                #[cfg(feature = "redis-backend")]
                let redis_ttl = {
                    let backends = state.backends.lock().await;
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
            Ok(())
        }
        SignalingMessage::ProfileAnnounce { user_id, display_name, real_name, show_real_name, rev, signing_pubkeys } => {
            let (rec_opt, db_opt) = {
                let mut profiles = state.profiles.lock().await;
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
                
                // Broadcast profile updates
                if let Some(ref r) = rec {
                    for spk in signing_pubkeys.iter() {
                        state.broadcast_profile_update(spk, &user_id, r).await;
                    }
                }

                // LOCK BOUNDARY: Extract data here, unlock before IO
                #[cfg(feature = "postgres")]
                let db = {
                    let backends = state.backends.lock().await;
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
                let backends = state.backends.lock().await;
                backends.db.clone()
            };

            #[cfg(feature = "postgres")]
            let out: Vec<ProfileSnapshotRecord> = if let Some(pool) = db {
                load_profiles_db(&pool, &user_ids).await.unwrap_or_default()
            } else {
                let profiles = state.profiles.lock().await;
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
                let profiles = state.profiles.lock().await;
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
                let _ = sender.send(hyper_tungstenite::tungstenite::Message::Text(json));
            }
            Ok(())
        }
        SignalingMessage::Offer { from_peer, to_peer, sdp } => {
            info!("Forwarding offer from {} to {}", from_peer, to_peer);

            // Validate from_peer belongs to this connection
            {
                let signaling = state.signaling.lock().await;
                if !signaling.validate_peer_connection(&from_peer, conn_id) {
                    return Err(format!("Invalid peer_id {} for connection {}", from_peer, conn_id));
                }
            }

            let signaling = state.signaling.lock().await;
            if let Some(target_sender) = signaling.peer_senders.get(&to_peer) {
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

            // Validate from_peer belongs to this connection
            {
                let signaling = state.signaling.lock().await;
                if !signaling.validate_peer_connection(&from_peer, conn_id) {
                    return Err(format!("Invalid peer_id {} for connection {}", from_peer, conn_id));
                }
            }

            let signaling = state.signaling.lock().await;
            if let Some(target_sender) = signaling.peer_senders.get(&to_peer) {
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

            // Validate from_peer belongs to this connection
            {
                let signaling = state.signaling.lock().await;
                if !signaling.validate_peer_connection(&from_peer, conn_id) {
                    return Err(format!("Invalid peer_id {} for connection {}", from_peer, conn_id));
                }
            }

            let signaling = state.signaling.lock().await;
            if let Some(target_sender) = signaling.peer_senders.get(&to_peer) {
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

        SignalingMessage::VoiceRegister { house_id, room_id, peer_id, user_id, signing_pubkey } => {
            info!("Voice register: peer={} user={} house={} room={}", peer_id, user_id, house_id, room_id);

            let peers = {
                let mut signaling = state.signaling.lock().await;

                // Register peer if not already registered (allows voice-first registration)
                // If peer exists, validate it belongs to this connection
                if !signaling.peers.contains_key(&peer_id) {
                    signaling.register_peer(peer_id.clone(), house_id.clone(), Some(signing_pubkey.clone()), conn_id.clone());
                } else {
                    // Validate peer_id belongs to this connection if already registered
                    if !signaling.validate_peer_connection(&peer_id, conn_id) {
                        return Err(format!("Invalid peer_id {} for connection {}", peer_id, conn_id));
                    }
                }

                // Store the sender for this peer (voice peers need this for Offer/Answer/ICE forwarding)
                signaling.peer_senders.insert(peer_id.clone(), sender.clone());
            };

            // Store house_id -> signing_pubkey mapping for voice presence broadcasting
            {
                let mut voice = state.voice.lock().await;
                voice.house_signing_pubkeys.insert(house_id.clone(), signing_pubkey.clone());
            }

            // Register the voice peer
            let peers = {
                let mut voice = state.voice.lock().await;
                voice.register_voice_peer(
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

            // Broadcast VoicePeerJoined to other peers in the room
            let join_msg = SignalingMessage::VoicePeerJoined {
                peer_id: peer_id.clone(),
                user_id: user_id.clone(),
                room_id: room_id.clone(),
            };
            state.broadcast_to_voice_room(&house_id, &room_id, &join_msg, Some(&peer_id)).await;

            // Broadcast voice presence update to all house members
            state.broadcast_voice_presence(&signing_pubkey, &user_id, &room_id, true).await;

            Ok(())
        }

        SignalingMessage::VoiceUnregister { peer_id, room_id } => {
            info!("Voice unregister: peer={} room={}", peer_id, room_id);

            // Validate peer_id belongs to this connection
            {
                let signaling = state.signaling.lock().await;
                if !signaling.validate_peer_connection(&peer_id, conn_id) {
                    return Err(format!("Invalid peer_id {} for connection {}", peer_id, conn_id));
                }
            }

            // Find the house_id and signing_pubkey for this peer BEFORE unregistering
            let removed = {
                let voice = state.voice.lock().await;

                // We need to find which house this room is in
                // Look through voice_rooms to find a match
                let mut found_house: Option<HouseId> = None;
                for ((h, r), peers) in voice.voice_rooms.iter() {
                    if r == &room_id && peers.iter().any(|p| p.peer_id == peer_id) {
                        found_house = Some(h.clone());
                        break;
                    }
                }

                // Get signing_pubkey BEFORE unregistering (while we still have the lock)
                if let Some(house_id) = found_house.clone() {
                    let signing_pubkey = voice.house_signing_pubkeys.get(&house_id).cloned();
                    drop(voice);
                    
                    // Now unregister the peer
                    let mut voice = state.voice.lock().await;
                    if let Some(user_id) = voice.unregister_voice_peer(&peer_id, &house_id, &room_id) {
                        Some((house_id, user_id, signing_pubkey))
                    } else {
                        None
                    }
                } else {
                    None
                }
            };

            // Broadcast VoicePeerLeft and voice presence update if peer was found
            if let Some((house_id, user_id, signing_pubkey_opt)) = removed {
                let leave_msg = SignalingMessage::VoicePeerLeft {
                    peer_id,
                    user_id: user_id.clone(),
                    room_id: room_id.clone(),
                };
                
                state.broadcast_to_voice_room(&house_id, &room_id, &leave_msg, None).await;
                
                // Broadcast voice presence update to all house members
                if let Some(signing_pubkey) = signing_pubkey_opt {
                    state.broadcast_voice_presence(&signing_pubkey, &user_id, &room_id, false).await;
                }
            }

            Ok(())
        }

        SignalingMessage::VoiceOffer { from_peer, from_user, to_peer, room_id, sdp } => {
            info!("Voice offer from {} to {} in room {}", from_peer, to_peer, room_id);

            // Validate from_peer belongs to this connection
            {
                let signaling = state.signaling.lock().await;
                if !signaling.validate_peer_connection(&from_peer, conn_id) {
                    return Err(format!("Invalid peer_id {} for connection {}", from_peer, conn_id));
                }
            }

            // Find the target peer's sender (they must be in the same room)
            // First find which house this room is in
            let target_sender = {
                let voice = state.voice.lock().await;
                let mut found_house: Option<HouseId> = None;
                for ((house_id, r), _) in voice.voice_rooms.iter() {
                    if r == &room_id {
                        found_house = Some(house_id.clone());
                        break;
                    }
                }
                drop(voice);
                
                if let Some(house_id) = found_house {
                    state.get_voice_peer_sender(&house_id, &room_id, &to_peer).await
                } else {
                    None
                }
            };

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

            // Validate from_peer belongs to this connection
            {
                let signaling = state.signaling.lock().await;
                if !signaling.validate_peer_connection(&from_peer, conn_id) {
                    return Err(format!("Invalid peer_id {} for connection {}", from_peer, conn_id));
                }
            }

            // Find the target peer's sender
            let target_sender = {
                let voice = state.voice.lock().await;
                let mut found_house: Option<HouseId> = None;
                for ((house_id, r), _) in voice.voice_rooms.iter() {
                    if r == &room_id {
                        found_house = Some(house_id.clone());
                        break;
                    }
                }
                drop(voice);
                
                if let Some(house_id) = found_house {
                    state.get_voice_peer_sender(&house_id, &room_id, &to_peer).await
                } else {
                    None
                }
            };

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
            // Validate from_peer belongs to this connection
            {
                let signaling = state.signaling.lock().await;
                if !signaling.validate_peer_connection(&from_peer, conn_id) {
                    return Err(format!("Invalid peer_id {} for connection {}", from_peer, conn_id));
                }
            }

            // Find the target peer's sender
            let target_sender = {
                let voice = state.voice.lock().await;
                let mut found_house: Option<HouseId> = None;
                for ((house_id, r), _) in voice.voice_rooms.iter() {
                    if r == &room_id {
                        found_house = Some(house_id.clone());
                        break;
                    }
                }
                drop(voice);
                
                if let Some(house_id) = found_house {
                    state.get_voice_peer_sender(&house_id, &room_id, &to_peer).await
                } else {
                    None
                }
            };

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
