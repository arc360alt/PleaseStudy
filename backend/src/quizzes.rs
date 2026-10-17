use axum::{
    extract::{Path, Query, State},
    Json,
};
use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::{
    auth::{AuthUser, MaybeUser, User},
    error::{ApiError, ApiResult},
    models::{clean_url, validate_questions, Question},
    util, Shared,
};

#[derive(Debug, Clone, Serialize)]
pub struct QuizSummary {
    pub id: String,
    pub title: String,
    pub description: String,
    pub cover_url: Option<String>,
    pub question_count: i64,
    /// Username (handle); used for profile links.
    pub owner: String,
    /// Display name, falling back to the username.
    pub owner_name: String,
    pub owner_avatar: Option<String>,
    pub owner_id: i64,
    pub status: String,
    pub listed: bool,
    pub mod_note: Option<String>,
    pub plays: i64,
    pub created_at: i64,
    pub updated_at: i64,
}

pub struct QuizRow {
    pub summary: QuizSummary,
    pub questions: Vec<Question>,
}

impl QuizRow {
    pub fn can_edit(&self, user: Option<&User>) -> bool {
        user.is_some_and(|u| u.id == self.summary.owner_id)
    }
    /// Who may see the full quiz, answers included.
    pub fn can_see_answers(&self, user: Option<&User>) -> bool {
        user.is_some_and(|u| u.id == self.summary.owner_id || u.is_moderator())
    }
    /// Who may play, host or assign it.
    pub fn can_use(&self, user: Option<&User>) -> bool {
        self.summary.status == "approved" || self.can_see_answers(user)
    }
    pub fn full_json(&self, user: Option<&User>) -> Value {
        let mut v = serde_json::to_value(&self.summary).unwrap();
        v["can_edit"] = json!(self.can_edit(user));
        v["questions"] = if self.can_see_answers(user) {
            json!(self.questions)
        } else {
            Value::Null
        };
        v
    }
}

const SELECT: &str = "SELECT q.id, q.title, q.description, q.cover_url, q.question_count, u.username, \
     q.owner_id, q.status, q.mod_note, q.plays, q.created_at, q.updated_at, q.questions, q.listed, \
     COALESCE(u.display_name, u.username), av.updated_at \
     FROM quizzes q JOIN users u ON u.id = q.owner_id LEFT JOIN avatars av ON av.user_id = q.owner_id";

fn summary_from_row(r: &Row) -> rusqlite::Result<QuizSummary> {
    Ok(QuizSummary {
        id: r.get(0)?,
        title: r.get(1)?,
        description: r.get(2)?,
        cover_url: r.get(3)?,
        question_count: r.get(4)?,
        owner: r.get(5)?,
        owner_name: r.get(14)?,
        owner_avatar: crate::auth::avatar_url(r.get(6)?, r.get(15)?),
        owner_id: r.get(6)?,
        status: r.get(7)?,
        mod_note: r.get(8)?,
        plays: r.get(9)?,
        created_at: r.get(10)?,
        updated_at: r.get(11)?,
        listed: r.get(13)?,
    })
}

pub fn load(conn: &Connection, id: &str) -> ApiResult<QuizRow> {
    let row = conn
        .query_row(&format!("{SELECT} WHERE q.id = ?1"), [id], |r| {
            Ok((summary_from_row(r)?, r.get::<_, String>(12)?))
        })
        .optional()?;
    let Some((summary, questions)) = row else { return Err(ApiError::not_found("Quiz")) };
    Ok(QuizRow { summary, questions: serde_json::from_str(&questions)? })
}

