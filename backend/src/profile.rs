//! Profile customisation: display name, bio and profile picture.
//!
//! Profile pictures are the only user-uploaded files the site hosts. They're capped at 1 MB,
//! must really be PNG/JPEG/GIF/WebP (checked by their bytes, not the declared type), and are
//! served with headers that stop browsers from treating them as anything but an image.

use axum::{
    body::Bytes,
    extract::{Path, State},
    http::{header, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use rusqlite::{params, OptionalExtension};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::{
    auth::{self, AuthUser, USER_COLS},
    error::{ApiError, ApiResult},
    util, Shared,
};

pub const MAX_AVATAR_BYTES: usize = 1024 * 1024;
/// How often someone can change their @username.
const USERNAME_COOLDOWN_SECS: i64 = 30 * 86_400;
const MAX_DISPLAY_NAME: usize = 32;
const MAX_BIO: usize = 300;

fn me_json(conn: &rusqlite::Connection, user_id: i64) -> ApiResult<Value> {
    let (user, bio, changed_at) = conn.query_row(
        &format!(
            "SELECT {USER_COLS}, u.bio, u.username_changed_at FROM users u \
             LEFT JOIN avatars av ON av.user_id = u.id WHERE u.id = ?1"
        ),
        [user_id],
        |r| Ok((auth::user_from_row(r, 0)?, r.get::<_, String>(5)?, r.get::<_, Option<i64>>(6)?)),
    )?;
    let mut v = json!(user);
    v["bio"] = json!(bio);
    // When the next username change is allowed (null = now).
    v["username_change_at"] = json!(changed_at
        .map(|t| t + USERNAME_COOLDOWN_SECS)
        .filter(|&t| t > util::now_secs()));
    // The previous username, while it's still reserved and can be switched back to.
    v["old_username"] = conn
        .query_row(
            "SELECT username, held_until FROM username_holds WHERE user_id = ?1 AND held_until > ?2 \
             ORDER BY held_until DESC LIMIT 1",
            params![user_id, util::now_secs()],
            |r| Ok(json!({ "username": r.get::<_, String>(0)?, "held_until": r.get::<_, i64>(1)? })),
        )
        .optional()?
        .unwrap_or(Value::Null);
    Ok(v)
}

/// Switch back to the username you just moved away from, while it's still held for you.
/// Doesn't reset the monthly timer, so it can't be used to change names more often.
pub async fn revert_username(State(state): State<Shared>, AuthUser(user): AuthUser) -> ApiResult<Json<Value>> {
    let conn = state.db.lock().unwrap();
    let held: Option<String> = conn
        .query_row(
            "SELECT username FROM username_holds WHERE user_id = ?1 AND held_until > ?2 ORDER BY held_until DESC LIMIT 1",
            params![user.id, util::now_secs()],
            |r| r.get(0),
        )
        .optional()?;
    let Some(old) = held else {
        return Err(ApiError::bad("There's no previous username to switch back to"));
    };
    conn.execute("DELETE FROM username_holds WHERE user_id = ?1", [user.id])?;
    conn.execute("UPDATE users SET username = ?2 WHERE id = ?1", params![user.id, old]).map_err(|e| match e {
        rusqlite::Error::SqliteFailure(f, _) if f.code == rusqlite::ErrorCode::ConstraintViolation => {
            ApiError::conflict("That username isn't available anymore")
        }
        e => ApiError::from(e),
    })?;
    Ok(Json(json!({ "user": me_json(&conn, user.id)? })))
}

#[derive(Deserialize)]
pub struct UsernameQuery {
    #[serde(default)]
    u: String,
}

/// Live availability check for the settings form.
pub async fn check_username(
    State(state): State<Shared>,
    AuthUser(user): AuthUser,
    axum::extract::Query(q): axum::extract::Query<UsernameQuery>,
) -> ApiResult<Json<Value>> {
    let name = match auth::validate_username(&q.u) {
        Ok(n) => n,
        Err(e) => return Ok(Json(json!({ "available": false, "reason": e.message }))),
    };
    let conn = state.db.lock().unwrap();
    if auth::username_taken(&conn, &name, user.id)? {
        return Ok(Json(json!({ "available": false, "reason": "That username is taken" })));
    }
    Ok(Json(json!({ "available": true, "same": name == user.username })))
}

#[derive(Deserialize)]
pub struct UsernameChange {
    username: String,
    password: String,
}

pub async fn change_username(
    State(state): State<Shared>,
    AuthUser(user): AuthUser,
    Json(body): Json<UsernameChange>,
) -> ApiResult<Json<Value>> {
    let name = auth::validate_username(&body.username)?;
    if name == user.username {
        return Err(ApiError::bad("That's already your username"));
    }
    let conn = state.db.lock().unwrap();
    if !auth::check_password(&conn, user.id, &body.password)? {
        return Err(ApiError::new(StatusCode::UNAUTHORIZED, "Wrong password"));
    }
    let now = util::now_secs();
    let last: Option<i64> =
        conn.query_row("SELECT username_changed_at FROM users WHERE id = ?1", [user.id], |r| r.get(0))?;
    if let Some(next) = last.map(|t| t + USERNAME_COOLDOWN_SECS).filter(|&t| t > now) {
        let days = (next - now + 86_399) / 86_400;
        return Err(ApiError::too_many(format!(
            "You can change your username once a month. Try again in {days} day{}.",
            if days == 1 { "" } else { "s" }
        )));
    }
    if auth::username_taken(&conn, &name, user.id)? {
        return Err(ApiError::conflict("That username is taken"));
    }
    // The UNIQUE NOCASE constraint is the final guard against a race with another signup.
    // Reserve the old name for 30 days; any older hold of ours is superseded.
    conn.execute("DELETE FROM username_holds WHERE user_id = ?1 OR held_until <= ?2", params![user.id, now])?;
    conn.execute(
        "INSERT OR REPLACE INTO username_holds (username, user_id, held_until) VALUES (?1, ?2, ?3)",
        params![user.username, user.id, now + USERNAME_COOLDOWN_SECS],
    )?;
    conn.execute(
        "UPDATE users SET username = ?2, username_changed_at = ?3 WHERE id = ?1",
        params![user.id, name, now],
    )
    .map_err(|e| match e {
        rusqlite::Error::SqliteFailure(f, _) if f.code == rusqlite::ErrorCode::ConstraintViolation => {
            ApiError::conflict("That username is taken")
        }
        e => ApiError::from(e),
    })?;
    Ok(Json(json!({ "user": me_json(&conn, user.id)? })))
}

/// The signed-in user's own profile, including the bio for the settings form.
pub async fn get_me(State(state): State<Shared>, AuthUser(user): AuthUser) -> ApiResult<Json<Value>> {
    let conn = state.db.lock().unwrap();
    Ok(Json(json!({ "user": me_json(&conn, user.id)? })))
}

#[derive(Deserialize)]
pub struct ProfileUpdate {
    #[serde(default)]
    display_name: Option<String>,
    #[serde(default)]
    bio: Option<String>,
}

pub async fn update_me(
    State(state): State<Shared>,
    AuthUser(user): AuthUser,
    Json(body): Json<ProfileUpdate>,
) -> ApiResult<Json<Value>> {
    let conn = state.db.lock().unwrap();
    if let Some(name) = body.display_name {
        // Collapse whitespace and drop control/invisible formatting characters.
        let visible: String = name
            .chars()
            .filter(|c| !c.is_control() && !matches!(c, '\u{200B}'..='\u{200F}' | '\u{202A}'..='\u{202E}' | '\u{2060}'..='\u{2069}' | '\u{FEFF}'))
            .collect();
        let name = visible.split_whitespace().collect::<Vec<_>>().join(" ");
        if name.chars().count() > MAX_DISPLAY_NAME {
            return Err(ApiError::bad(format!("Display names can be at most {MAX_DISPLAY_NAME} characters")));
        }
        let value = (!name.is_empty()).then_some(name);
        conn.execute("UPDATE users SET display_name = ?2 WHERE id = ?1", params![user.id, value])?;
    }
    if let Some(bio) = body.bio {
        let bio: String = bio
            .trim()
            .chars()
            .filter(|c| *c == '\n' || !c.is_control())
            .collect::<String>()
            .lines()
            .take(8)
            .collect::<Vec<_>>()
            .join("\n");
        if bio.chars().count() > MAX_BIO {
            return Err(ApiError::bad(format!("Your bio can be at most {MAX_BIO} characters")));
        }
        conn.execute("UPDATE users SET bio = ?2 WHERE id = ?1", params![user.id, bio])?;
    }
    Ok(Json(json!({ "user": me_json(&conn, user.id)? })))
}

/// Identify the image type from its first bytes. Anything else (including SVG) is refused.
fn sniff_image(data: &[u8]) -> Option<&'static str> {
    if data.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some("image/png")
    } else if data.starts_with(&[0xFF, 0xD8, 0xFF]) {
        Some("image/jpeg")
    } else if data.starts_with(b"GIF87a") || data.starts_with(b"GIF89a") {
        Some("image/gif")
    } else if data.len() > 12 && &data[0..4] == b"RIFF" && &data[8..12] == b"WEBP" {
        Some("image/webp")
    } else {
        None
    }
}

