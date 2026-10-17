use argon2::{
    password_hash::{PasswordHash, PasswordHasher, PasswordVerifier, SaltString},
    Argon2,
};
use axum::{
    async_trait,
    extract::{FromRequestParts, State},
    http::{header::AUTHORIZATION, request::Parts, HeaderMap},
    Json,
};
use rand::RngCore;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::{
    error::{ApiError, ApiResult},
    util, Shared,
};

#[derive(Debug, Clone, Serialize)]
pub struct User {
    pub id: i64,
    pub username: String,
    pub role: String,
    pub display_name: Option<String>,
    pub avatar_url: Option<String>,
}

/// Columns for `user_from_row`; expects `users u LEFT JOIN avatars av ON av.user_id = u.id`.
pub const USER_COLS: &str = "u.id, u.username, u.role, u.display_name, av.updated_at";

pub fn avatar_url(user_id: i64, updated_at: Option<i64>) -> Option<String> {
    updated_at.map(|t| format!("/api/avatars/{user_id}?v={t}"))
}

pub fn user_from_row(r: &rusqlite::Row, offset: usize) -> rusqlite::Result<User> {
    let id: i64 = r.get(offset)?;
    Ok(User {
        id,
        username: r.get(offset + 1)?,
        role: r.get(offset + 2)?,
        display_name: r.get(offset + 3)?,
        avatar_url: avatar_url(id, r.get(offset + 4)?),
    })
}

impl User {
    /// What to show people: the display name if set, otherwise the username.
    pub fn name(&self) -> String {
        self.display_name.clone().unwrap_or_else(|| self.username.clone())
    }

    pub fn is_moderator(&self) -> bool {
        self.role == "moderator" || self.role == "admin"
    }
    pub fn is_admin(&self) -> bool {
        self.role == "admin"
    }
}

/// Resolves to `Some(user)` when a valid bearer token is present.
pub struct MaybeUser(pub Option<User>);

/// Rejects the request unless a valid bearer token is present.
pub struct AuthUser(pub User);

pub fn user_from_token(conn: &Connection, token: &str) -> rusqlite::Result<Option<User>> {
    conn.query_row(
        // Suspended accounts are treated as logged out.
        &format!(
            "SELECT {USER_COLS} FROM sessions s JOIN users u ON u.id = s.user_id \
             LEFT JOIN avatars av ON av.user_id = u.id \
             WHERE s.token = ?1 AND (u.banned_until IS NULL OR u.banned_until <= ?2)"
        ),
        params![token, util::now_secs()],
        |r| user_from_row(r, 0),
    )
    .optional()
}

fn bearer(parts: &Parts) -> Option<&str> {
    parts.headers.get(AUTHORIZATION)?.to_str().ok()?.strip_prefix("Bearer ")
}

#[async_trait]
impl FromRequestParts<Shared> for MaybeUser {
    type Rejection = ApiError;

    async fn from_request_parts(parts: &mut Parts, state: &Shared) -> Result<Self, Self::Rejection> {
        let Some(token) = bearer(parts) else { return Ok(MaybeUser(None)) };
        let conn = state.db.lock().unwrap();
        Ok(MaybeUser(user_from_token(&conn, token)?))
    }
}

#[async_trait]
impl FromRequestParts<Shared> for AuthUser {
    type Rejection = ApiError;

    async fn from_request_parts(parts: &mut Parts, state: &Shared) -> Result<Self, Self::Rejection> {
        match MaybeUser::from_request_parts(parts, state).await? {
            MaybeUser(Some(user)) => Ok(AuthUser(user)),
            MaybeUser(None) => Err(ApiError::unauthorized()),
        }
    }
}

fn hash_password(password: &str) -> ApiResult<String> {
    let mut salt = [0u8; 16];
    rand::thread_rng().fill_bytes(&mut salt);
    let salt = SaltString::encode_b64(&salt).map_err(ApiError::internal)?;
    Ok(Argon2::default()
        .hash_password(password.as_bytes(), &salt)
        .map_err(ApiError::internal)?
        .to_string())
}

fn verify_password(password: &str, hash: &str) -> bool {
    PasswordHash::new(hash)
        .map(|h| Argon2::default().verify_password(password.as_bytes(), &h).is_ok())
        .unwrap_or(false)
}

fn new_session(conn: &Connection, user_id: i64) -> ApiResult<String> {
    let token = util::token(48);
    conn.execute(
        "INSERT INTO sessions (token, user_id, created_at) VALUES (?1, ?2, ?3)",
        params![token, user_id, util::now_secs()],
    )?;
    Ok(token)
}

#[derive(Deserialize)]
pub struct Credentials {
    username: String,
    password: String,
}

