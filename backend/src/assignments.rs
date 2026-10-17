use axum::{
    extract::{Path, State},
    Json,
};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::{
    attempts::{first_tries, Response},
    auth::AuthUser,
    error::{ApiError, ApiResult},
    models::{Question, StudySettings},
    quizzes, util, Shared,
};

#[derive(Debug, Clone, Serialize)]
pub struct Assignment {
    pub code: String,
    pub quiz_id: String,
    pub owner_id: i64,
    pub owner: String,
    pub owner_name: String,
    pub title: String,
    pub quiz_title: String,
    pub question_count: i64,
    pub due_at: Option<i64>,
    pub require_account: bool,
    pub open: bool,
    pub created_at: i64,
    pub settings: StudySettings,
}

impl Assignment {
    pub fn accepting(&self) -> bool {
        self.open && self.due_at.map_or(true, |d| d > util::now_secs())
    }
}

const SELECT: &str = "SELECT a.code, a.quiz_id, a.owner_id, u.username, a.title, a.quiz_title, a.question_count, \
     a.due_at, a.require_account, a.open, a.created_at, a.settings, COALESCE(u.display_name, u.username) FROM assignments a JOIN users u ON u.id = a.owner_id";

fn from_row(r: &rusqlite::Row) -> rusqlite::Result<Assignment> {
    Ok(Assignment {
        code: r.get(0)?,
        quiz_id: r.get(1)?,
        owner_id: r.get(2)?,
        owner: r.get(3)?,
        title: r.get(4)?,
        quiz_title: r.get(5)?,
        question_count: r.get(6)?,
        due_at: r.get(7)?,
        require_account: r.get(8)?,
        open: r.get(9)?,
        created_at: r.get(10)?,
        settings: serde_json::from_str(&r.get::<_, String>(11)?).unwrap_or_default(),
        owner_name: r.get(12)?,
    })
}

pub fn load(conn: &Connection, code: &str) -> ApiResult<Assignment> {
    conn.query_row(&format!("{SELECT} WHERE a.code = ?1"), [code], from_row)
        .optional()?
        .ok_or_else(|| ApiError::not_found("Assignment"))
}

pub fn load_questions(conn: &Connection, code: &str) -> ApiResult<Vec<Question>> {
    let raw: String = conn.query_row("SELECT questions FROM assignments WHERE code = ?1", [code], |r| r.get(0))?;
    Ok(serde_json::from_str(&raw)?)
}

#[derive(Deserialize)]
pub struct NewAssignment {
    quiz_id: String,
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    due_at: Option<i64>,
    #[serde(default)]
    require_account: bool,
    #[serde(default)]
    settings: StudySettings,
}

pub async fn create(
    State(state): State<Shared>,
    AuthUser(user): AuthUser,
    Json(body): Json<NewAssignment>,
) -> ApiResult<Json<Value>> {
    let conn = state.db.lock().unwrap();
    let quiz = quizzes::load(&conn, &body.quiz_id)?;
    if !quiz.can_use(Some(&user)) {
        return Err(ApiError::not_found("Quiz"));
    }
    let title = body
        .title
        .map(|t| t.trim().chars().take(120).collect::<String>())
        .filter(|t| !t.is_empty())
        .unwrap_or_else(|| quiz.summary.title.clone());
    if let Some(due) = body.due_at {
        if due <= util::now_secs() {
            return Err(ApiError::bad("The due date has to be in the future"));
        }
    }
    let code = util::short_id(7);
    conn.execute(
        "INSERT INTO assignments (code, quiz_id, owner_id, title, quiz_title, questions, question_count, due_at, require_account, created_at, settings) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
        params![
            code,
            quiz.summary.id,
            user.id,
            title,
            quiz.summary.title,
            serde_json::to_string(&quiz.questions)?,
            quiz.questions.len() as i64,
            body.due_at,
            body.require_account,
            util::now_secs(),
            serde_json::to_string(&body.settings)?
        ],
    )?;
    Ok(Json(json!(load(&conn, &code)?)))
}

