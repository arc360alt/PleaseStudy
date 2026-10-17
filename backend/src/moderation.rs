use axum::{
    extract::{Path, Query, State},
    Json,
};
use rusqlite::params;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::{
    auth::AuthUser,
    error::{ApiError, ApiResult},
    quizzes, util, Shared,
};

/// Everything waiting for review, oldest first, with answers so mods can check them.
pub async fn queue(State(state): State<Shared>, AuthUser(user): AuthUser) -> ApiResult<Json<Value>> {
    if !user.is_moderator() {
        return Err(ApiError::forbidden());
    }
    let conn = state.db.lock().unwrap();
    let ids: Vec<String> = conn
        .prepare("SELECT id FROM quizzes WHERE status = 'pending' ORDER BY submitted_at ASC LIMIT 100")?
        .query_map([], |r| r.get(0))?
        .collect::<Result<_, _>>()?;
    let quizzes = ids
        .iter()
        .map(|id| quizzes::load(&conn, id).map(|q| q.full_json(Some(&user))))
        .collect::<ApiResult<Vec<_>>>()?;
    Ok(Json(json!({ "quizzes": quizzes })))
}

#[derive(Deserialize)]
pub struct Review {
    approve: bool,
    #[serde(default)]
    note: Option<String>,
}

pub async fn review(
    State(state): State<Shared>,
    AuthUser(user): AuthUser,
    Path(id): Path<String>,
    Json(body): Json<Review>,
) -> ApiResult<Json<Value>> {
    if !user.is_moderator() {
        return Err(ApiError::forbidden());
    }
    let conn = state.db.lock().unwrap();
    let quiz = quizzes::load(&conn, &id)?;
    // Mods can act on queued quizzes, and can also take down already-public ones.
    if !matches!(quiz.summary.status.as_str(), "pending" | "approved") {
        return Err(ApiError::bad("This quiz isn't waiting for review"));
    }
    let note = body.note.map(|n| n.trim().chars().take(500).collect::<String>()).filter(|n| !n.is_empty());
    if !body.approve && note.is_none() {
        return Err(ApiError::bad("Leave a note so the creator knows what to fix"));
    }
    let status = if body.approve { "approved" } else { "rejected" };
    conn.execute(
        "UPDATE quizzes SET status = ?2, mod_note = ?3, reviewed_by = ?4, updated_at = ?5 WHERE id = ?1",
        params![id, status, note, user.id, util::now_secs()],
    )?;
    Ok(Json(json!({ "ok": true, "status": status })))
}

#[derive(Deserialize)]
pub struct UserSearch {
    #[serde(default)]
    q: String,
}

pub async fn list_users(
    State(state): State<Shared>,
    AuthUser(user): AuthUser,
    Query(query): Query<UserSearch>,
) -> ApiResult<Json<Value>> {
    if !user.is_admin() {
        return Err(ApiError::forbidden());
    }
    let conn = state.db.lock().unwrap();
    let pattern = format!("%{}%", query.q.trim());
    let users: Vec<Value> = conn
        .prepare(
            "SELECT u.id, u.username, u.role, u.created_at, \
             (SELECT COUNT(*) FROM quizzes q WHERE q.owner_id = u.id), \
             CASE WHEN u.banned_until > ?2 THEN u.banned_until END, u.ban_reason, \
             (SELECT COUNT(*) FROM notices n WHERE n.user_id = u.id AND n.kind = 'warning'), \
             (SELECT COUNT(*) FROM reports r WHERE r.kind = 'user' AND r.target_id = CAST(u.id AS TEXT) AND r.status = 'open'), \
             u.display_name, (SELECT updated_at FROM avatars WHERE user_id = u.id) \
             FROM users u WHERE u.username LIKE ?1 ORDER BY u.role = 'user', u.username LIMIT 100",
        )?
        .query_map(rusqlite::params![pattern, util::now_secs()], |r| {
            Ok(json!({
                "id": r.get::<_, i64>(0)?,
                "username": r.get::<_, String>(1)?,
                "role": r.get::<_, String>(2)?,
                "created_at": r.get::<_, i64>(3)?,
                "quiz_count": r.get::<_, i64>(4)?,
                "banned_until": r.get::<_, Option<i64>>(5)?,
                "ban_reason": r.get::<_, Option<String>>(6)?,
                "warnings": r.get::<_, i64>(7)?,
                "open_reports": r.get::<_, i64>(8)?,
                "display_name": r.get::<_, Option<String>>(9)?,
                "avatar_url": crate::auth::avatar_url(r.get(0)?, r.get(10)?),
            }))
        })?
        .collect::<Result<_, _>>()?;
    Ok(Json(json!({ "users": users })))
}

#[derive(Deserialize)]
pub struct SetRole {
    role: String,
}

pub async fn set_role(
    State(state): State<Shared>,
    AuthUser(user): AuthUser,
    Path(id): Path<i64>,
    Json(body): Json<SetRole>,
) -> ApiResult<Json<Value>> {
    if !user.is_admin() {
        return Err(ApiError::forbidden());
    }
    if !matches!(body.role.as_str(), "user" | "moderator" | "admin") {
        return Err(ApiError::bad("Unknown role"));
    }
    if id == user.id {
        return Err(ApiError::bad("You can't change your own role"));
    }
    let conn = state.db.lock().unwrap();
    let changed = conn.execute("UPDATE users SET role = ?2 WHERE id = ?1", params![id, body.role])?;
    if changed == 0 {
        return Err(ApiError::not_found("User"));
    }
    Ok(Json(json!({ "ok": true })))
}