/// Shared rules for new and changed usernames. Returns the trimmed name.
pub fn validate_username(raw: &str) -> ApiResult<String> {
    let username = raw.trim().to_string();
    let valid_chars = username.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-');
    if !(3..=24).contains(&username.len()) || !valid_chars {
        return Err(ApiError::bad("Usernames are 3–24 characters: letters, numbers, _ and -"));
    }
    Ok(username)
}

/// Whether another account uses this name, or is still holding it after a recent change
/// (case-insensitive). `except_user` may use its own current or held name.
pub fn username_taken(conn: &Connection, username: &str, except_user: i64) -> rusqlite::Result<bool> {
    conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM users WHERE username = ?1 COLLATE NOCASE AND id != ?2) \
             OR EXISTS(SELECT 1 FROM username_holds WHERE username = ?1 COLLATE NOCASE AND user_id != ?2 AND held_until > ?3)",
        params![username, except_user, util::now_secs()],
        |r| r.get(0),
    )
}

pub fn check_password(conn: &Connection, user_id: i64, password: &str) -> ApiResult<bool> {
    let hash: String = conn.query_row("SELECT password_hash FROM users WHERE id = ?1", [user_id], |r| r.get(0))?;
    Ok(verify_password(password, &hash))
}

pub async fn register(State(state): State<Shared>, Json(body): Json<Credentials>) -> ApiResult<Json<Value>> {
    let username = validate_username(&body.username)?;
    if body.password.len() < 8 {
        return Err(ApiError::bad("Passwords need at least 8 characters"));
    }
    let hash = hash_password(&body.password)?;

    let conn = state.db.lock().unwrap();
    let taken = username_taken(&conn, &username, -1)?;
    if taken {
        return Err(ApiError::conflict("That username is taken"));
    }
    // The very first account becomes the admin so the site can be bootstrapped.
    let user_count: i64 = conn.query_row("SELECT COUNT(*) FROM users", [], |r| r.get(0))?;
    let role = if user_count == 0 { "admin" } else { "user" };
    conn.execute(
        "INSERT INTO users (username, password_hash, role, created_at) VALUES (?1, ?2, ?3, ?4)",
        params![username, hash, role, util::now_secs()],
    )?;
    let user = User {
        id: conn.last_insert_rowid(),
        username,
        role: role.into(),
        display_name: None,
        avatar_url: None,
    };
    let token = new_session(&conn, user.id)?;
    Ok(Json(json!({ "token": token, "user": user })))
}

pub async fn login(State(state): State<Shared>, Json(body): Json<Credentials>) -> ApiResult<Json<Value>> {
    let row = {
        let conn = state.db.lock().unwrap();
        conn.query_row(
            &format!(
                "SELECT {USER_COLS}, u.password_hash, u.banned_until, u.ban_reason \
                 FROM users u LEFT JOIN avatars av ON av.user_id = u.id WHERE u.username = ?1"
            ),
            [body.username.trim()],
            |r| {
                Ok((
                    user_from_row(r, 0)?,
                    r.get::<_, String>(5)?,
                    r.get::<_, Option<i64>>(6)?,
                    r.get::<_, Option<String>>(7)?,
                ))
            },
        )
        .optional()?
    };
    let Some((user, _, banned_until, ban_reason)) =
        row.filter(|(_, hash, _, _)| verify_password(&body.password, hash))
    else {
        return Err(ApiError::new(
            axum::http::StatusCode::UNAUTHORIZED,
            "Wrong username or password",
        ));
    };
    if let Some(until) = banned_until.filter(|&u| u > util::now_secs()) {
        let days = (until - util::now_secs() + 86_399) / 86_400;
        let reason = ban_reason.map(|r| format!(" Reason: {r}")).unwrap_or_default();
        return Err(ApiError::new(
            axum::http::StatusCode::FORBIDDEN,
            format!(
                "This account is suspended for {days} more day{}.{reason}",
                if days == 1 { "" } else { "s" }
            ),
        ));
    }
    let conn = state.db.lock().unwrap();
    let token = new_session(&conn, user.id)?;
    Ok(Json(json!({ "token": token, "user": user })))
}

pub async fn logout(State(state): State<Shared>, headers: HeaderMap) -> ApiResult<Json<Value>> {
    let token = headers.get(AUTHORIZATION).and_then(|v| v.to_str().ok()).and_then(|v| v.strip_prefix("Bearer "));
    if let Some(token) = token {
        state.db.lock().unwrap().execute("DELETE FROM sessions WHERE token = ?1", [token])?;
    }
    Ok(Json(json!({ "ok": true })))
}

pub async fn me(MaybeUser(user): MaybeUser) -> Json<Value> {
    Json(json!({ "user": user }))
}
