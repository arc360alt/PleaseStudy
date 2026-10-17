//! Solo runs: playing a quiz alone, or completing an assignment.
//! Questions are served one at a time and graded here so answers never reach the client early.
//!
//! A run keeps a queue of question indices. With "repeat wrong answers" on, a missed question
//! goes back on the end of the queue; only the first try at each question counts for the grade.

use axum::{
    extract::{Path, State},
    Json,
};
use rand::seq::SliceRandom;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::{
    assignments,
    auth::MaybeUser,
    error::{ApiError, ApiResult},
    models::{score_answer, Grade, Question, StudySettings, Submission},
    quizzes, util, Shared,
};

/// How long the question is shown on its own before the answer boxes appear.
pub const READ_MS: i64 = 4000;
/// Network slack on top of the visible timer.
const GRACE_MS: i64 = 1500;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Response {
    /// Question index. Missing on rows saved before repeats existed, where position == question.
    #[serde(default)]
    pub q: Option<usize>,
    pub choice: Option<usize>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub choices: Option<Vec<usize>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    pub correct: bool,
    /// Half credit on a pick-several question.
    #[serde(default)]
    pub partial: bool,
    pub points: i64,
    pub time_ms: i64,
    #[serde(default)]
    pub retry: bool,
}

/// First-try responses paired with their question index.
pub fn first_tries(responses: &[Response]) -> Vec<(usize, &Response)> {
    responses
        .iter()
        .enumerate()
        .filter(|(_, r)| !r.retry)
        .map(|(i, r)| (r.q.unwrap_or(i), r))
        .collect()
}

struct Attempt {
    id: String,
    name: String,
    title: String,
    assignment_code: Option<String>,
    settings: StudySettings,
    questions: Vec<Question>,
    responses: Vec<Response>,
    queue: Vec<usize>,
    /// Question index currently on screen and awaiting an answer, or -1.
    current: i64,
    served_at: Option<i64>,
    score: i64,
    streak: i64,
    correct_count: i64,
    finished_at: Option<i64>,
}

fn load(conn: &Connection, id: &str) -> ApiResult<Attempt> {
    let row = conn
        .query_row(
            "SELECT id, name, title, assignment_code, questions, responses, current, served_at, score, streak, \
             correct_count, finished_at, settings, queue FROM attempts WHERE id = ?1",
            [id],
            |r| {
                Ok((
                    (r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?, r.get::<_, Option<String>>(3)?),
                    (r.get::<_, String>(4)?, r.get::<_, String>(5)?),
                    (r.get::<_, i64>(6)?, r.get::<_, Option<i64>>(7)?),
                    (r.get::<_, i64>(8)?, r.get::<_, i64>(9)?, r.get::<_, i64>(10)?, r.get::<_, Option<i64>>(11)?),
                    (r.get::<_, String>(12)?, r.get::<_, Option<String>>(13)?),
                ))
            },
        )
        .optional()?;
    let Some((
        (id, name, title, assignment_code),
        (questions, responses),
        (mut current, served_at),
        (score, streak, correct_count, finished_at),
        (settings, queue),
    )) = row
    else {
        return Err(ApiError::not_found("Game"));
    };
    let questions: Vec<Question> = serde_json::from_str(&questions)?;
    let responses: Vec<Response> = serde_json::from_str(&responses)?;
    let queue = match queue {
        Some(q) => serde_json::from_str(&q)?,
        None => {
            // Pre-queue row: resume from the first unanswered question.
            current = -1;
            (responses.len()..questions.len()).collect()
        }
    };
    Ok(Attempt {
        id,
        name,
        title,
        assignment_code,
        settings: serde_json::from_str(&settings).unwrap_or_default(),
        questions,
        responses,
        queue,
        current,
        served_at,
        score,
        streak,
        correct_count,
        finished_at,
    })
}

impl Attempt {
    fn save(&self, conn: &Connection) -> ApiResult<()> {
        conn.execute(
            "UPDATE attempts SET responses = ?2, current = ?3, served_at = ?4, score = ?5, streak = ?6, \
             correct_count = ?7, finished_at = ?8, queue = ?9 WHERE id = ?1",
            params![
                self.id,
                serde_json::to_string(&self.responses)?,
                self.current,
                self.served_at,
                self.score,
                self.streak,
                self.correct_count,
                self.finished_at,
                serde_json::to_string(&self.queue)?
            ],
        )?;
        Ok(())
    }

    fn read_ms(&self) -> i64 {
        if self.settings.read_countdown {
            READ_MS
        } else {
            0
        }
    }

