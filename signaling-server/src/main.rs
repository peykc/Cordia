// Allow unused code during WebRTC scaffolding phase
#![allow(dead_code, unused_variables)]

use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::Arc;

use futures_util::{SinkExt, StreamExt};
use hyper::service::{make_service_fn, service_fn};
use hyper::{Body, Request, Response, Server, StatusCode};
use log::{error, info, warn};
use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;

type PeerId = String;
type HouseId = String;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
enum SignalingMessage {
    /// Client registers with house_id and peer_id
    Register {
        house_id: HouseId,
        peer_id: PeerId,
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
}

/// Connection info for each peer
#[derive(Debug, Clone)]
struct PeerConnection {
    peer_id: PeerId,
    house_id: HouseId,
}

/// Shared state across all connections
struct ServerState {
    /// Map of peer_id -> PeerConnection
    peers: HashMap<PeerId, PeerConnection>,
    /// Map of house_id -> list of peer_ids in that house
    houses: HashMap<HouseId, Vec<PeerId>>,
}

impl ServerState {
    fn new() -> Self {
        Self {
            peers: HashMap::new(),
            houses: HashMap::new(),
        }
    }

    fn register_peer(&mut self, peer_id: PeerId, house_id: HouseId) -> Vec<PeerId> {
        // Add peer connection
        self.peers.insert(
            peer_id.clone(),
            PeerConnection {
                peer_id: peer_id.clone(),
                house_id: house_id.clone(),
            },
        );

        // Add peer to house
        let peers_in_house = self.houses.entry(house_id.clone()).or_insert_with(Vec::new);
        if !peers_in_house.contains(&peer_id) {
            peers_in_house.push(peer_id.clone());
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
        }
    }

    fn get_house(&self, peer_id: &PeerId) -> Option<HouseId> {
        self.peers.get(peer_id).map(|c| c.house_id.clone())
    }
}

type SharedState = Arc<Mutex<ServerState>>;

async fn handle_connection(
    ws: hyper_tungstenite::WebSocketStream<hyper::upgrade::Upgraded>,
    addr: SocketAddr,
    state: SharedState,
) {
    info!("WebSocket connection established from {}", addr);

    let (mut ws_sender, mut ws_receiver) = ws.split();
    let mut current_peer_id: Option<PeerId> = None;

    while let Some(msg_result) = ws_receiver.next().await {
        match msg_result {
            Ok(hyper_tungstenite::tungstenite::Message::Text(text)) => {
                match serde_json::from_str::<SignalingMessage>(&text) {
                    Ok(msg) => {
                        match handle_message(msg, &mut current_peer_id, &state, &mut ws_sender).await {
                            Ok(_) => {}
                            Err(e) => {
                                warn!("Error handling message: {}", e);
                                let error_msg = SignalingMessage::Error {
                                    message: e.to_string(),
                                };
                                if let Ok(json) = serde_json::to_string(&error_msg) {
                                    let _ = ws_sender.send(hyper_tungstenite::tungstenite::Message::Text(json)).await;
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
                            let _ = ws_sender.send(hyper_tungstenite::tungstenite::Message::Text(json)).await;
                        }
                    }
                }
            }
            Ok(hyper_tungstenite::tungstenite::Message::Close(_)) => {
                info!("Client {} closed connection", addr);
                break;
            }
            Ok(hyper_tungstenite::tungstenite::Message::Ping(data)) => {
                let _ = ws_sender.send(hyper_tungstenite::tungstenite::Message::Pong(data)).await;
            }
            Ok(_) => {}
            Err(e) => {
                error!("WebSocket error from {}: {}", addr, e);
                break;
            }
        }
    }

    // Clean up when connection closes
    if let Some(peer_id) = current_peer_id {
        let mut state = state.lock().await;
        state.unregister_peer(&peer_id);
        info!("Unregistered peer {}", peer_id);
    }
}

async fn handle_message(
    msg: SignalingMessage,
    current_peer_id: &mut Option<PeerId>,
    state: &SharedState,
    ws_sender: &mut futures_util::stream::SplitSink<
        hyper_tungstenite::WebSocketStream<hyper::upgrade::Upgraded>,
        hyper_tungstenite::tungstenite::Message,
    >,
) -> Result<(), String> {
    match msg {
        SignalingMessage::Register { house_id, peer_id } => {
            let mut state = state.lock().await;
            let peers = state.register_peer(peer_id.clone(), house_id.clone());
            *current_peer_id = Some(peer_id.clone());

            info!("Registered peer {} in house {}", peer_id, house_id);

            let response = SignalingMessage::Registered {
                peer_id: peer_id.clone(),
                peers,
            };

            let json = serde_json::to_string(&response)
                .map_err(|e| format!("Failed to serialize response: {}", e))?;

            ws_sender
                .send(hyper_tungstenite::tungstenite::Message::Text(json))
                .await
                .map_err(|e| format!("Failed to send response: {}", e))?;

            Ok(())
        }
        SignalingMessage::Offer { from_peer, to_peer, sdp } => {
            // Note: For v0, we're not forwarding messages between peers
            // Each client will need to establish direct P2P connections
            // This is a placeholder for future implementation
            info!("Received offer from {} to {}", from_peer, to_peer);
            Ok(())
        }
        SignalingMessage::Answer { from_peer, to_peer, sdp } => {
            info!("Received answer from {} to {}", from_peer, to_peer);
            Ok(())
        }
        SignalingMessage::IceCandidate { from_peer, to_peer, candidate } => {
            info!("Received ICE candidate from {} to {}", from_peer, to_peer);
            Ok(())
        }
        _ => Err("Invalid message type".to_string()),
    }
}

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
    info!("Health check: http://{}/health", addr);

    if let Err(e) = server.await {
        error!("Server error: {}", e);
    }
}

async fn handle_request(
    mut req: Request<Body>,
    state: SharedState,
) -> Result<Response<Body>, hyper::Error> {
    // Health check endpoint
    if req.uri().path() == "/health" {
        return Ok(Response::builder()
            .status(StatusCode::OK)
            .body(Body::from("ok"))
            .unwrap());
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
        .body(Body::from("Not found. Use /health for health check or upgrade to WebSocket."))
        .unwrap())
}