pub async fn upload_avatar(
    State(state): State<Shared>,
    AuthUser(user): AuthUser,
    body: Bytes,
) -> ApiResult<Json<Value>> {
    if body.len() > MAX_AVATAR_BYTES {
        return Err(ApiError::new(StatusCode::PAYLOAD_TOO_LARGE, "Profile pictures can be at most 1 MB"));
    }
    let Some(mime) = sniff_image(&body) else {
        return Err(ApiError::bad("That isn't a PNG, JPEG, GIF or WebP image"));
    };
    let conn = state.db.lock().unwrap();
    conn.execute(
        "INSERT INTO avatars (user_id, mime, data, updated_at) VALUES (?1, ?2, ?3, ?4) \
         ON CONFLICT(user_id) DO UPDATE SET mime = excluded.mime, data = excluded.data, updated_at = excluded.updated_at",
        params![user.id, mime, body.as_ref(), util::now_ms()],
    )?;
    Ok(Json(json!({ "user": me_json(&conn, user.id)? })))
}

pub async fn delete_avatar(State(state): State<Shared>, AuthUser(user): AuthUser) -> ApiResult<Json<Value>> {
    let conn = state.db.lock().unwrap();
    conn.execute("DELETE FROM avatars WHERE user_id = ?1", [user.id])?;
    Ok(Json(json!({ "user": me_json(&conn, user.id)? })))
}

pub async fn get_avatar(State(state): State<Shared>, Path(id): Path<i64>) -> ApiResult<Response> {
    let row: Option<(String, Vec<u8>)> = {
        let conn = state.db.lock().unwrap();
        conn.query_row("SELECT mime, data FROM avatars WHERE user_id = ?1", [id], |r| Ok((r.get(0)?, r.get(1)?)))
            .optional()?
    };
    let Some((mime, data)) = row else { return Err(ApiError::not_found("Picture")) };
    let mut res = data.into_response();
    let h = res.headers_mut();
    h.insert(header::CONTENT_TYPE, HeaderValue::from_str(&mime).unwrap_or(HeaderValue::from_static("image/png")));
    h.insert(header::X_CONTENT_TYPE_OPTIONS, HeaderValue::from_static("nosniff"));
    h.insert(header::CONTENT_SECURITY_POLICY, HeaderValue::from_static("default-src 'none'; sandbox"));
    h.insert(header::CONTENT_DISPOSITION, HeaderValue::from_static("inline"));
    // URLs carry ?v=<updated_at>, so a long cache is safe.
    h.insert(header::CACHE_CONTROL, HeaderValue::from_static("public, max-age=31536000, immutable"));
    Ok(res)
}
