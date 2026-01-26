#[cfg(feature = "postgres")]
use chrono::{DateTime, Duration, Utc};
#[cfg(feature = "postgres")]
use sqlx::{PgPool, Row};
#[cfg(feature = "postgres")]
use crate::{ProfileRecord, ProfileSnapshotRecord, EncryptedHouseHint, InviteTokenCreateRequest, InviteTokenRecord, HouseEvent};

#[cfg(feature = "postgres")]
pub async fn init_db(pool: &PgPool) -> Result<(), String> {
    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS profiles (
          user_id TEXT PRIMARY KEY,
          display_name TEXT NOT NULL,
          real_name TEXT,
          show_real_name BOOLEAN NOT NULL,
          rev BIGINT NOT NULL,
          updated_at TIMESTAMPTZ NOT NULL
        );
        "#,
    )
    .execute(pool)
    .await
    .map_err(|e| format!("init_db profiles: {}", e))?;

    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS house_hints (
          signing_pubkey TEXT PRIMARY KEY,
          encrypted_state TEXT NOT NULL,
          signature TEXT NOT NULL,
          last_updated TIMESTAMPTZ NOT NULL
        );
        "#,
    )
    .execute(pool)
    .await
    .map_err(|e| format!("init_db house_hints: {}", e))?;

    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS invite_tokens (
          code TEXT PRIMARY KEY,
          signing_pubkey TEXT NOT NULL,
          encrypted_payload TEXT NOT NULL,
          signature TEXT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL,
          expires_at TIMESTAMPTZ NOT NULL,
          max_uses INTEGER NOT NULL,
          remaining_uses INTEGER NOT NULL
        );
        "#,
    )
    .execute(pool)
    .await
    .map_err(|e| format!("init_db invite_tokens: {}", e))?;

    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS house_events (
          event_id TEXT PRIMARY KEY,
          signing_pubkey TEXT NOT NULL,
          event_type TEXT NOT NULL,
          encrypted_payload TEXT NOT NULL,
          signature TEXT NOT NULL,
          timestamp TIMESTAMPTZ NOT NULL
        );
        "#,
    )
    .execute(pool)
    .await
    .map_err(|e| format!("init_db house_events: {}", e))?;

    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS member_acks (
          signing_pubkey TEXT NOT NULL,
          user_id TEXT NOT NULL,
          last_event_id TEXT NOT NULL,
          updated_at TIMESTAMPTZ NOT NULL,
          PRIMARY KEY (signing_pubkey, user_id)
        );
        "#,
    )
    .execute(pool)
    .await
    .map_err(|e| format!("init_db member_acks: {}", e))?;
    Ok(())
}

#[cfg(feature = "postgres")]
pub async fn upsert_profile_db(pool: &PgPool, user_id: &str, rec: &ProfileRecord) -> Result<(), String> {
    sqlx::query(
        r#"
        INSERT INTO profiles (user_id, display_name, real_name, show_real_name, rev, updated_at)
        VALUES ($1, $2, $3, $4, $5, NOW())
        ON CONFLICT (user_id) DO UPDATE
        SET display_name = EXCLUDED.display_name,
            real_name = EXCLUDED.real_name,
            show_real_name = EXCLUDED.show_real_name,
            rev = EXCLUDED.rev,
            updated_at = NOW()
        WHERE profiles.rev < EXCLUDED.rev;
        "#,
    )
    .bind(user_id)
    .bind(&rec.display_name)
    .bind(&rec.real_name)
    .bind(rec.show_real_name)
    .bind(rec.rev)
    .execute(pool)
    .await
    .map_err(|e| format!("upsert_profile_db: {}", e))?;
    Ok(())
}

