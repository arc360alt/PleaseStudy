//! User reports on quizzes and accounts, staff actions (warn / take down / ban / delete),
//! and the notices that tell users what happened.
//!
//! Moderators can dismiss reports, take quizzes down and send warnings.
//! Admins can additionally delete quizzes, ban accounts temporarily and delete accounts.

use std::collections::HashMap;

use axum::{
    extract::{Path, Query, State},
    Json,
};
use rusqlite::{params, Connection, OptionalExtension};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::{
    auth::{AuthUser, User},
    error::{ApiError, ApiResult},
    quizzes, util, Shared,
};

const QUIZ_REASONS: &[&str] = &["inappropriate", "hateful", "spam", "wrong_answers", "copyright", "other"];
const USER_REASONS: &[&str] = &["inappropriate", "harassment", "spam", "impersonation", "other"];

fn clip(s: &str, max: usize) -> String {
    s.trim().chars().take(max).collect()
}

fn notify(conn: &Connection, user_id: i64, kind: &str, message: &str) -> ApiResult<()> {
    conn.execute(
        "INSERT INTO notices (user_id, kind, message, created_at) VALUES (?1, ?2, ?3, ?4)",
        params![user_id, kind, message, util::now_secs()],
    )?;
    Ok(())
}

fn user_id_by_name(conn: &Connection, username: &str) -> ApiResult<i64> {
    conn.query_row("SELECT id FROM users WHERE username = ?1", [username.trim()], |r| r.get(0))
        .optional()?
        .ok_or_else(|| ApiError::not_found("User"))
}

/// What staff need to know about an account when deciding what to do.
fn user_info(conn: &Connection, id: i64) -> ApiResult<Option<Value>> {
    Ok(conn
        .query_row(
            "SELECT u.id, u.username, u.role, u.created_at, u.banned_until, u.ban_reason, u.display_name, u.bio, \
             (SELECT updated_at FROM avatars WHERE user_id = u.id), \
             (SELECT COUNT(*) FROM quizzes q WHERE q.owner_id = u.id), \
             (SELECT COUNT(*) FROM notices n WHERE n.user_id = u.id AND n.kind = 'warning'), \
             (SELECT COUNT(*) FROM reports r WHERE r.kind = 'user' AND r.target_id = CAST(u.id AS TEXT)) \
             FROM users u WHERE u.id = ?1",
            [id],
            |r| {
                let banned_until: Option<i64> = r.get(4)?;
                Ok(json!({
                    "id": r.get::<_, i64>(0)?,
                    "username": r.get::<_, String>(1)?,
                    "role": r.get::<_, String>(2)?,
                    "created_at": r.get::<_, i64>(3)?,
                    "banned_until": banned_until.filter(|&b| b > util::now_secs()),
                    "ban_reason": r.get::<_, Option<String>>(5)?,
                    "display_name": r.get::<_, Option<String>>(6)?,
                    "bio": r.get::<_, String>(7)?,
                    "avatar_url": crate::auth::avatar_url(r.get(0)?, r.get(8)?),
                    "quiz_count": r.get::<_, i64>(9)?,
                    "warnings": r.get::<_, i64>(10)?,
                    "times_reported": r.get::<_, i64>(11)?,
                }))
            },
        )
        .optional()?)
}

// ---------------------------------------------------------------- filing reports

#[derive(Deserialize)]
pub struct NewReport {
    kind: String,
    /// Quiz id, or username for account reports.
    target: String,
    reason: String,
    #[serde(default)]
    details: String,
}

pub async fn create(
    State(state): State<Shared>,
    AuthUser(user): AuthUser,
    Json(body): Json<NewReport>,
) -> ApiResult<Json<Value>> {
    let conn = state.db.lock().unwrap();
    let (target_id, reasons) = match body.kind.as_str() {
        "quiz" => {
            let quiz = quizzes::load(&conn, &body.target)?;
            if !quiz.can_use(Some(&user)) {
                return Err(ApiError::not_found("Quiz"));
            }
            if quiz.summary.owner_id == user.id {
                return Err(ApiError::bad("You can't report your own quiz"));
            }
            (quiz.summary.id, QUIZ_REASONS)
        }
        "user" => {
            let id = user_id_by_name(&conn, &body.target)?;
            if id == user.id {
                return Err(ApiError::bad("You can't report yourself"));
            }
            (id.to_string(), USER_REASONS)
        }
        _ => return Err(ApiError::bad("Unknown report type")),
    };
    if !reasons.contains(&body.reason.as_str()) {
        return Err(ApiError::bad("Pick a reason"));
    }
    let already: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM reports WHERE kind = ?1 AND target_id = ?2 AND reporter_id = ?3 AND status = 'open')",
        params![body.kind, target_id, user.id],
        |r| r.get(0),
    )?;
    if already {
        return Ok(Json(json!({ "ok": true, "already": true })));
    }
    let recent: i64 = conn.query_row(
        "SELECT COUNT(*) FROM reports WHERE reporter_id = ?1 AND created_at > ?2",
        params![user.id, util::now_secs() - 86_400],
        |r| r.get(0),
    )?;
    if recent >= 30 {
        return Err(ApiError::bad("You've sent a lot of reports today. Try again tomorrow."));
    }
    conn.execute(
        "INSERT INTO reports (kind, target_id, reporter_id, reason, details, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![body.kind, target_id, user.id, body.reason, clip(&body.details, 1000), util::now_secs()],
    )?;
    Ok(Json(json!({ "ok": true, "already": false })))
}

