//! Images stored on our server: photos creators upload to their quiz (max 1 MB each) and pictures
//! cropped out of an imported Blooket answer-key PDF. Nothing else can store files.
//!
//! Flow for a quiz that isn't saved yet: the editor opens an *upload session*, which reserves the
//! quiz id the quiz will get when saved. A saved quiz uploads straight into its own folder.
//! Every picture is uploaded to the session or quiz, re-encoded here as a
//! compressed WebP (max 1280px) and stored at `<IMAGES_DIR>/<quiz id>/<random>.webp`, served as
//! `/images/<quiz id>/<random>.webp`. Quizzes may only reference files in their own folder.
//!
//! Cleanup (`gc`) deletes any file no longer referenced by the quiz or by an assignment snapshot
//! of it, and removes the folder once empty. It runs when a quiz is saved or deleted, when an
//! assignment is deleted, when an import is discarded, and hourly for anything left behind
//! (abandoned imports, deleted accounts).

use std::{
    collections::HashSet,
    io::Cursor,
    path::{Path, PathBuf},
    time::Duration,
};

use axum::{
    body::Bytes,
    extract::{Path as UrlPath, State},
    http::StatusCode,
    Json,
};
use image::{imageops::FilterType, ImageFormat, ImageReader, Limits};
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};

use crate::{
    auth::{AuthUser, User},
    error::{ApiError, ApiResult},
    models::Question,
    util, Shared,
};

/// Unsaved imports are thrown away after this long.
const SESSION_TTL_SECS: i64 = 24 * 3600;
const MAX_ACTIVE_SESSIONS: i64 = 3;
/// Per photo, as uploaded (it's then re-encoded smaller).
pub const MAX_UPLOAD_BYTES: usize = 1024 * 1024;
/// The sweep leaves recent unsaved uploads alone, so it never pulls a photo from under someone editing.
const SWEEP_GRACE_SECS: u64 = 12 * 3600;
const MAX_IMAGES_PER_QUIZ: usize = 150;
const MAX_QUIZ_BYTES: u64 = 40 * 1024 * 1024;
const MAX_SIDE: u32 = 1280;
const WEBP_QUALITY: f32 = 78.0;

/// `/images/<quiz id>/<file>.webp` → (quiz id, file name). Anything else isn't ours.
pub fn parse_local(url: &str) -> Option<(&str, &str)> {
    let rest = url.strip_prefix("/images/")?;
    let (quiz, file) = rest.split_once('/')?;
    let id_ok = !quiz.is_empty() && quiz.len() <= 16 && quiz.bytes().all(|b| b.is_ascii_alphanumeric());
    let stem = file.strip_suffix(".webp")?;
    let file_ok = (6..=40).contains(&stem.len()) && stem.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-');
    (id_ok && file_ok).then_some((quiz, file))
}

fn quiz_dir(images_dir: &Path, quiz_id: &str) -> PathBuf {
    images_dir.join(quiz_id)
}

/// Every image URL a quiz's content uses.
fn urls<'a>(cover: Option<&'a str>, questions: &'a [Question]) -> impl Iterator<Item = &'a str> {
    cover.into_iter().chain(questions.iter().flat_map(|q| {
        q.image_url.as_deref().into_iter().chain(q.answers.iter().filter_map(|a| a.image_url.as_deref()))
    }))
}

/// Saving a quiz: stored images must belong to this quiz and still exist.
pub fn check_refs(images_dir: &Path, quiz_id: &str, cover: Option<&str>, questions: &[Question]) -> ApiResult<()> {
    for url in urls(cover, questions) {
        if !url.starts_with("/images/") {
            continue;
        }
        let Some((owner, file)) = parse_local(url) else {
            return Err(ApiError::bad("That image link isn't valid"));
        };
        if owner != quiz_id {
            return Err(ApiError::bad("Imported images can only be used in the quiz they were imported into"));
        }
        if !quiz_dir(images_dir, quiz_id).join(file).is_file() {
            return Err(ApiError::bad("One of the imported images no longer exists. Remove it and save again."));
        }
    }
    Ok(())
}