#[cfg(feature = "postgres")]
pub async fn load_profiles_db(pool: &PgPool, user_ids: &[String]) -> Result<Vec<ProfileSnapshotRecord>, String> {
    // NOTE: We intentionally don't expose updated_at; rev is the authoritative ordering.
    let rows = sqlx::query(
        r#"
        SELECT user_id, display_name, real_name, show_real_name, rev
        FROM profiles
        WHERE user_id = ANY($1)
        "#,
    )
    .bind(user_ids)
    .fetch_all(pool)
    .await
    .map_err(|e| format!("load_profiles_db: {}", e))?;

    let mut out = Vec::with_capacity(rows.len());
    for row in rows {
        out.push(ProfileSnapshotRecord {
            user_id: row.try_get("user_id").map_err(|e| format!("load_profiles_db user_id: {}", e))?,
            display_name: row
                .try_get("display_name")
                .map_err(|e| format!("load_profiles_db display_name: {}", e))?,
            real_name: row
                .try_get::<Option<String>, _>("real_name")
                .map_err(|e| format!("load_profiles_db real_name: {}", e))?,
            show_real_name: row
                .try_get("show_real_name")
                .map_err(|e| format!("load_profiles_db show_real_name: {}", e))?,
            rev: row.try_get("rev").map_err(|e| format!("load_profiles_db rev: {}", e))?,
        });
    }
    Ok(out)
}

#[cfg(feature = "postgres")]
pub async fn upsert_house_hint_db(pool: &PgPool, hint: &EncryptedHouseHint) -> Result<(), String> {
    sqlx::query(
        r#"
        INSERT INTO house_hints (signing_pubkey, encrypted_state, signature, last_updated)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (signing_pubkey) DO UPDATE
        SET encrypted_state = EXCLUDED.encrypted_state,
            signature = EXCLUDED.signature,
            last_updated = EXCLUDED.last_updated;
        "#,
    )
    .bind(&hint.signing_pubkey)
    .bind(&hint.encrypted_state)
    .bind(&hint.signature)
    .bind(hint.last_updated)
    .execute(pool)
    .await
    .map_err(|e| format!("upsert_house_hint_db: {}", e))?;
    Ok(())
}

#[cfg(feature = "postgres")]
pub async fn get_house_hint_db(pool: &PgPool, signing_pubkey: &str) -> Result<Option<EncryptedHouseHint>, String> {
    let row = sqlx::query(
        r#"
        SELECT signing_pubkey, encrypted_state, signature, last_updated
        FROM house_hints
        WHERE signing_pubkey = $1
        "#,
    )
    .bind(signing_pubkey)
    .fetch_optional(pool)
    .await
    .map_err(|e| format!("get_house_hint_db: {}", e))?;

    Ok(row.map(|r| EncryptedHouseHint {
        signing_pubkey: r.try_get("signing_pubkey").unwrap_or_default(),
        encrypted_state: r.try_get("encrypted_state").unwrap_or_default(),
        signature: r.try_get("signature").unwrap_or_default(),
        last_updated: r.try_get("last_updated").unwrap_or_else(|_| Utc::now()),
    }))
}

#[cfg(feature = "postgres")]
pub async fn gc_expired_invites_db(pool: &PgPool) -> Result<(), String> {
    sqlx::query("DELETE FROM invite_tokens WHERE expires_at <= NOW()")
        .execute(pool)
        .await
        .map_err(|e| format!("gc_expired_invites_db: {}", e))?;
    Ok(())
}

#[cfg(feature = "postgres")]
pub async fn upsert_invite_db(pool: &PgPool, signing_pubkey: &str, req: InviteTokenCreateRequest) -> Result<InviteTokenRecord, String> {
    let code = req.code.trim().to_string();
    if code.len() < 10 || code.len() > 64 {
        return Err("Invalid invite code length".to_string());
    }
    let now = Utc::now();
    let expires_at = now + Duration::days(30);
    let max_uses = req.max_uses;
    let remaining_uses = req.max_uses;

    sqlx::query(
        r#"
        INSERT INTO invite_tokens (code, signing_pubkey, encrypted_payload, signature, created_at, expires_at, max_uses, remaining_uses)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        ON CONFLICT (code) DO UPDATE
        SET signing_pubkey = EXCLUDED.signing_pubkey,
            encrypted_payload = EXCLUDED.encrypted_payload,
            signature = EXCLUDED.signature,
            created_at = EXCLUDED.created_at,
            expires_at = EXCLUDED.expires_at,
            max_uses = EXCLUDED.max_uses,
            remaining_uses = EXCLUDED.remaining_uses;
        "#,
    )
    .bind(&code)
    .bind(signing_pubkey)
    .bind(&req.encrypted_payload)
    .bind(&req.signature)
    .bind(now)
    .bind(expires_at)
    .bind(max_uses as i32)
    .bind(remaining_uses as i32)
    .execute(pool)
    .await
    .map_err(|e| format!("upsert_invite_db: {}", e))?;

    Ok(InviteTokenRecord {
        code,
        signing_pubkey: signing_pubkey.to_string(),
        encrypted_payload: req.encrypted_payload,
        signature: req.signature,
        created_at: now,
        expires_at,
        max_uses,
        remaining_uses,
    })
}

