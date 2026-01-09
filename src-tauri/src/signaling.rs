use std::time::Duration;
use serde::{Deserialize, Serialize};
use thiserror::Error;

#[derive(Error, Debug)]
pub enum SignalingError {
    #[error("Connection failed: {0}")]
    ConnectionFailed(String),
    #[error("Timeout")]
    Timeout,
    #[error("Invalid URL: {0}")]
    InvalidUrl(String),
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub enum SignalingStatus {
    Connected,
    Disconnected,
    Checking,
}

/// Check if signaling server is available at the given URL
pub async fn check_signaling_health(url: &str) -> Result<bool, SignalingError> {
    // For now, we'll do a simple TCP connection check
    // In the future, we can upgrade this to a WebSocket handshake

    let timeout = Duration::from_secs(3);

    // Parse the URL to extract host and port
    let url_str = if url.starts_with("ws://") || url.starts_with("wss://") {
        url
    } else {
        return Err(SignalingError::InvalidUrl(
            "URL must start with ws:// or wss://".to_string()
        ));
    };

    // Extract host:port from ws://host:port
    let url_without_scheme = url_str
        .trim_start_matches("ws://")
        .trim_start_matches("wss://");

    let host_port = url_without_scheme
        .split('/')
        .next()
        .ok_or_else(|| SignalingError::InvalidUrl("Invalid URL format".to_string()))?;

    // Try to establish TCP connection with timeout
    match tokio::time::timeout(
        timeout,
        tokio::net::TcpStream::connect(host_port)
    ).await {
        Ok(Ok(_stream)) => {
            // Successfully connected
            Ok(true)
        }
        Ok(Err(e)) => {
            // Connection failed
            Err(SignalingError::ConnectionFailed(e.to_string()))
        }
        Err(_) => {
            // Timeout
            Err(SignalingError::Timeout)
        }
    }
}

/// Get the default signaling server URL
pub fn get_default_signaling_url() -> String {
    "ws://127.0.0.1:9001".to_string()
}