// ---------------------------------------------------------------- staff: report queue

#[derive(Deserialize)]
pub struct ListQuery {
    #[serde(default)]
    status: String,
}

/// Reports grouped into one case per reported quiz/account, most recently reported first.
pub async fn list(
    State(state): State<Shared>,
    AuthUser(user): AuthUser,
    Query(q): Query<ListQuery>,
) -> ApiResult<Json<Value>> {
    if !user.is_moderator() {
        return Err(ApiError::forbidden());
    }
    let open = q.status != "closed";
    let conn = state.db.lock().unwrap();
    let mut stmt = conn.prepare(
        "SELECT r.id, r.kind, r.target_id, r.reason, r.details, r.status, r.resolution, r.created_at, \
         u.username, m.username \
         FROM reports r LEFT JOIN users u ON u.id = r.reporter_id LEFT JOIN users m ON m.id = r.resolved_by \
         WHERE (r.status = 'open') = ?1 ORDER BY r.created_at DESC LIMIT 400",
    )?;
    let rows = stmt
        .query_map([open], |r| {
            Ok((
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                json!({
                    "id": r.get::<_, i64>(0)?,
                    "reason": r.get::<_, String>(3)?,
                    "details": r.get::<_, String>(4)?,
                    "status": r.get::<_, String>(5)?,
                    "resolution": r.get::<_, Option<String>>(6)?,
                    "created_at": r.get::<_, i64>(7)?,
                    "reporter": r.get::<_, Option<String>>(8)?,
                    "resolved_by": r.get::<_, Option<String>>(9)?,
                }),
            ))
        })?
        .collect::<Result<Vec<_>, _>>()?;

    let mut order: Vec<(String, String)> = Vec::new();
    let mut grouped: HashMap<(String, String), Vec<Value>> = HashMap::new();
    for (kind, target, report) in rows {
        let key = (kind, target);
        if !grouped.contains_key(&key) {
            order.push(key.clone());
        }
        grouped.entry(key).or_default().push(report);
    }

    let cases = order
        .into_iter()
        .map(|key| {
            let reports = grouped.remove(&key).unwrap_or_default();
            let (kind, target_id) = key;
            let (quiz, account) = if kind == "quiz" {
                match quizzes::load(&conn, &target_id) {
                    Ok(q) => {
                        let owner = user_info(&conn, q.summary.owner_id)?;
                        (Some(q.full_json(Some(&user))), owner)
                    }
                    Err(_) => (None, None),
                }
            } else {
                (None, target_id.parse().ok().map(|id| user_info(&conn, id)).transpose()?.flatten())
            };
            Ok(json!({
                "kind": kind,
                "target_id": target_id,
                "quiz": quiz,
                "user": account,
                "reports": reports,
            }))
        })
        .collect::<ApiResult<Vec<_>>>()?;
    Ok(Json(json!({ "cases": cases })))
}

// ---------------------------------------------------------------- staff: actions

#[derive(Deserialize)]
pub struct ActionBody {
    action: String,
    #[serde(default)]
    message: String,
    #[serde(default)]
    days: Option<u32>,
}

/// Staff may only act on accounts ranked below them, and never on themselves.
fn check_target(actor: &User, conn: &Connection, target: i64) -> ApiResult<String> {
    if target == actor.id {
        return Err(ApiError::bad("You can't do that to your own account"));
    }
    let role: String = conn
        .query_row("SELECT role FROM users WHERE id = ?1", [target], |r| r.get(0))
        .optional()?
        .ok_or_else(|| ApiError::not_found("User"))?;
    let allowed = match role.as_str() {
        "admin" => false,
        "moderator" => actor.is_admin(),
        _ => true,
    };
    if !allowed {
        return Err(ApiError::new(axum::http::StatusCode::FORBIDDEN, "You can't take action against that account"));
    }
    Ok(role)
}