#[cfg(feature = "postgres")]
pub async fn get_invite_db(pool: &PgPool, code: &str) -> Result<Option<InviteTokenRecord>, String> {
    let row = sqlx::query(
        r#"
        SELECT code, signing_pubkey, encrypted_payload, signature, created_at, expires_at, max_uses, remaining_uses
        FROM invite_tokens
        WHERE code = $1 AND expires_at > NOW()
        "#,
    )
    .bind(code)
    .fetch_optional(pool)
    .await
    .map_err(|e| format!("get_invite_db: {}", e))?;

    Ok(row.map(|r| InviteTokenRecord {
        code: r.try_get("code").unwrap_or_default(),
        signing_pubkey: r.try_get("signing_pubkey").unwrap_or_default(),
        encrypted_payload: r.try_get("encrypted_payload").unwrap_or_default(),
        signature: r.try_get("signature").unwrap_or_default(),
        created_at: r.try_get("created_at").unwrap_or_else(|_| Utc::now()),
        expires_at: r.try_get("expires_at").unwrap_or_else(|_| Utc::now()),
        max_uses: r.try_get::<i32, _>("max_uses").unwrap_or(0) as u32,
        remaining_uses: r.try_get::<i32, _>("remaining_uses").unwrap_or(0) as u32,
    }))
}

#[cfg(feature = "postgres")]
pub async fn redeem_invite_db(pool: &PgPool, code: &str) -> Result<Option<InviteTokenRecord>, String> {
    let row = sqlx::query(
        r#"
        UPDATE invite_tokens
        SET remaining_uses = CASE WHEN max_uses = 0 THEN remaining_uses ELSE remaining_uses - 1 END
        WHERE code = $1
          AND expires_at > NOW()
          AND (max_uses = 0 OR remaining_uses > 0)
        RETURNING code, signing_pubkey, encrypted_payload, signature, created_at, expires_at, max_uses, remaining_uses
        "#,
    )
    .bind(code)
    .fetch_optional(pool)
    .await
    .map_err(|e| format!("redeem_invite_db: {}", e))?;

    Ok(row.map(|r| InviteTokenRecord {
        code: r.try_get("code").unwrap_or_default(),
        signing_pubkey: r.try_get("signing_pubkey").unwrap_or_default(),
        encrypted_payload: r.try_get("encrypted_payload").unwrap_or_default(),
        signature: r.try_get("signature").unwrap_or_default(),
        created_at: r.try_get("created_at").unwrap_or_else(|_| Utc::now()),
        expires_at: r.try_get("expires_at").unwrap_or_else(|_| Utc::now()),
        max_uses: r.try_get::<i32, _>("max_uses").unwrap_or(0) as u32,
        remaining_uses: r.try_get::<i32, _>("remaining_uses").unwrap_or(0) as u32,
    }))
}

#[cfg(feature = "postgres")]
pub async fn revoke_invite_db(pool: &PgPool, code: &str) -> Result<bool, String> {
    let res = sqlx::query("DELETE FROM invite_tokens WHERE code = $1")
        .bind(code)
        .execute(pool)
        .await
        .map_err(|e| format!("revoke_invite_db: {}", e))?;
    Ok(res.rows_affected() > 0)
}

