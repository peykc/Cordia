use std::collections::HashMap;
use chrono::{Duration, Utc};
use crate::{SigningPubkey, EncryptedHouseHint, InviteTokenRecord, HouseEvent, InviteTokenCreateRequest};

const EVENT_RETENTION_DAYS: i64 = 30;

/// Event queue state (REST API)
/// Hints only - clients treat local state as authoritative
pub struct EventState {
    /// Hints only - clients treat local state as authoritative
    pub house_hints: HashMap<SigningPubkey, EncryptedHouseHint>,
    /// Temporary invite tokens (short code -> encrypted payload)
    pub invite_tokens: HashMap<String, InviteTokenRecord>,
    /// Event queue - time-limited, not consensus-based
    /// Best-effort sync - timestamp collisions possible
    pub event_queues: HashMap<SigningPubkey, Vec<HouseEvent>>,
    /// Best-effort acks - soft tracking, not hard requirement
    pub member_acks: HashMap<(SigningPubkey, String), String>, // (signing_pubkey, user_id) -> last_event_id
}

impl EventState {
    pub fn new() -> Self {
        Self {
            house_hints: HashMap::new(),
            invite_tokens: HashMap::new(),
            event_queues: HashMap::new(),
            member_acks: HashMap::new(),
        }
    }

    /// Register/update house hint (any member can call this at any time)
    pub fn register_house_hint(&mut self, signing_pubkey: String, hint: EncryptedHouseHint) {
        self.house_hints.insert(signing_pubkey, hint);
    }

    /// Get house hint
    pub fn get_house_hint(&self, signing_pubkey: &str) -> Option<&EncryptedHouseHint> {
        self.house_hints.get(signing_pubkey)
    }

    pub fn put_invite_token(&mut self, signing_pubkey: &str, req: InviteTokenCreateRequest) -> Result<InviteTokenRecord, String> {
        let code = req.code.trim().to_string();
        if code.len() < 10 || code.len() > 64 {
            return Err("Invalid invite code length".to_string());
        }
        let now = Utc::now();
        // Keep server-side cleanup; not user-facing.
        let expires_at = now + Duration::days(30);
        let max_uses = req.max_uses;
        let remaining_uses = req.max_uses; // 0 = unlimited
        let record = InviteTokenRecord {
            code: code.clone(),
            signing_pubkey: signing_pubkey.to_string(),
            encrypted_payload: req.encrypted_payload,
            signature: req.signature,
            created_at: now,
            expires_at,
            max_uses,
            remaining_uses,
        };
        self.invite_tokens.insert(code.clone(), record.clone());
        Ok(record)
    }

    pub fn get_invite_token(&self, code: &str) -> Option<&InviteTokenRecord> {
        self.invite_tokens.get(code)
    }

    pub fn redeem_invite_token(&mut self, code: &str) -> Option<InviteTokenRecord> {
        let Some(rec) = self.invite_tokens.get_mut(code) else {
            return None;
        };
        // unlimited
        if rec.max_uses == 0 {
            return Some(rec.clone());
        }
        if rec.remaining_uses == 0 {
            return None;
        }
        rec.remaining_uses = rec.remaining_uses.saturating_sub(1);
        Some(rec.clone())
    }

    pub fn gc_expired_invites(&mut self) {
        let now = Utc::now();
        self.invite_tokens.retain(|_, v| v.expires_at > now);
    }

    /// Post event to queue
    pub fn post_event(&mut self, signing_pubkey: String, mut event: HouseEvent) {
        event.timestamp = Utc::now();
        if event.event_id.is_empty() {
            event.event_id = uuid::Uuid::new_v4().to_string();
        }
        self.event_queues
            .entry(signing_pubkey)
            .or_insert_with(Vec::new)
            .push(event);
    }

    /// Get events since a given event ID
    pub fn get_events(&self, signing_pubkey: &str, since: Option<&str>) -> Vec<HouseEvent> {
        let events = match self.event_queues.get(signing_pubkey) {
            Some(events) => events.clone(),
            None => return Vec::new(),
        };

        if let Some(since_id) = since {
            events
                .into_iter()
                .skip_while(|e| e.event_id != since_id)
                .skip(1)
                .collect()
        } else {
            events
        }
    }

    /// Acknowledge events (best-effort)
    pub fn ack_events(&mut self, signing_pubkey: String, user_id: String, last_event_id: String) {
        self.member_acks.insert((signing_pubkey, user_id), last_event_id);
    }

    /// Garbage collect old events (called periodically)
    pub fn gc_old_events(&mut self) {
        let cutoff = Utc::now() - Duration::days(EVENT_RETENTION_DAYS);

        for events in self.event_queues.values_mut() {
            events.retain(|e| e.timestamp > cutoff);
        }

        // Also clean up empty queues
        self.event_queues.retain(|_, events| !events.is_empty());
    }
}