    fn summary(&self) -> Value {
        let finished = self.finished_at.is_some();
        let firsts = first_tries(&self.responses);
        // The full answer key is only revealed once the run is over.
        let review: Value = if finished {
            json!(firsts
                .iter()
                .filter_map(|(i, r)| self.questions.get(*i).map(|q| (*i, q, r)))
                .map(|(i, q, r)| {
                    let tries: Vec<&Response> =
                        self.responses.iter().filter(|x| x.q == Some(i)).collect();
                    json!({
                        "kind": q.kind,
                        "text": q.text,
                        "image_url": q.image_url,
                        "answers": q.answers,
                        "choice": r.choice,
                        "choices": r.choices,
                        "typed": r.text,
                        "correct": r.correct,
                        "partial": r.partial,
                        "points": r.points,
                        "time_ms": r.time_ms,
                        "tries": tries.len().max(1),
                        "mastered": r.correct || tries.iter().any(|x| x.correct),
                    })
                })
                .collect::<Vec<_>>())
        } else {
            Value::Null
        };
        json!({
            "id": self.id,
            "name": self.name,
            "title": self.title,
            "assignment_code": self.assignment_code,
            "settings": self.settings,
            "total": self.questions.len(),
            "answered": firsts.len(),
            "score": self.score,
            "correct": self.correct_count,
            "finished": finished,
            "review": review,
        })
    }
}

#[derive(Deserialize)]
pub struct StartAttempt {
    #[serde(default)]
    quiz_id: Option<String>,
    #[serde(default)]
    assignment: Option<String>,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    settings: Option<StudySettings>,
}

pub async fn start(
    State(state): State<Shared>,
    MaybeUser(user): MaybeUser,
    Json(body): Json<StartAttempt>,
) -> ApiResult<Json<Value>> {
    let conn = state.db.lock().unwrap();
    let typed_name = body.name.map(|n| n.trim().chars().take(30).collect::<String>()).filter(|n| !n.is_empty());

    let (quiz_id, assignment_code, title, mut questions, name, settings) = if let Some(code) = body.assignment {
        let a = assignments::load(&conn, &code)?;
        if !a.accepting() {
            return Err(ApiError::bad("This assignment is closed"));
        }
        if a.require_account {
            let Some(u) = &user else {
                return Err(ApiError::bad("Log in to take this assignment"));
            };
            let done: bool = conn.query_row(
                "SELECT EXISTS(SELECT 1 FROM attempts WHERE assignment_code = ?1 AND user_id = ?2 AND finished_at IS NOT NULL)",
                params![code, u.id],
                |r| r.get(0),
            )?;
            if done {
                return Err(ApiError::bad("You've already completed this assignment"));
            }
        }
        let name = match (&user, typed_name) {
            (_, Some(n)) if !a.require_account => n,
            (Some(u), _) => u.name(),
            (None, _) => return Err(ApiError::bad("Enter your name so your teacher knows who you are")),
        };
        let questions = assignments::load_questions(&conn, &code)?;
        quizzes::bump_plays(&conn, &a.quiz_id);
        // The assigner picks the settings; students can't change them.
        (Some(a.quiz_id), Some(code), a.title, questions, name, a.settings)
    } else if let Some(quiz_id) = body.quiz_id {
        let quiz = quizzes::load(&conn, &quiz_id)?;
        if !quiz.can_use(user.as_ref()) {
            return Err(ApiError::not_found("Quiz"));
        }
        quizzes::bump_plays(&conn, &quiz_id);
        let name = user.as_ref().map(|u| u.name()).or(typed_name).unwrap_or_else(|| "Player".into());
        (Some(quiz_id), None, quiz.summary.title, quiz.questions, name, body.settings.unwrap_or_default())
    } else {
        return Err(ApiError::bad("Pick a quiz or an assignment"));
    };

    let mut rng = rand::thread_rng();
    if settings.shuffle_answers {
        for q in &mut questions {
            q.answers.shuffle(&mut rng);
        }
    }
    let mut queue: Vec<usize> = (0..questions.len()).collect();
    if settings.shuffle_questions {
        queue.shuffle(&mut rng);
    }

    let id = util::token(24);
    conn.execute(
        "INSERT INTO attempts (id, quiz_id, assignment_code, user_id, name, title, questions, started_at, settings, queue) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
        params![
            id,
            quiz_id,
            assignment_code,
            user.map(|u| u.id),
            name,
            title,
            serde_json::to_string(&questions)?,
            util::now_secs(),
            serde_json::to_string(&settings)?,
            serde_json::to_string(&queue)?
        ],
    )?;
    Ok(Json(load(&conn, &id)?.summary()))
}