#[cfg(feature = "postgres")]
pub async fn insert_event_db(pool: &PgPool, event: &HouseEvent) -> Result<(), String> {
    sqlx::query(
        r#"
        INSERT INTO house_events (event_id, signing_pubkey, event_type, encrypted_payload, signature, timestamp)
        VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT (event_id) DO NOTHING;
        "#,
    )
    .bind(&event.event_id)
    .bind(&event.signing_pubkey)
    .bind(&event.event_type)
    .bind(&event.encrypted_payload)
    .bind(&event.signature)
    .bind(event.timestamp)
    .execute(pool)
    .await
    .map_err(|e| format!("insert_event_db: {}", e))?;
    Ok(())
}

#[cfg(feature = "postgres")]
async fn get_event_timestamp_db(pool: &PgPool, signing_pubkey: &str, event_id: &str) -> Result<Option<DateTime<Utc>>, String> {
    let row = sqlx::query(
        r#"
        SELECT timestamp
        FROM house_events
        WHERE signing_pubkey = $1 AND event_id = $2
        "#,
    )
    .bind(signing_pubkey)
    .bind(event_id)
    .fetch_optional(pool)
    .await
    .map_err(|e| format!("get_event_timestamp_db: {}", e))?;

    Ok(row.and_then(|r| r.try_get("timestamp").ok()))
}

#[cfg(feature = "postgres")]
pub async fn get_events_db(pool: &PgPool, signing_pubkey: &str, since: Option<&str>) -> Result<Vec<HouseEvent>, String> {
    let rows = if let Some(since_id) = since {
        let Some(since_ts) = get_event_timestamp_db(pool, signing_pubkey, since_id).await? else {
            return Ok(Vec::new());
        };
        sqlx::query(
            r#"
            SELECT event_id, signing_pubkey, event_type, encrypted_payload, signature, timestamp
            FROM house_events
            WHERE signing_pubkey = $1
              AND (timestamp > $2 OR (timestamp = $2 AND event_id > $3))
            ORDER BY timestamp ASC, event_id ASC
            "#,
        )
        .bind(signing_pubkey)
        .bind(since_ts)
        .bind(since_id)
        .fetch_all(pool)
        .await
        .map_err(|e| format!("get_events_db since: {}", e))?
    } else {
        sqlx::query(
            r#"
            SELECT event_id, signing_pubkey, event_type, encrypted_payload, signature, timestamp
            FROM house_events
            WHERE signing_pubkey = $1
            ORDER BY timestamp ASC, event_id ASC
            "#,
        )
        .bind(signing_pubkey)
        .fetch_all(pool)
        .await
        .map_err(|e| format!("get_events_db: {}", e))?
    };

    let mut out = Vec::with_capacity(rows.len());
    for row in rows {
        out.push(HouseEvent {
            event_id: row.try_get("event_id").unwrap_or_default(),
            signing_pubkey: row.try_get("signing_pubkey").unwrap_or_default(),
            event_type: row.try_get("event_type").unwrap_or_default(),
            encrypted_payload: row.try_get("encrypted_payload").unwrap_or_default(),
            signature: row.try_get("signature").unwrap_or_default(),
            timestamp: row.try_get("timestamp").unwrap_or_else(|_| Utc::now()),
        });
    }
    Ok(out)
}

#[cfg(feature = "postgres")]
pub async fn ack_events_db(pool: &PgPool, signing_pubkey: &str, user_id: &str, last_event_id: &str) -> Result<(), String> {
    sqlx::query(
        r#"
        INSERT INTO member_acks (signing_pubkey, user_id, last_event_id, updated_at)
        VALUES ($1, $2, $3, NOW())
        ON CONFLICT (signing_pubkey, user_id) DO UPDATE
        SET last_event_id = EXCLUDED.last_event_id,
            updated_at = NOW();
        "#,
    )
    .bind(signing_pubkey)
    .bind(user_id)
    .bind(last_event_id)
    .execute(pool)
    .await
    .map_err(|e| format!("ack_events_db: {}", e))?;
    Ok(())
}

#[cfg(feature = "postgres")]
pub async fn gc_old_events_db(pool: &PgPool, cutoff: DateTime<Utc>) -> Result<(), String> {
    sqlx::query("DELETE FROM house_events WHERE timestamp <= $1")
        .bind(cutoff)
        .execute(pool)
        .await
        .map_err(|e| format!("gc_old_events_db: {}", e))?;
    Ok(())
}