fn session_active(conn: &Connection, id: &str) -> rusqlite::Result<bool> {
    conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM import_sessions WHERE id = ?1 AND created_at > ?2)",
        params![id, util::now_secs() - SESSION_TTL_SECS],
        |r| r.get(0),
    )
}

/// Delete stored images nothing refers to any more; remove the folder once it's empty.
pub fn gc(images_dir: &Path, conn: &Connection, quiz_id: &str) {
    gc_older_than(images_dir, conn, quiz_id, 0);
}

/// Like `gc`, but only removes unused files at least `min_age_secs` old.
fn gc_older_than(images_dir: &Path, conn: &Connection, quiz_id: &str, min_age_secs: u64) {
    if let Err(e) = gc_inner(images_dir, conn, quiz_id, min_age_secs) {
        tracing::warn!("image cleanup for {quiz_id} failed: {e}");
    }
}

fn referenced(conn: &Connection, quiz_id: &str) -> rusqlite::Result<HashSet<String>> {
    let mut keep = HashSet::new();
    let mut collect = |cover: Option<String>, questions: &str| {
        let qs: Vec<Question> = serde_json::from_str(questions).unwrap_or_default();
        for url in urls(cover.as_deref(), &qs) {
            if let Some((q, f)) = parse_local(url) {
                if q == quiz_id {
                    keep.insert(f.to_string());
                }
            }
        }
    };
    if let Some((cover, qs)) = conn
        .query_row("SELECT cover_url, questions FROM quizzes WHERE id = ?1", [quiz_id], |r| {
            Ok((r.get::<_, Option<String>>(0)?, r.get::<_, String>(1)?))
        })
        .optional()?
    {
        collect(cover, &qs);
    }
    // Assignments keep their own copy of the questions, so their pictures must stay too.
    let mut stmt = conn.prepare("SELECT questions FROM assignments WHERE quiz_id = ?1")?;
    for qs in stmt.query_map([quiz_id], |r| r.get::<_, String>(0))? {
        collect(None, &qs?);
    }
    Ok(keep)
}

fn gc_inner(images_dir: &Path, conn: &Connection, quiz_id: &str, min_age_secs: u64) -> Result<(), Box<dyn std::error::Error>> {
    let dir = quiz_dir(images_dir, quiz_id);
    if !dir.is_dir() || session_active(conn, quiz_id)? {
        return Ok(()); // an unsaved quiz may still use any of its files
    }
    let keep = referenced(conn, quiz_id)?;
    for entry in std::fs::read_dir(&dir)? {
        let entry = entry?;
        let name = entry.file_name().to_string_lossy().to_string();
        let age = entry.metadata()?.modified()?.elapsed().map(|d| d.as_secs()).unwrap_or(0);
        if !keep.contains(&name) && age >= min_age_secs {
            let _ = std::fs::remove_file(entry.path());
        }
    }
    if std::fs::read_dir(&dir)?.next().is_none() {
        std::fs::remove_dir(&dir)?;
    }
    Ok(())
}

/// Hourly: expire abandoned imports, then clean every image folder.
pub fn spawn_sweeper(state: Shared) {
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(Duration::from_secs(3600));
        loop {
            tick.tick().await;
            let st = state.clone();
            let _ = tokio::task::spawn_blocking(move || sweep(&st)).await;
        }
    });
}

pub fn sweep(state: &Shared) {
    let conn = state.db.lock().unwrap();
    let _ = conn.execute(
        "DELETE FROM import_sessions WHERE created_at <= ?1",
        [util::now_secs() - SESSION_TTL_SECS],
    );
    let Ok(dirs) = std::fs::read_dir(&state.images_dir) else { return };
    for d in dirs.flatten() {
        if d.path().is_dir() {
            gc_older_than(&state.images_dir, &conn, &d.file_name().to_string_lossy(), SWEEP_GRACE_SECS);
        }
    }
}

// ---------------------------------------------------------------- import sessions