/// Serve the question currently awaiting an answer, or pull the next one off the queue.
pub async fn next(State(state): State<Shared>, Path(id): Path<String>) -> ApiResult<Json<Value>> {
    let conn = state.db.lock().unwrap();
    let mut a = load(&conn, &id)?;
    if a.finished_at.is_some() {
        return Ok(Json(json!({ "done": true, "summary": a.summary() })));
    }
    let now = util::now_ms();
    if a.current < 0 {
        if a.queue.is_empty() {
            a.finished_at = Some(util::now_secs());
            a.save(&conn)?;
            return Ok(Json(json!({ "done": true, "summary": a.summary() })));
        }
        a.current = a.queue.remove(0) as i64;
        a.served_at = Some(now);
        a.save(&conn)?;
    }
    // On a refresh mid-question the clock keeps running from when it was first served.
    let qi = a.current as usize;
    let q = &a.questions[qi];
    let since = now - a.served_at.unwrap_or(now);
    let read = a.read_ms();
    let read_left = (read - since).max(0);
    let time_left = a.settings.timer.then(|| (q.time_limit as i64 * 1000 - (since - read).max(0)).max(0));
    let is_retry = a.responses.iter().any(|r| r.q == Some(qi));
    let first_tried = first_tries(&a.responses).len();
    Ok(Json(json!({
        "done": false,
        "serial": a.responses.len(),
        "position": if is_retry { first_tried } else { first_tried + 1 },
        "total": a.questions.len(),
        "remaining": a.queue.len(),
        "is_retry": is_retry,
        "score": a.score,
        "streak": a.streak,
        "question": q.public(),
        "read_ms": read_left,
        "read_total_ms": read,
        "time_ms": time_left,
    })))
}

pub async fn answer(
    State(state): State<Shared>,
    Path(id): Path<String>,
    Json(body): Json<Submission>,
) -> ApiResult<Json<Value>> {
    let conn = state.db.lock().unwrap();
    let mut a = load(&conn, &id)?;
    if a.finished_at.is_some() || a.current < 0 {
        return Err(ApiError::bad("No question is waiting for an answer"));
    }
    let qi = a.current as usize;
    let q = a.questions[qi].clone();
    let timed = a.settings.timer;
    let limit_ms = q.time_limit as i64 * 1000;
    let elapsed = (util::now_ms() - a.served_at.unwrap_or(0) - a.read_ms()).max(0);
    let in_time = !timed || elapsed <= limit_ms + GRACE_MS;
    let sub = q.clean_submission(body);
    let grade = if in_time { q.grade_with(&sub, a.settings.multi_partial) } else { Grade::Wrong };
    let correct = grade == Grade::Correct;
    let partial = grade == Grade::Partial;
    let retry = a.responses.iter().any(|r| r.q == Some(qi));

    // Only first tries score; repeats are practice.
    let points = match (retry, correct) {
        (true, _) => 0,
        (false, true) => {
            a.streak += 1;
            a.correct_count += 1;
            // Untimed runs score every correct answer as if it were instant.
            let elapsed_for_score = if timed { elapsed.min(limit_ms) } else { 0 };
            score_answer(elapsed_for_score as u64, limit_ms as u64, a.streak as u32)
        }
        (false, false) if partial => {
            a.streak = 0;
            let elapsed_for_score = if timed { elapsed.min(limit_ms) } else { 0 };
            score_answer(elapsed_for_score as u64, limit_ms as u64, 0) / 2
        }
        (false, false) => {
            a.streak = 0;
            0
        }
    };
    a.score += points;
    a.responses.push(Response {
        q: Some(qi),
        choice: sub.choice,
        choices: sub.choices.clone(),
        text: sub.text.clone(),
        correct,
        partial: partial && !retry,
        points,
        time_ms: if timed { elapsed.min(limit_ms) } else { elapsed },
        retry,
    });
    let requeued = a.settings.repeat_wrong && !correct;
    if requeued {
        a.queue.push(qi);
    }
    a.current = -1;
    let is_last = a.queue.is_empty();
    if is_last {
        a.finished_at = Some(util::now_secs());
    }
    a.save(&conn)?;
    Ok(Json(json!({
        "correct": correct,
        "partial": partial,
        "kind": q.kind,
        "correct_indices": q.correct_indices(),
        "accepted": (q.kind == crate::models::QuestionKind::Text).then(|| q.accepted()),
        "choice": sub.choice,
        "choices": sub.choices,
        "typed": sub.text,
        "answered": !sub.is_empty(),
        "points": points,
        "score": a.score,
        "streak": a.streak,
        "is_last": is_last,
        "is_retry": retry,
        "requeued": requeued,
        "remaining": a.queue.len(),
    })))
}

pub async fn get(State(state): State<Shared>, Path(id): Path<String>) -> ApiResult<Json<Value>> {
    let conn = state.db.lock().unwrap();
    Ok(Json(load(&conn, &id)?.summary()))
}
