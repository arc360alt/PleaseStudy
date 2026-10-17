//! Hosted multiplayer games over WebSockets.
//!
//! Each game is an in-memory state machine:
//!   lobby → intro (question + countdown) → question (answering) → reveal (stats)
//!         → leaderboard → intro … → finished (podium)
//! Every state change pushes a fresh, role-specific snapshot to the host and each player.

use std::{
    collections::{HashMap, HashSet},
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};

use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        Path, State,
    },
    response::Response,
    Json,
};
use futures::{SinkExt, StreamExt};
use rand::seq::SliceRandom;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::sync::mpsc::{unbounded_channel, UnboundedSender};

use crate::{
    auth::{self, MaybeUser},
    error::{ApiError, ApiResult},
    models::{normalize_answer, score_answer, Grade, PartialCredit, Question, QuestionKind, Submission},
    quizzes, util, Shared,
};

type Tx = UnboundedSender<String>;
type GameRef = Arc<Mutex<Game>>;

const MAX_PLAYERS: usize = 250;
static NEXT_CONN: AtomicU64 = AtomicU64::new(1);

#[derive(Default)]
pub struct Registry {
    games: Mutex<HashMap<String, GameRef>>,
}

impl Registry {
    fn get(&self, pin: &str) -> Option<GameRef> {
        self.games.lock().unwrap().get(pin).cloned()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Settings {
    /// Show question text, image and answer text on players' devices too,
    /// instead of only on the host screen.
    #[serde(default)]
    pub show_question_on_devices: bool,
    /// Overrides every question's own time limit when set.
    #[serde(default)]
    pub time_limit: Option<u32>,
    /// Seconds the question is shown before answers open.
    #[serde(default = "default_read")]
    pub read_seconds: u32,
    #[serde(default)]
    pub shuffle_questions: bool,
    /// Shuffle the box order within each question, so repeat games aren't memorised by position.
    #[serde(default)]
    pub shuffle_answers: bool,
    #[serde(default = "default_true")]
    pub allow_late_join: bool,
    /// No countdown on answering: the round only ends when everyone has answered
    /// (or the host moves on).
    #[serde(default)]
    pub no_timer: bool,
    /// Half points for partly-right "pick several" answers.
    #[serde(default)]
    pub multi_partial: PartialCredit,
}

fn default_read() -> u32 {
    5
}
fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
enum Phase {
    Lobby,
    Intro,
    Question,
    Reveal,
    Leaderboard,
    Finished,
}

struct PlayerAnswer {
    sub: Submission,
    correct: bool,
    partial: bool,
    points: i64,
    time_ms: u64,
}

struct Player {
    id: String,
    name: String,
    rejoin_key: String,
    score: i64,
    streak: u32,
    /// Streak going into the current question, restored if the host skips it.
    streak_before: u32,
    answer: Option<PlayerAnswer>,
    tx: Option<Tx>,
    conn_id: u64,
}

pub struct Game {
    pin: String,
    host_key: String,
    title: String,
    questions: Vec<Question>,
    settings: Settings,
    phase: Phase,
    q_index: usize,
    /// Bumped on every transition so stale timers can tell they've been superseded.
    gen: u64,
    deadline: Option<Instant>,
    phase_total_ms: u64,
    opened_at: Instant,
    players: Vec<Player>,
    banned_keys: HashSet<String>,
    prev_ranks: HashMap<String, usize>,
    host_tx: Option<Tx>,
    host_conn: u64,
    last_activity: Instant,
}

impl Game {
    fn question(&self) -> &Question {
        &self.questions[self.q_index]
    }

    fn limit_ms(&self) -> u64 {
        self.settings.time_limit.unwrap_or(self.question().time_limit) as u64 * 1000
    }

    fn is_last(&self) -> bool {
        self.q_index + 1 >= self.questions.len()
    }

    fn set_phase(&mut self, phase: Phase, duration: Option<Duration>) {
        self.phase = phase;
        self.gen += 1;
        self.deadline = duration.map(|d| Instant::now() + d);
        self.phase_total_ms = duration.map_or(0, |d| d.as_millis() as u64);
        self.last_activity = Instant::now();
    }

    /// Ids sorted by score, best first.
    fn ranking(&self) -> Vec<usize> {
        let mut idx: Vec<usize> = (0..self.players.len()).collect();
        idx.sort_by(|&a, &b| {
            self.players[b]
                .score
                .cmp(&self.players[a].score)
                .then_with(|| self.players[a].name.to_lowercase().cmp(&self.players[b].name.to_lowercase()))
        });
        idx
    }

    fn begin_question(&mut self, index: usize) {
        self.prev_ranks = self
            .ranking()
            .into_iter()
            .enumerate()
            .map(|(rank, i)| (self.players[i].id.clone(), rank + 1))
            .collect();
        self.q_index = index;
        for p in &mut self.players {
            p.answer = None;
            p.streak_before = p.streak;
        }
        let read = Duration::from_secs(self.settings.read_seconds as u64);
        self.set_phase(Phase::Intro, Some(read));
    }

    fn open_answers(&mut self) {
        self.opened_at = Instant::now();
        let limit = (!self.settings.no_timer).then(|| Duration::from_millis(self.limit_ms()));
        self.set_phase(Phase::Question, limit);
    }

    fn reveal(&mut self) {
        for p in &mut self.players {
            if p.answer.is_none() {
                p.streak = 0;
            }
        }
        self.set_phase(Phase::Reveal, None);
    }

    fn finish(&mut self) {
        self.set_phase(Phase::Finished, None);
    }

    /// Host throws out the current question: nobody keeps points for it and play moves on.
    fn skip_question(&mut self) {
        if !matches!(self.phase, Phase::Intro | Phase::Question) {
            return;
        }
        for p in &mut self.players {
            if let Some(a) = p.answer.take() {
                p.score -= a.points;
            }
            p.streak = p.streak_before;
        }
        if self.is_last() {
            self.finish();
        } else {
            self.begin_question(self.q_index + 1);
        }
    }

    /// Reveal as soon as every player in the game has answered. Players whose connection
    /// dropped still count, so a locked phone doesn't cut the round short; the timer or the
    /// host covers anyone who never comes back.
    fn reveal_if_all_in(&mut self) {
        if self.phase == Phase::Question
            && !self.players.is_empty()
            && self.players.iter().all(|p| p.answer.is_some())
        {
            self.reveal();
        }
    }

    /// Host pressed "next" (also used to skip the countdown or end answering early).
    fn advance(&mut self) {
        match self.phase {
            Phase::Lobby if !self.players.is_empty() => self.begin_question(0),
            Phase::Lobby => {}
            Phase::Intro => self.open_answers(),
            Phase::Question => self.reveal(),
            Phase::Reveal if self.is_last() => self.finish(),
            Phase::Reveal => self.set_phase(Phase::Leaderboard, None),
            Phase::Leaderboard => self.begin_question(self.q_index + 1),
            Phase::Finished => {}
        }
    }

    fn timer_fired(&mut self) {
        match self.phase {
            Phase::Intro => self.open_answers(),
            Phase::Question => self.reveal(),
            _ => {}
        }
    }

    fn submit(&mut self, player_id: &str, sub: Submission) {
        if self.phase != Phase::Question {
            return;
        }
        let sub = self.question().clean_submission(sub);
        if sub.is_empty() {
            return;
        }
        let limit = self.limit_ms();
        let elapsed = (self.opened_at.elapsed().as_millis() as u64).min(limit);
        let grade = self.question().grade_with(&sub, self.settings.multi_partial);
        let correct = grade == Grade::Correct;
        let partial = grade == Grade::Partial;
        let Some(p) = self.players.iter_mut().find(|p| p.id == player_id) else { return };
        if p.answer.is_some() {
            return;
        }
        let points = if correct {
            p.streak += 1;
            score_answer(elapsed, limit, p.streak)
        } else if partial {
            p.streak = 0;
            score_answer(elapsed, limit, 0) / 2
        } else {
            p.streak = 0;
            0
        };
        p.score += points;
        p.answer = Some(PlayerAnswer { sub, correct, partial, points, time_ms: elapsed });
        self.last_activity = Instant::now();
        self.reveal_if_all_in();
    }

    fn time_left_ms(&self) -> Option<u64> {
        self.deadline.map(|d| d.saturating_duration_since(Instant::now()).as_millis() as u64)
    }

    fn shows_question(&self) -> bool {
        !matches!(self.phase, Phase::Lobby | Phase::Finished)
    }

    fn revealed(&self) -> bool {
        matches!(self.phase, Phase::Reveal | Phase::Leaderboard)
    }

    fn standings(&self, limit: usize) -> Vec<Value> {
        self.ranking()
            .into_iter()
            .take(limit)
            .enumerate()
            .map(|(r, i)| {
                let p = &self.players[i];
                json!({
                    "id": p.id,
                    "name": p.name,
                    "score": p.score,
                    "rank": r + 1,
                    "prev_rank": self.prev_ranks.get(&p.id),
                    "streak": p.streak,
                    "last_points": p.answer.as_ref().map_or(0, |a| a.points),
                })
            })
            .collect()
    }

    /// Most common typed answers for a text question, grouped ignoring case.
    fn typed_summary(&self) -> Vec<Value> {
        let mut groups: Vec<(String, String, usize, bool)> = Vec::new();
        for a in self.players.iter().filter_map(|p| p.answer.as_ref()) {
            let Some(t) = &a.sub.text else { continue };
            let key = normalize_answer(t);
            match groups.iter_mut().find(|g| g.0 == key) {
                Some(g) => g.2 += 1,
                None => groups.push((key, t.clone(), 1, a.correct)),
            }
        }
        groups.sort_by(|a, b| b.2.cmp(&a.2).then(b.3.cmp(&a.3)));
        groups
            .into_iter()
            .take(8)
            .map(|(_, text, count, correct)| json!({ "text": text, "count": count, "correct": correct }))
            .collect()
    }

    fn host_view(&self) -> String {
        let question = self.shows_question().then(|| {
            let q = self.question();
            let is_text = q.kind == QuestionKind::Text;
            json!({
                "kind": q.kind,
                "text": q.text,
                "image_url": q.image_url,
                // The host screen is public, so typed answers stay hidden until the reveal.
                "answers": if is_text { Vec::new() } else { q.answers.iter().map(|a| &a.text).collect::<Vec<_>>() },
                "answer_images": q.answer_images(),
                "correct": self.revealed().then(|| q.correct_indices()),
                "accepted": (is_text && self.revealed()).then(|| q.accepted()),
            })
        });
        let answered = self.players.iter().filter(|p| p.answer.is_some()).count();
        let waiting: Vec<Value> = if self.phase == Phase::Question {
            self.players
                .iter()
                .filter(|p| p.answer.is_none())
                .map(|p| json!({ "id": p.id, "name": p.name, "connected": p.tx.is_some() }))
                .collect()
        } else {
            Vec::new()
        };
        let (counts, correct_count) = if self.revealed() {
            let mut counts = vec![0usize; self.question().choice_count()];
            for a in self.players.iter().filter_map(|p| p.answer.as_ref()) {
                for c in a.sub.picked() {
                    if let Some(n) = counts.get_mut(c) {
                        *n += 1;
                    }
                }
            }
            let correct = self.players.iter().filter(|p| p.answer.as_ref().is_some_and(|a| a.correct)).count();
            (Some(counts), Some(correct))
        } else {
            (None, None)
        };
        json!({
            "type": "host_state",
            "pin": self.pin,
            "title": self.title,
            "phase": self.phase,
            "settings": self.settings,
            "q_index": self.q_index,
            "q_total": self.questions.len(),
            "question": question,
            "time_left_ms": self.time_left_ms(),
            "phase_total_ms": self.phase_total_ms,
            "answered": answered,
            "waiting": waiting,
            "counts": counts,
            "typed": (self.revealed() && self.question().kind == QuestionKind::Text).then(|| self.typed_summary()),
            "correct_count": correct_count,
            "partial_count": self.revealed().then(|| {
                self.players.iter().filter(|p| p.answer.as_ref().is_some_and(|a| a.partial)).count()
            }),
            "players": self.players.iter().map(|p| json!({
                "id": p.id, "name": p.name, "score": p.score, "connected": p.tx.is_some(),
            })).collect::<Vec<_>>(),
            "leaderboard": matches!(self.phase, Phase::Reveal | Phase::Leaderboard | Phase::Finished)
                .then(|| self.standings(10)),
        })
        .to_string()
    }

    fn player_view(&self, p: &Player) -> String {
        let ranking = self.ranking();
        let rank = ranking.iter().position(|&i| self.players[i].id == p.id).map(|r| r + 1);
        let full = self.settings.show_question_on_devices;
        let question = self.shows_question().then(|| {
            let q = self.question();
            let is_text = q.kind == QuestionKind::Text;
            json!({
                "kind": q.kind,
                "answer_count": q.choice_count(),
                "text": full.then_some(&q.text),
                "image_url": if full { q.image_url.as_ref() } else { None },
                "answers": (full && !is_text).then(|| q.answers.iter().map(|a| &a.text).collect::<Vec<_>>()),
                "answer_images": full.then(|| q.answer_images()),
                "correct": self.revealed().then(|| q.correct_indices()),
                "accepted": (is_text && self.revealed()).then(|| q.accepted()),
            })
        });
        // Player directly ahead, for the "X points behind Y" nudge.
        let ahead = rank.filter(|&r| r > 1).map(|r| {
            let other = &self.players[ranking[r - 2]];
            json!({ "name": other.name, "gap": other.score - p.score })
        });
        json!({
            "type": "player_state",
            "pin": self.pin,
            "title": self.title,
            "phase": self.phase,
            "me": { "id": p.id, "name": p.name, "score": p.score, "streak": p.streak, "rank": rank },
            "player_count": self.players.len(),
            "q_index": self.q_index,
            "q_total": self.questions.len(),
            "question": question,
            "time_left_ms": self.time_left_ms(),
            "phase_total_ms": self.phase_total_ms,
            "answered": p.answer.is_some(),
            "result": if self.revealed() || self.phase == Phase::Finished {
                p.answer.as_ref().map(|a| json!({
                    "choice": a.sub.choice, "choices": a.sub.choices, "typed": a.sub.text,
                    "correct": a.correct, "partial": a.partial, "points": a.points, "time_ms": a.time_ms,
                }))
            } else { None },
            "ahead": ahead,
            "podium": (self.phase == Phase::Finished).then(|| self.standings(3)),
        })
        .to_string()
    }

    fn broadcast(&self) {
        if let Some(tx) = &self.host_tx {
            let _ = tx.send(self.host_view());
        }
        for p in &self.players {
            if let Some(tx) = &p.tx {
                let _ = tx.send(self.player_view(p));
            }
        }
    }
}

/// Arm a timer for the current phase deadline; it no-ops if the game has moved on.
fn schedule(game: &GameRef) {
    let (deadline, gen) = {
        let g = game.lock().unwrap();
        match g.deadline {
            Some(d) => (d, g.gen),
            None => return,
        }
    };
    let game = game.clone();
    tokio::spawn(async move {
        tokio::time::sleep_until(tokio::time::Instant::from_std(deadline)).await;
        {
            let mut g = game.lock().unwrap();
            if g.gen != gen {
                return;
            }
            g.timer_fired();
            g.broadcast();
        }
        schedule(&game);
    });
}

// ---------------------------------------------------------------- HTTP

#[derive(Deserialize)]
pub struct CreateGame {
    quiz_id: String,
    #[serde(default)]
    settings: Option<Settings>,
}

pub async fn create(
    State(state): State<Shared>,
    MaybeUser(user): MaybeUser,
    Json(body): Json<CreateGame>,
) -> ApiResult<Json<Value>> {
    let quiz = {
        let conn = state.db.lock().unwrap();
        let quiz = quizzes::load(&conn, &body.quiz_id)?;
        if !quiz.can_use(user.as_ref()) {
            return Err(ApiError::not_found("Quiz"));
        }
        quizzes::bump_plays(&conn, &body.quiz_id);
        quiz
    };
    let mut settings = body.settings.unwrap_or(Settings {
        show_question_on_devices: false,
        time_limit: None,
        read_seconds: default_read(),
        shuffle_questions: false,
        shuffle_answers: false,
        allow_late_join: true,
        no_timer: false,
        multi_partial: PartialCredit::None,
    });
    settings.read_seconds = settings.read_seconds.clamp(2, 15);
    settings.time_limit = settings.time_limit.map(|t| t.clamp(crate::models::MIN_TIME, crate::models::MAX_TIME));

    let mut questions = quiz.questions;
    let mut rng = rand::thread_rng();
    if settings.shuffle_questions {
        questions.shuffle(&mut rng);
    }
    // Shuffled once per game so the host screen and every player see the same layout.
    if settings.shuffle_answers {
        for q in questions.iter_mut().filter(|q| q.kind != QuestionKind::Text) {
            q.answers.shuffle(&mut rng);
        }
    }

    let mut games = state.games.games.lock().unwrap();
    let pin = loop {
        let pin = util::pin();
        if !games.contains_key(&pin) {
            break pin;
        }
    };
    let host_key = util::token(32);
    let game = Game {
        pin: pin.clone(),
        host_key: host_key.clone(),
        title: quiz.summary.title,
        questions,
        settings,
        phase: Phase::Lobby,
        q_index: 0,
        gen: 0,
        deadline: None,
        phase_total_ms: 0,
        opened_at: Instant::now(),
        players: Vec::new(),
        banned_keys: HashSet::new(),
        prev_ranks: HashMap::new(),
        host_tx: None,
        host_conn: 0,
        last_activity: Instant::now(),
    };
    games.insert(pin.clone(), Arc::new(Mutex::new(game)));
    Ok(Json(json!({ "pin": pin, "host_key": host_key })))
}

pub async fn info(State(state): State<Shared>, Path(pin): Path<String>) -> ApiResult<Json<Value>> {
    let game = state.games.get(&pin).ok_or_else(|| ApiError::not_found("Game"))?;
    let g = game.lock().unwrap();
    let joinable = g.phase == Phase::Lobby || (g.settings.allow_late_join && g.phase != Phase::Finished);
    Ok(Json(json!({ "pin": g.pin, "title": g.title, "phase": g.phase, "joinable": joinable })))
}

/// Drop games that have gone quiet.
pub fn spawn_reaper(state: Shared) {
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(Duration::from_secs(60));
        loop {
            tick.tick().await;
            let mut games = state.games.games.lock().unwrap();
            games.retain(|_, game| {
                let g = game.lock().unwrap();
                let idle = g.last_activity.elapsed();
                let nobody_here = g.host_tx.is_none() && g.players.iter().all(|p| p.tx.is_none());
                !(idle > Duration::from_secs(3 * 3600)
                    || (g.phase == Phase::Finished && idle > Duration::from_secs(30 * 60))
                    || (nobody_here && idle > Duration::from_secs(15 * 60)))
            });
        }
    });
}