fn own_session(conn: &Connection, user: &User, id: &str) -> ApiResult<()> {
    let owner: Option<i64> = conn
        .query_row(
            "SELECT owner_id FROM import_sessions WHERE id = ?1 AND created_at > ?2",
            params![id, util::now_secs() - SESSION_TTL_SECS],
            |r| r.get(0),
        )
        .optional()?;
    match owner {
        Some(o) if o == user.id => Ok(()),
        _ => Err(ApiError::not_found("Import")),
    }
}

/// Start an import: reserves the id the quiz will be saved under.
pub async fn start_session(State(state): State<Shared>, AuthUser(user): AuthUser) -> ApiResult<Json<Value>> {
    let conn = state.db.lock().unwrap();
    let cutoff = util::now_secs() - SESSION_TTL_SECS;
    let active: i64 = conn.query_row(
        "SELECT COUNT(*) FROM import_sessions WHERE owner_id = ?1 AND created_at > ?2",
        params![user.id, cutoff],
        |r| r.get(0),
    )?;
    if active >= MAX_ACTIVE_SESSIONS {
        // Drop this user's oldest unfinished import rather than blocking them.
        let oldest: String = conn.query_row(
            "SELECT id FROM import_sessions WHERE owner_id = ?1 ORDER BY created_at LIMIT 1",
            [user.id],
            |r| r.get(0),
        )?;
        conn.execute("DELETE FROM import_sessions WHERE id = ?1", [&oldest])?;
        gc(&state.images_dir, &conn, &oldest);
    }
    let id = loop {
        let id = util::short_id(8);
        let taken: bool = conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM quizzes WHERE id = ?1) OR EXISTS(SELECT 1 FROM import_sessions WHERE id = ?1)",
            [&id],
            |r| r.get(0),
        )?;
        if !taken && !quiz_dir(&state.images_dir, &id).exists() {
            break id;
        }
    };
    conn.execute(
        "INSERT INTO import_sessions (id, owner_id, created_at) VALUES (?1, ?2, ?3)",
        params![id, user.id, util::now_secs()],
    )?;
    Ok(Json(json!({ "id": id })))
}

/// Decode a PNG/JPEG/WebP, shrink it to fit MAX_SIDE, and re-encode as lossy WebP.
fn to_webp(bytes: &[u8]) -> ApiResult<Vec<u8>> {
    let mut reader = ImageReader::new(Cursor::new(bytes))
        .with_guessed_format()
        .map_err(|_| ApiError::bad("Couldn't read that image"))?;
    if !matches!(reader.format(), Some(ImageFormat::Png | ImageFormat::Jpeg | ImageFormat::WebP)) {
        return Err(ApiError::bad("Only photos can be uploaded: PNG, JPEG or WebP"));
    }
    let mut limits = Limits::default();
    limits.max_image_width = Some(10_000);
    limits.max_image_height = Some(10_000);
    limits.max_alloc = Some(256 * 1024 * 1024);
    reader.limits(limits);
    let img = reader.decode().map_err(|_| ApiError::bad("Couldn't read that image"))?;
    let img = if img.width() > MAX_SIDE || img.height() > MAX_SIDE {
        img.resize(MAX_SIDE, MAX_SIDE, FilterType::Lanczos3)
    } else {
        img
    };
    let rgba = img.to_rgba8();
    let encoded = webp::Encoder::from_rgba(rgba.as_raw(), rgba.width(), rgba.height()).encode(WEBP_QUALITY);
    Ok(encoded.to_vec())
}

/// Upload into an unsaved quiz's session (photos, or pictures from an imported PDF).
pub async fn upload_image(
    State(state): State<Shared>,
    AuthUser(user): AuthUser,
    UrlPath(id): UrlPath<String>,
    body: Bytes,
) -> ApiResult<Json<Value>> {
    {
        let conn = state.db.lock().unwrap();
        own_session(&conn, &user, &id)?;
    }
    store_image(&state, &id, body).await
}

/// Upload a photo into a saved quiz you own. It's only kept if a save ends up using it.
pub async fn upload_quiz_image(
    State(state): State<Shared>,
    AuthUser(user): AuthUser,
    UrlPath(id): UrlPath<String>,
    body: Bytes,
) -> ApiResult<Json<Value>> {
    {
        let conn = state.db.lock().unwrap();
        if !crate::quizzes::load(&conn, &id)?.can_edit(Some(&user)) {
            return Err(ApiError::forbidden());
        }
    }
    store_image(&state, &id, body).await
}

