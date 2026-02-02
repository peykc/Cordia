//! Security configuration and middleware for the beacon.
//!
//! All settings are env-driven and future-forward: CORS, headers, body limit,
//! connection limits, and (optional) rate limiting. Designed to work behind
//! Cloudflare Zero Trust (CF-Connecting-IP / X-Forwarded-For) and to be
//! extended later (e.g. auth, stricter limits) without replacing this layer.

use axum::{
    extract::Request,
    http::HeaderValue,
    middleware::Next,
    response::Response,
};
use std::collections::HashMap;
use std::env;
use std::sync::Arc;
use tokio::sync::RwLock;
use tower_http::cors::{AllowOrigin, CorsLayer};

/// Client IP as extracted from CF-Connecting-IP, X-Forwarded-For, or "unknown".
/// Injected into request extensions by client_ip_middleware for use in handlers.
#[derive(Clone, Debug)]
pub struct ClientIp(pub String);

/// Security-related configuration from environment.
/// All limits are optional (0 = disabled). Future: add auth, stricter CORS, etc.
#[derive(Clone, Debug)]
pub struct SecurityConfig {
    /// Comma-separated allowed CORS origins; unset or "*" = permissive.
    pub cors_origins: Option<String>,
    /// Max JSON/body size in bytes for REST; 0 = use default (1 MiB).
    pub max_body_bytes: usize,
    /// Max total WebSocket connections; 0 = unlimited.
    pub max_ws_connections: u32,
    /// Max WebSocket connections per client IP; 0 = unlimited.
    pub max_ws_per_ip: u32,
}

impl SecurityConfig {
    pub fn from_env() -> Self {
        let max_body_bytes = env::var("BEACON_MAX_BODY_BYTES")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(1_000_000); // 1 MiB default

        let max_ws_connections = env::var("BEACON_MAX_WS_CONNECTIONS")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(0);

        let max_ws_per_ip = env::var("BEACON_MAX_WS_PER_IP")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(0);

        let cors_origins = env::var("BEACON_CORS_ORIGINS").ok();

        Self {
            cors_origins,
            max_body_bytes,
            max_ws_connections,
            max_ws_per_ip,
        }
    }
}

/// Build CORS layer from config. Unset or "*" => permissive; otherwise comma-separated origins.
pub fn build_cors_layer(config: &SecurityConfig) -> CorsLayer {
    let origins = config
        .cors_origins
        .as_deref()
        .map(|s| s.trim())
        .filter(|s| !s.is_empty() && *s != "*");

    match origins {
        None => CorsLayer::permissive(),
        Some(list) => {
            let list: Vec<HeaderValue> = list
                .split(',')
                .map(|s| s.trim())
                .filter(|s| !s.is_empty())
                .filter_map(|s| HeaderValue::try_from(s.to_string()).ok())
                .collect();
            if list.is_empty() {
                CorsLayer::permissive()
            } else {
                CorsLayer::new().allow_origin(AllowOrigin::list(list))
            }
        }
    }
}

/// Middleware that extracts client IP from CF-Connecting-IP, X-Forwarded-For, or "unknown"
/// and inserts it into request extensions. Run this before handlers that need ClientIp.
pub async fn client_ip_middleware(request: Request, next: Next) -> Response {
    let ip = request
        .headers()
        .get("cf-connecting-ip")
        .or_else(|| request.headers().get("x-forwarded-for"))
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.split(',').next())
        .map(|s| s.trim().to_string())
        .unwrap_or_else(|| "unknown".to_string());

    let mut request = request;
    request.extensions_mut().insert(ClientIp(ip));
    next.run(request).await
}

/// Tracks WebSocket connection counts for global and per-IP limits.
pub struct ConnectionTracker {
    pub total: u32,
    pub per_ip: HashMap<String, u32>,
    pub max_total: u32,
    pub max_per_ip: u32,
}

impl ConnectionTracker {
    pub fn new(max_total: u32, max_per_ip: u32) -> Self {
        Self {
            total: 0,
            per_ip: HashMap::new(),
            max_total,
            max_per_ip,
        }
    }

    /// Returns true if a new connection from this IP would be under limits (no increment).
    pub fn can_accept(&self, ip: &str) -> bool {
        if self.max_total > 0 && self.total >= self.max_total {
            return false;
        }
        if self.max_per_ip > 0 {
            let per = self.per_ip.get(ip).copied().unwrap_or(0);
            if per >= self.max_per_ip {
                return false;
            }
        }
        true
    }

    /// Returns Ok(()) if under limits and connection was registered; Err(()) if over limit.
    pub fn try_register(&mut self, ip: &str) -> Result<(), ()> {
        if self.max_total > 0 && self.total >= self.max_total {
            return Err(());
        }
        let per = self.per_ip.entry(ip.to_string()).or_insert(0);
        if self.max_per_ip > 0 && *per >= self.max_per_ip {
            return Err(());
        }
        self.total += 1;
        *per += 1;
        Ok(())
    }

    pub fn unregister(&mut self, ip: &str) {
        if let Some(n) = self.per_ip.get_mut(ip) {
            *n = n.saturating_sub(1);
            if *n == 0 {
                self.per_ip.remove(ip);
            }
        }
        self.total = self.total.saturating_sub(1);
    }
}

/// Shared connection tracker for use in AppState and ws_handler.
pub type SharedConnectionTracker = Arc<RwLock<ConnectionTracker>>;