/// Performs one staff action. Returns a short description for the report log.
fn apply_action(
    conn: &Connection,
    actor: &User,
    target_user: Option<i64>,
    quiz_id: Option<&str>,
    body: &ActionBody,
) -> ApiResult<String> {
    if !actor.is_moderator() {
        return Err(ApiError::forbidden());
    }
    let message = clip(&body.message, 1000);
    let need_admin = || if actor.is_admin() { Ok(()) } else { Err(ApiError::forbidden()) };
    let need_message = || {
        if message.is_empty() {
            Err(ApiError::bad("Write a message so they know why"))
        } else {
            Ok(())
        }
    };
    let need_user = || target_user.ok_or_else(|| ApiError::not_found("User"));
    let need_quiz = || -> ApiResult<quizzes::QuizRow> {
        quizzes::load(conn, quiz_id.ok_or_else(|| ApiError::not_found("Quiz"))?)
    };

    match body.action.as_str() {
        "dismiss" => Ok(format!("Dismissed{}", if message.is_empty() { String::new() } else { format!(": {message}") })),

        "takedown" => {
            need_message()?;
            let quiz = need_quiz()?;
            conn.execute(
                "UPDATE quizzes SET status = 'rejected', mod_note = ?2, reviewed_by = ?3 WHERE id = ?1",
                params![quiz.summary.id, message, actor.id],
            )?;
            notify(
                conn,
                quiz.summary.owner_id,
                "quiz_removed",
                &format!("Your quiz “{}” was taken down by the moderators: {message}", quiz.summary.title),
            )?;
            Ok(format!("Quiz taken down: {message}"))
        }

        "delete_quiz" => {
            need_admin()?;
            need_message()?;
            let quiz = need_quiz()?;
            conn.execute("DELETE FROM quizzes WHERE id = ?1", [&quiz.summary.id])?;
            notify(
                conn,
                quiz.summary.owner_id,
                "quiz_removed",
                &format!("Your quiz “{}” was deleted by an admin: {message}", quiz.summary.title),
            )?;
            Ok(format!("Quiz deleted: {message}"))
        }

        "warn" => {
            need_message()?;
            let uid = need_user()?;
            check_target(actor, conn, uid)?;
            notify(conn, uid, "warning", &message)?;
            Ok(format!("Warning sent: {message}"))
        }

        "ban" => {
            need_admin()?;
            need_message()?;
            let uid = need_user()?;
            check_target(actor, conn, uid)?;
            let days = body.days.filter(|d| (1..=365).contains(d)).ok_or_else(|| ApiError::bad("Ban length must be 1–365 days"))?;
            conn.execute(
                "UPDATE users SET banned_until = ?2, ban_reason = ?3 WHERE id = ?1",
                params![uid, util::now_secs() + days as i64 * 86_400, message],
            )?;
            conn.execute("DELETE FROM sessions WHERE user_id = ?1", [uid])?;
            notify(
                conn,
                uid,
                "ban",
                &format!("Your account was suspended for {days} day{}: {message}", if days == 1 { "" } else { "s" }),
            )?;
            Ok(format!("Banned {days}d: {message}"))
        }

        "reset_profile" => {
            need_message()?;
            let uid = need_user()?;
            check_target(actor, conn, uid)?;
            conn.execute("UPDATE users SET display_name = NULL, bio = '' WHERE id = ?1", [uid])?;
            conn.execute("DELETE FROM avatars WHERE user_id = ?1", [uid])?;
            notify(
                conn,
                uid,
                "warning",
                &format!("The moderators reset your profile picture, display name and bio: {message}"),
            )?;
            Ok(format!("Profile reset: {message}"))
        }

        "unban" => {
            need_admin()?;
            let uid = need_user()?;
            conn.execute("UPDATE users SET banned_until = NULL, ban_reason = NULL WHERE id = ?1", [uid])?;
            Ok("Ban lifted".into())
        }

        "delete_account" => {
            need_admin()?;
            let uid = need_user()?;
            check_target(actor, conn, uid)?;
            // Cascades to sessions, quizzes, assignments and notices.
            conn.execute("DELETE FROM users WHERE id = ?1", [uid])?;
            Ok(format!("Account deleted{}", if message.is_empty() { String::new() } else { format!(": {message}") }))
        }

        _ => Err(ApiError::bad("Unknown action")),
    }
}

fn close_reports(conn: &Connection, actor: &User, kind: &str, target_id: &str, action: &str, resolution: &str) -> ApiResult<()> {
    conn.execute(
        "UPDATE reports SET status = ?3, resolution = ?4, resolved_by = ?5, resolved_at = ?6 \
         WHERE kind = ?1 AND target_id = ?2 AND status = 'open'",
        params![
            kind,
            target_id,
            if action == "dismiss" { "dismissed" } else { "resolved" },
            resolution,
            actor.id,
            util::now_secs()
        ],
    )?;
    Ok(())
}