// ---------------------------------------------------------------- WebSocket

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum ClientMsg {
    Host { pin: String, host_key: String },
    Join {
        pin: String,
        #[serde(default)]
        name: String,
        #[serde(default)]
        token: Option<String>,
        #[serde(default)]
        rejoin_key: Option<String>,
    },
    Answer {
        #[serde(default)]
        choice: Option<usize>,
        #[serde(default)]
        choices: Option<Vec<usize>>,
        #[serde(default)]
        text: Option<String>,
    },
    Next,
    SkipQuestion,
    Kick { player_id: String },
    End,
    Ping,
}

enum Role {
    Host(GameRef),
    Player(GameRef, String),
}

pub async fn ws_handler(ws: WebSocketUpgrade, State(state): State<Shared>) -> Response {
    ws.on_upgrade(move |socket| handle_socket(socket, state))
}

fn send_error(tx: &Tx, message: &str) {
    let _ = tx.send(json!({ "type": "error", "message": message }).to_string());
}

async fn handle_socket(socket: WebSocket, state: Shared) {
    let (mut sink, mut stream) = socket.split();
    let (tx, mut rx) = unbounded_channel::<String>();
    let writer = tokio::spawn(async move {
        while let Some(msg) = rx.recv().await {
            let close = msg.contains("\"type\":\"kicked\"");
            if sink.send(Message::Text(msg)).await.is_err() || close {
                break;
            }
        }
        let _ = sink.close().await;
    });
    let conn_id = NEXT_CONN.fetch_add(1, Ordering::Relaxed);
    let mut role: Option<Role> = None;

    while let Some(Ok(msg)) = stream.next().await {
        let text = match msg {
            Message::Text(t) => t,
            Message::Close(_) => break,
            _ => continue,
        };
        let Ok(msg) = serde_json::from_str::<ClientMsg>(&text) else {
            send_error(&tx, "Unrecognised message");
            continue;
        };
        match (msg, &role) {
            (ClientMsg::Ping, _) => {
                let _ = tx.send(r#"{"type":"pong"}"#.into());
            }

            (ClientMsg::Host { pin, host_key }, None) => {
                let Some(game) = state.games.get(&pin) else {
                    send_error(&tx, "That game doesn't exist anymore");
                    continue;
                };
                {
                    let mut g = game.lock().unwrap();
                    if g.host_key != host_key {
                        send_error(&tx, "You're not the host of this game");
                        continue;
                    }
                    g.host_tx = Some(tx.clone());
                    g.host_conn = conn_id;
                    g.last_activity = Instant::now();
                    let _ = tx.send(g.host_view());
                }
                role = Some(Role::Host(game));
            }

            (ClientMsg::Join { pin, name, token, rejoin_key }, None) => {
                let Some(game) = state.games.get(pin.trim()) else {
                    send_error(&tx, "No game with that PIN");
                    continue;
                };
                let account_name = token.and_then(|t| {
                    let conn = state.db.lock().unwrap();
                    auth::user_from_token(&conn, &t).ok().flatten().map(|u| u.name())
                });
                let joined = {
                    let mut g = game.lock().unwrap();
                    join(&mut g, &tx, conn_id, name, account_name, rejoin_key)
                };
                match joined {
                    Ok(player_id) => {
                        game.lock().unwrap().broadcast();
                        role = Some(Role::Player(game, player_id));
                    }
                    Err(e) => send_error(&tx, &e),
                }
            }

            (ClientMsg::Answer { choice, choices, text }, Some(Role::Player(game, pid))) => {
                let mut g = game.lock().unwrap();
                let before = g.gen;
                g.submit(pid, Submission { choice, choices, text });
                if g.gen != before {
                    // Everyone answered: the reveal already happened inside submit.
                    g.broadcast();
                } else {
                    if let Some(p) = g.players.iter().find(|p| &p.id == pid) {
                        let _ = tx.send(g.player_view(p));
                    }
                    if let Some(h) = &g.host_tx {
                        let _ = h.send(g.host_view());
                    }
                }
            }

            (ClientMsg::Next, Some(Role::Host(game))) => {
                {
                    let mut g = game.lock().unwrap();
                    g.advance();
                    g.broadcast();
                }
                schedule(game);
            }

            (ClientMsg::SkipQuestion, Some(Role::Host(game))) => {
                {
                    let mut g = game.lock().unwrap();
                    g.skip_question();
                    g.broadcast();
                }
                schedule(game);
            }

            (ClientMsg::Kick { player_id }, Some(Role::Host(game))) => {
                let mut g = game.lock().unwrap();
                if let Some(pos) = g.players.iter().position(|p| p.id == player_id) {
                    let p = g.players.remove(pos);
                    g.banned_keys.insert(p.rejoin_key);
                    if let Some(ptx) = p.tx {
                        let _ = ptx.send(json!({ "type": "kicked" }).to_string());
                    }
                    // The kicked player may have been the last one we were waiting on.
                    g.reveal_if_all_in();
                    g.broadcast();
                }
            }

            (ClientMsg::End, Some(Role::Host(game))) => {
                let mut g = game.lock().unwrap();
                if g.phase != Phase::Finished {
                    g.finish();
                    g.broadcast();
                }
            }

            _ => send_error(&tx, "That action isn't allowed right now"),
        }
    }

    // Disconnected: detach this socket, but keep the seat so they can rejoin.
    match role {
        Some(Role::Host(game)) => {
            let mut g = game.lock().unwrap();
            if g.host_conn == conn_id {
                g.host_tx = None;
            }
        }
        Some(Role::Player(game, pid)) => {
            let mut g = game.lock().unwrap();
            if let Some(p) = g.players.iter_mut().find(|p| p.id == pid && p.conn_id == conn_id) {
                p.tx = None;
            }
            g.broadcast();
        }
        None => {}
    }
    writer.abort();
}

fn join(
    g: &mut Game,
    tx: &Tx,
    conn_id: u64,
    name: String,
    account_name: Option<String>,
    rejoin_key: Option<String>,
) -> Result<String, String> {
    if let Some(key) = rejoin_key.filter(|k| !k.is_empty()) {
        if g.banned_keys.contains(&key) {
            return Err("You were removed from this game".into());
        }
        if let Some(p) = g.players.iter_mut().find(|p| p.rejoin_key == key) {
            p.tx = Some(tx.clone());
            p.conn_id = conn_id;
            let _ = tx.send(
                json!({ "type": "joined", "player_id": p.id, "name": p.name, "rejoin_key": p.rejoin_key })
                    .to_string(),
            );
            return Ok(p.id.clone());
        }
    }
    if g.phase == Phase::Finished || (g.phase != Phase::Lobby && !g.settings.allow_late_join) {
        return Err("This game has already started".into());
    }
    if g.players.len() >= MAX_PLAYERS {
        return Err("This game is full".into());
    }
    // Typed nicknames are capped at 20; account display names can be up to 32.
    let limit = if account_name.is_some() { 32 } else { 20 };
    let name: String = account_name
        .unwrap_or(name)
        .trim()
        .chars()
        .filter(|c| !c.is_control())
        .take(limit)
        .collect();
    if name.is_empty() {
        return Err("Pick a nickname".into());
    }
    if g.players.iter().any(|p| p.name.eq_ignore_ascii_case(&name)) {
        return Err("Someone already has that nickname".into());
    }
    let player = Player {
        id: util::token(10),
        name,
        rejoin_key: util::token(24),
        score: 0,
        streak: 0,
        streak_before: 0,
        answer: None,
        tx: Some(tx.clone()),
        conn_id,
    };
    let _ = tx.send(
        json!({ "type": "joined", "player_id": player.id, "name": player.name, "rejoin_key": player.rejoin_key })
            .to_string(),
    );
    let id = player.id.clone();
    g.players.push(player);
    g.last_activity = Instant::now();
    Ok(id)
}