pub async fn list_mine(State(state): State<Shared>, AuthUser(user): AuthUser) -> ApiResult<Json<Value>> {
    let conn = state.db.lock().unwrap();
    let mut stmt = conn.prepare(&format!(
        "{SELECT} WHERE a.owner_id = ?1 ORDER BY a.created_at DESC"
    ))?;
    let list = stmt.query_map([user.id], from_row)?.collect::<Result<Vec<_>, _>>()?;
    let list = list
        .into_iter()
        .map(|a| {
            let done: i64 = conn.query_row(
                "SELECT COUNT(*) FROM attempts WHERE assignment_code = ?1 AND finished_at IS NOT NULL",
                [&a.code],
                |r| r.get(0),
            )?;
            let mut v = json!(a);
            v["accepting"] = json!(a.accepting());
            v["submissions"] = json!(done);
            Ok(v)
        })
        .collect::<ApiResult<Vec<_>>>()?;
    Ok(Json(json!({ "assignments": list })))
}

pub async fn get(State(state): State<Shared>, Path(code): Path<String>) -> ApiResult<Json<Value>> {
    let conn = state.db.lock().unwrap();
    let a = load(&conn, &code)?;
    let mut v = json!(a);
    v["accepting"] = json!(a.accepting());
    Ok(Json(v))
}

pub async fn toggle(
    State(state): State<Shared>,
    AuthUser(user): AuthUser,
    Path(code): Path<String>,
) -> ApiResult<Json<Value>> {
    let conn = state.db.lock().unwrap();
    let a = load(&conn, &code)?;
    if a.owner_id != user.id {
        return Err(ApiError::forbidden());
    }
    conn.execute("UPDATE assignments SET open = NOT open WHERE code = ?1", [&code])?;
    let a = load(&conn, &code)?;
    let mut v = json!(a);
    v["accepting"] = json!(a.accepting());
    Ok(Json(v))
}

pub async fn delete(
    State(state): State<Shared>,
    AuthUser(user): AuthUser,
    Path(code): Path<String>,
) -> ApiResult<Json<Value>> {
    let conn = state.db.lock().unwrap();
    let a = load(&conn, &code)?;
    if a.owner_id != user.id && !user.is_admin() {
        return Err(ApiError::forbidden());
    }
    conn.execute("DELETE FROM attempts WHERE assignment_code = ?1", [&code])?;
    conn.execute("DELETE FROM assignments WHERE code = ?1", [&code])?;
    crate::media::gc(&state.images_dir, &conn, &a.quiz_id); // pictures only this assignment still used
    Ok(Json(json!({ "ok": true })))
}

pub async fn results(
    State(state): State<Shared>,
    AuthUser(user): AuthUser,
    Path(code): Path<String>,
) -> ApiResult<Json<Value>> {
    let conn = state.db.lock().unwrap();
    let a = load(&conn, &code)?;
    if a.owner_id != user.id && !user.is_admin() {
        return Err(ApiError::forbidden());
    }
    let questions = load_questions(&conn, &code)?;

    let mut stmt = conn.prepare(
        "SELECT t.name, u.username, t.score, t.correct_count, t.responses, t.started_at, t.finished_at \
         FROM attempts t LEFT JOIN users u ON u.id = t.user_id \
         WHERE t.assignment_code = ?1 ORDER BY t.finished_at IS NULL, t.score DESC",
    )?;
    let rows = stmt
        .query_map([&code], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, Option<String>>(1)?,
                r.get::<_, i64>(2)?,
                r.get::<_, i64>(3)?,
                r.get::<_, String>(4)?,
                r.get::<_, i64>(5)?,
                r.get::<_, Option<i64>>(6)?,
            ))
        })?
        .collect::<Result<Vec<_>, _>>()?;

    let mut answered = vec![0i64; questions.len()];
    let mut correct = vec![0i64; questions.len()];
    let mut attempts = Vec::new();
    for (name, username, score, correct_count, responses, started_at, finished_at) in rows {
        let responses: Vec<Response> = serde_json::from_str(&responses)?;
        // Grades use first tries only; repeats from "repeat wrong answers" are practice.
        let firsts = first_tries(&responses);
        if finished_at.is_some() {
            for (i, r) in firsts.iter().filter(|(i, _)| *i < questions.len()) {
                answered[*i] += 1;
                if r.correct {
                    correct[*i] += 1;
                }
            }
        }
        attempts.push(json!({
            "name": name,
            "username": username,
            "score": score,
            "correct": correct_count,
            "answered": firsts.len(),
            "started_at": started_at,
            "finished_at": finished_at,
        }));
    }
    let question_stats: Vec<Value> = questions
        .iter()
        .enumerate()
        .map(|(i, q)| json!({ "text": q.text, "answered": answered[i], "correct": correct[i] }))
        .collect();

    let mut assignment = json!(a);
    assignment["accepting"] = json!(a.accepting());
    Ok(Json(json!({ "assignment": assignment, "attempts": attempts, "questions": question_stats })))
}