#[derive(Deserialize)]
pub struct ResolveBody {
    kind: String,
    target_id: String,
    #[serde(flatten)]
    action: ActionBody,
}

/// Act on a report case. For quiz cases, account actions apply to the quiz's owner.
pub async fn resolve(
    State(state): State<Shared>,
    AuthUser(user): AuthUser,
    Json(body): Json<ResolveBody>,
) -> ApiResult<Json<Value>> {
    let conn = state.db.lock().unwrap();
    let (target_user, quiz_id) = match body.kind.as_str() {
        "quiz" => {
            let owner = quizzes::load(&conn, &body.target_id).ok().map(|q| q.summary.owner_id);
            (owner, Some(body.target_id.as_str()))
        }
        "user" => (body.target_id.parse().ok(), None),
        _ => return Err(ApiError::bad("Unknown report type")),
    };
    let resolution = apply_action(&conn, &user, target_user, quiz_id, &body.action)?;
    close_reports(&conn, &user, &body.kind, &body.target_id, &body.action.action, &resolution)?;
    Ok(Json(json!({ "ok": true, "resolution": resolution })))
}

/// Act on an account directly (from the admin users list).
pub async fn user_action(
    State(state): State<Shared>,
    AuthUser(user): AuthUser,
    Path(id): Path<i64>,
    Json(body): Json<ActionBody>,
) -> ApiResult<Json<Value>> {
    let conn = state.db.lock().unwrap();
    let resolution = apply_action(&conn, &user, Some(id), None, &body)?;
    if body.action != "unban" {
        close_reports(&conn, &user, "user", &id.to_string(), &body.action, &resolution)?;
    }
    Ok(Json(json!({ "ok": true, "resolution": resolution, "user": user_info(&conn, id)? })))
}

// ---------------------------------------------------------------- notices

pub async fn my_notices(State(state): State<Shared>, AuthUser(user): AuthUser) -> ApiResult<Json<Value>> {
    let conn = state.db.lock().unwrap();
    let notices: Vec<Value> = conn
        .prepare("SELECT id, kind, message, created_at FROM notices WHERE user_id = ?1 AND read_at IS NULL ORDER BY created_at")?
        .query_map([user.id], |r| {
            Ok(json!({
                "id": r.get::<_, i64>(0)?,
                "kind": r.get::<_, String>(1)?,
                "message": r.get::<_, String>(2)?,
                "created_at": r.get::<_, i64>(3)?,
            }))
        })?
        .collect::<Result<_, _>>()?;
    Ok(Json(json!({ "notices": notices })))
}

pub async fn ack_notice(
    State(state): State<Shared>,
    AuthUser(user): AuthUser,
    Path(id): Path<i64>,
) -> ApiResult<Json<Value>> {
    let conn = state.db.lock().unwrap();
    conn.execute(
        "UPDATE notices SET read_at = ?3 WHERE id = ?1 AND user_id = ?2",
        params![id, user.id, util::now_secs()],
    )?;
    Ok(Json(json!({ "ok": true })))
}

// ---------------------------------------------------------------- public profiles

pub async fn profile(State(state): State<Shared>, Path(username): Path<String>) -> ApiResult<Json<Value>> {
    let conn = state.db.lock().unwrap();
    let user: Option<(crate::auth::User, i64, String)> = conn
        .query_row(
            &format!(
                "SELECT {}, u.created_at, u.bio FROM users u LEFT JOIN avatars av ON av.user_id = u.id WHERE u.username = ?1",
                crate::auth::USER_COLS
            ),
            [username.trim()],
            |r| Ok((crate::auth::user_from_row(r, 0)?, r.get(5)?, r.get(6)?)),
        )
        .optional()?;
    let Some((user, created_at, bio)) = user else {
        // A recently changed username points to the account's new profile while it's held.
        let moved: Option<String> = conn
            .query_row(
                "SELECT u.username FROM username_holds h JOIN users u ON u.id = h.user_id \
                 WHERE h.username = ?1 COLLATE NOCASE AND h.held_until > ?2",
                params![username.trim(), util::now_secs()],
                |r| r.get(0),
            )
            .optional()?;
        return match moved {
            Some(to) => Ok(Json(json!({ "moved_to": to }))),
            None => Err(ApiError::not_found("User")),
        };
    };
    let quizzes = quizzes::list_where(
        &conn,
        "WHERE q.owner_id = ?1 AND q.status = 'approved' AND q.listed = 1 ORDER BY q.plays DESC, q.updated_at DESC LIMIT 60",
        &[&user.id],
    )?;
    Ok(Json(json!({
        "id": user.id,
        "username": user.username,
        "display_name": user.display_name,
        "avatar_url": user.avatar_url,
        "bio": bio,
        "role": user.role,
        "created_at": created_at,
        "quizzes": quizzes,
    })))
}