pub fn list_where(conn: &Connection, clause: &str, params: &[&dyn rusqlite::ToSql]) -> ApiResult<Vec<QuizSummary>> {
    let mut stmt = conn.prepare(&format!("{SELECT} {clause}"))?;
    let rows = stmt.query_map(params, summary_from_row)?.collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

/// One submission to the review queue per this many seconds per account (staff exempt).
const SUBMIT_COOLDOWN_SECS: i64 = 4 * 60;
/// Most quizzes one account can have waiting in the review queue at once (staff exempt).
const MAX_PENDING: i64 = 2;

/// Anti-spam checks before a quiz enters the review queue. Records the submission time on success.
fn guard_submission(conn: &Connection, user: &User, quiz_id: &str) -> ApiResult<()> {
    if user.is_moderator() {
        return Ok(());
    }
    let now = util::now_secs();
    let last: Option<i64> =
        conn.query_row("SELECT last_submit_at FROM users WHERE id = ?1", [user.id], |r| r.get(0))?;
    if let Some(wait) = last.map(|t| t + SUBMIT_COOLDOWN_SECS - now).filter(|&w| w > 0) {
        return Err(ApiError::too_many(format!(
            "You can send one quiz for review every 4 minutes. Try again in {}:{:02}.",
            wait / 60,
            wait % 60
        )));
    }
    let except_quiz = quiz_id;
    let pending: i64 = conn.query_row(
        "SELECT COUNT(*) FROM quizzes WHERE owner_id = ?1 AND status = 'pending' AND id != ?2",
        params![user.id, except_quiz],
        |r| r.get(0),
    )?;
    if pending >= MAX_PENDING {
        return Err(ApiError::too_many(format!(
            "You already have {MAX_PENDING} quizzes waiting for review. Wait for the moderators to get to one first."
        )));
    }
    conn.execute("UPDATE users SET last_submit_at = ?2 WHERE id = ?1", params![user.id, now])?;
    Ok(())
}

pub fn bump_plays(conn: &Connection, id: &str) {
    let _ = conn.execute("UPDATE quizzes SET plays = plays + 1 WHERE id = ?1", [id]);
}

#[derive(Deserialize)]
pub struct QuizInput {
    title: String,
    #[serde(default)]
    description: String,
    #[serde(default)]
    cover_url: Option<String>,
    questions: Vec<Question>,
}

struct CleanQuiz {
    title: String,
    description: String,
    cover_url: Option<String>,
    questions: Vec<Question>,
}

fn clean(input: QuizInput) -> ApiResult<CleanQuiz> {
    let title = input.title.trim().to_string();
    if title.is_empty() || title.chars().count() > 120 {
        return Err(ApiError::bad("Title must be 1–120 characters"));
    }
    let description = input.description.trim().to_string();
    if description.chars().count() > 1000 {
        return Err(ApiError::bad("Description must be under 1000 characters"));
    }
    Ok(CleanQuiz {
        title,
        description,
        cover_url: clean_url(input.cover_url, "Cover image")?,
        questions: validate_questions(input.questions)?,
    })
}

#[derive(Deserialize)]
pub struct ListQuery {
    #[serde(default)]
    q: String,
    #[serde(default)]
    sort: String,
    #[serde(default)]
    page: u32,
}

const PAGE_SIZE: u32 = 24;

pub async fn list_public(State(state): State<Shared>, Query(query): Query<ListQuery>) -> ApiResult<Json<Value>> {
    let conn = state.db.lock().unwrap();
    let order = if query.sort == "popular" { "q.plays DESC, q.updated_at DESC" } else { "q.updated_at DESC" };
    let pattern = format!("%{}%", query.q.trim().replace('%', "").replace('_', ""));
    let offset = query.page * PAGE_SIZE;
    let quizzes = list_where(
        &conn,
        &format!(
            "WHERE q.status = 'approved' AND q.listed = 1 AND (q.title LIKE ?1 OR q.description LIKE ?1 OR u.username LIKE ?1 OR u.display_name LIKE ?1) \
             ORDER BY {order} LIMIT {} OFFSET {offset}",
            PAGE_SIZE + 1
        ),
        &[&pattern],
    )?;
    let has_more = quizzes.len() > PAGE_SIZE as usize;
    let quizzes: Vec<_> = quizzes.into_iter().take(PAGE_SIZE as usize).collect();
    Ok(Json(json!({ "quizzes": quizzes, "has_more": has_more })))
}

pub async fn list_mine(State(state): State<Shared>, AuthUser(user): AuthUser) -> ApiResult<Json<Value>> {
    let conn = state.db.lock().unwrap();
    let quizzes = list_where(&conn, "WHERE q.owner_id = ?1 ORDER BY q.updated_at DESC", &[&user.id])?;
    Ok(Json(json!({ "quizzes": quizzes })))
}

pub async fn get(
    State(state): State<Shared>,
    MaybeUser(user): MaybeUser,
    Path(id): Path<String>,
) -> ApiResult<Json<Value>> {
    let conn = state.db.lock().unwrap();
    let quiz = load(&conn, &id)?;
    if !quiz.can_use(user.as_ref()) {
        return Err(ApiError::not_found("Quiz"));
    }
    Ok(Json(quiz.full_json(user.as_ref())))
}

pub async fn create(
    State(state): State<Shared>,
    AuthUser(user): AuthUser,
    Json(input): Json<QuizInput>,
) -> ApiResult<Json<Value>> {
    let quiz = clean(input)?;
    let conn = state.db.lock().unwrap();
    let now = util::now_secs();
    let id = util::short_id(8);
    conn.execute(
        "INSERT INTO quizzes (id, owner_id, title, description, cover_url, questions, question_count, status, created_at, updated_at) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'private', ?8, ?8)",
        params![
            id,
            user.id,
            quiz.title,
            quiz.description,
            quiz.cover_url,
            serde_json::to_string(&quiz.questions)?,
            quiz.questions.len() as i64,
            now
        ],
    )?;
    Ok(Json(load(&conn, &id)?.full_json(Some(&user))))
}

pub async fn update(
    State(state): State<Shared>,
    AuthUser(user): AuthUser,
    Path(id): Path<String>,
    Json(input): Json<QuizInput>,
) -> ApiResult<Json<Value>> {
    let quiz = clean(input)?;
    let conn = state.db.lock().unwrap();
    let existing = load(&conn, &id)?;
    if !existing.can_edit(Some(&user)) {
        return Err(ApiError::forbidden());
    }
    // Any change to a public (or queued) quiz must be re-reviewed.
    let status = match existing.summary.status.as_str() {
        "approved" | "pending" => "pending",
        _ => "private",
    };
    // Editing a public quiz re-submits it for review, so it counts as a submission.
    if existing.summary.status == "approved" {
        guard_submission(&conn, &user, &id)?;
    }
    conn.execute(
        "UPDATE quizzes SET title = ?2, description = ?3, cover_url = ?4, questions = ?5, question_count = ?6, \
         status = ?7, updated_at = ?8, submitted_at = CASE WHEN ?7 = 'pending' THEN ?8 ELSE submitted_at END \
         WHERE id = ?1",
        params![
            id,
            quiz.title,
            quiz.description,
            quiz.cover_url,
            serde_json::to_string(&quiz.questions)?,
            quiz.questions.len() as i64,
            status,
            util::now_secs()
        ],
    )?;
    Ok(Json(load(&conn, &id)?.full_json(Some(&user))))
}

pub async fn delete(
    State(state): State<Shared>,
    AuthUser(user): AuthUser,
    Path(id): Path<String>,
) -> ApiResult<Json<Value>> {
    let conn = state.db.lock().unwrap();
    let quiz = load(&conn, &id)?;
    if !(quiz.can_edit(Some(&user)) || user.is_admin()) {
        return Err(ApiError::forbidden());
    }
    conn.execute("DELETE FROM quizzes WHERE id = ?1", [&id])?;
    Ok(Json(json!({ "ok": true })))
}

/// Owner sends a quiz to the moderation queue to be made public.
pub async fn submit(
    State(state): State<Shared>,
    AuthUser(user): AuthUser,
    Path(id): Path<String>,
) -> ApiResult<Json<Value>> {
    let conn = state.db.lock().unwrap();
    let quiz = load(&conn, &id)?;
    if !quiz.can_edit(Some(&user)) {
        return Err(ApiError::forbidden());
    }
    if !matches!(quiz.summary.status.as_str(), "private" | "rejected") {
        return Err(ApiError::bad("This quiz is already public or waiting for review"));
    }
    guard_submission(&conn, &user, &id)?;
    conn.execute(
        "UPDATE quizzes SET status = 'pending', submitted_at = ?2, mod_note = NULL WHERE id = ?1",
        params![id, util::now_secs()],
    )?;
    Ok(Json(load(&conn, &id)?.full_json(Some(&user))))
}

#[derive(Deserialize)]
pub struct Listing {
    listed: bool,
}

/// Owner shows or hides the quiz on Discover. Unlisted quizzes still work by link once approved,
/// so this doesn't need another review.
pub async fn set_listing(
    State(state): State<Shared>,
    AuthUser(user): AuthUser,
    Path(id): Path<String>,
    Json(body): Json<Listing>,
) -> ApiResult<Json<Value>> {
    let conn = state.db.lock().unwrap();
    let quiz = load(&conn, &id)?;
    if !quiz.can_edit(Some(&user)) {
        return Err(ApiError::forbidden());
    }
    conn.execute("UPDATE quizzes SET listed = ?2 WHERE id = ?1", params![id, body.listed])?;
    Ok(Json(load(&conn, &id)?.full_json(Some(&user))))
}

/// Owner pulls a quiz out of the public catalog (or the queue).
pub async fn unpublish(
    State(state): State<Shared>,
    AuthUser(user): AuthUser,
    Path(id): Path<String>,
) -> ApiResult<Json<Value>> {
    let conn = state.db.lock().unwrap();
    let quiz = load(&conn, &id)?;
    if !quiz.can_edit(Some(&user)) {
        return Err(ApiError::forbidden());
    }
    conn.execute("UPDATE quizzes SET status = 'private' WHERE id = ?1", [&id])?;
    Ok(Json(load(&conn, &id)?.full_json(Some(&user))))
}