/// Remove a photo uploaded while editing that won't be saved (e.g. the editor was closed).
/// Files the saved quiz or an assignment still uses are kept.
pub async fn delete_quiz_image(
    State(state): State<Shared>,
    AuthUser(user): AuthUser,
    UrlPath((id, file)): UrlPath<(String, String)>,
) -> ApiResult<Json<Value>> {
    let conn = state.db.lock().unwrap();
    if !crate::quizzes::load(&conn, &id)?.can_edit(Some(&user)) {
        return Err(ApiError::forbidden());
    }
    let url = format!("/images/{id}/{file}");
    let Some((_, file)) = parse_local(&url) else { return Err(ApiError::not_found("Image")) };
    if !referenced(&conn, &id)?.contains(file) {
        let _ = std::fs::remove_file(quiz_dir(&state.images_dir, &id).join(file));
        let dir = quiz_dir(&state.images_dir, &id);
        if std::fs::read_dir(&dir).map(|mut d| d.next().is_none()).unwrap_or(false) {
            let _ = std::fs::remove_dir(&dir);
        }
    }
    Ok(Json(json!({ "ok": true })))
}

async fn store_image(state: &Shared, id: &str, body: Bytes) -> ApiResult<Json<Value>> {
    if body.len() > MAX_UPLOAD_BYTES {
        return Err(ApiError::new(StatusCode::PAYLOAD_TOO_LARGE, "Photos can be at most 1 MB"));
    }
    let dir = quiz_dir(&state.images_dir, id);
    let (count, total) = std::fs::read_dir(&dir)
        .map(|rd| rd.flatten().fold((0usize, 0u64), |(n, b), e| (n + 1, b + e.metadata().map(|m| m.len()).unwrap_or(0))))
        .unwrap_or((0, 0));
    if count >= MAX_IMAGES_PER_QUIZ || total >= MAX_QUIZ_BYTES {
        return Err(ApiError::too_many("This quiz already has as many uploaded images as it can hold"));
    }
    // Image work is CPU-heavy; keep it off the async threads.
    let webp = tokio::task::spawn_blocking(move || to_webp(&body)).await.map_err(ApiError::internal)??;
    std::fs::create_dir_all(&dir).map_err(ApiError::internal)?;
    let file = format!("{}.webp", util::token(16));
    let tmp = dir.join(format!(".{file}.tmp"));
    std::fs::write(&tmp, &webp).map_err(ApiError::internal)?;
    std::fs::rename(&tmp, dir.join(&file)).map_err(ApiError::internal)?;
    Ok(Json(json!({ "url": format!("/images/{id}/{file}"), "bytes": webp.len() })))
}

/// Discard an unsaved import and its images.
pub async fn discard_session(
    State(state): State<Shared>,
    AuthUser(user): AuthUser,
    UrlPath(id): UrlPath<String>,
) -> ApiResult<Json<Value>> {
    let conn = state.db.lock().unwrap();
    if own_session(&conn, &user, &id).is_ok() {
        conn.execute("DELETE FROM import_sessions WHERE id = ?1", [&id])?;
        gc(&state.images_dir, &conn, &id);
    }
    Ok(Json(json!({ "ok": true })))
}

/// Saving a new quiz from an import: claim the reserved id. Returns false if the session isn't usable.
pub fn claim_session(conn: &Connection, user: &User, id: &str) -> ApiResult<bool> {
    if own_session(conn, user, id).is_err() {
        return Ok(false);
    }
    let exists: bool = conn.query_row("SELECT EXISTS(SELECT 1 FROM quizzes WHERE id = ?1)", [id], |r| r.get(0))?;
    Ok(!exists)
}

pub fn end_session(conn: &Connection, id: &str) {
    let _ = conn.execute("DELETE FROM import_sessions WHERE id = ?1", [id]);
}
