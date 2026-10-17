mod assignments;
mod attempts;
mod auth;
mod db;
mod error;
mod gifs;
mod import;
mod live;
mod media;
mod models;
mod moderation;
mod profile;
mod quizzes;
mod reports;
mod util;

use std::{
    env,
    sync::{Arc, Mutex},
};

use axum::{
    extract::DefaultBodyLimit,
    routing::{any, get, post, put},
    Router,
};
use rusqlite::Connection;
use axum::http::{header, HeaderValue};
use tower_http::{
    set_header::SetResponseHeaderLayer,
    cors::CorsLayer,
    services::{ServeDir, ServeFile},
};
use tracing_subscriber::EnvFilter;

pub struct AppState {
    pub db: Mutex<Connection>,
    pub games: live::Registry,
    pub http: reqwest::Client,
    /// Where PDF-imported images live (`<dir>/<quiz id>/<file>.webp`).
    pub images_dir: std::path::PathBuf,
    pub klipy_key: Option<String>,
}

pub type Shared = Arc<AppState>;

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("pleasestudy=info")))
        .init();

    let db_path = env::var("DATABASE_PATH").unwrap_or_else(|_| "pleasestudy.db".into());
    let static_dir = env::var("STATIC_DIR").unwrap_or_else(|_| "../frontend/dist".into());
    let port: u16 = env::var("PORT").ok().and_then(|p| p.parse().ok()).unwrap_or(8010);

    let conn = db::open(&db_path).expect("failed to open database");
    let klipy_key = env::var("KLIPY_API_KEY").ok().filter(|k| !k.trim().is_empty());
    if klipy_key.is_none() {
        tracing::info!("KLIPY_API_KEY not set: GIF search is disabled");
    }
    let http = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(8))
        .build()
        .expect("failed to build HTTP client");
    let images_dir = std::path::PathBuf::from(env::var("IMAGES_DIR").unwrap_or_else(|_| "images".into()));
    std::fs::create_dir_all(&images_dir).expect("failed to create images directory");
    let state: Shared = Arc::new(AppState {
        db: Mutex::new(conn),
        games: live::Registry::default(),
        http,
        klipy_key,
        images_dir: images_dir.clone(),
    });
    live::spawn_reaper(state.clone());
    media::sweep(&state); // clean up anything left from before a restart
    media::spawn_sweeper(state.clone());

    let api = Router::new()
        .route("/api/auth/register", post(auth::register))
        .route("/api/auth/login", post(auth::login))
        .route("/api/auth/logout", post(auth::logout))
        .route("/api/auth/me", get(auth::me))
        .route("/api/quizzes", get(quizzes::list_public).post(quizzes::create))
        .route("/api/quizzes/mine", get(quizzes::list_mine))
        .route("/api/quizzes/:id", get(quizzes::get).put(quizzes::update).delete(quizzes::delete))
        .route("/api/quizzes/:id/submit", post(quizzes::submit))
        .route("/api/quizzes/:id/unpublish", post(quizzes::unpublish))
        .route("/api/quizzes/:id/listing", post(quizzes::set_listing))
        .route("/api/mod/queue", get(moderation::queue))
        .route("/api/mod/quizzes/:id/review", post(moderation::review))
        .route("/api/admin/users", get(moderation::list_users))
        .route("/api/admin/users/:id/role", post(moderation::set_role))
        .route("/api/admin/users/:id/action", post(reports::user_action))
        .route("/api/reports", post(reports::create))
        .route("/api/mod/reports", get(reports::list))
        .route("/api/mod/reports/resolve", post(reports::resolve))
        .route("/api/notices", get(reports::my_notices))
        .route("/api/notices/:id/ack", post(reports::ack_notice))
        .route("/api/users/:username", get(reports::profile))
        .route("/api/me", get(profile::get_me).patch(profile::update_me))
        .route("/api/me/username", post(profile::change_username))
        .route("/api/me/username/revert", post(profile::revert_username))
        .route("/api/usernames/check", get(profile::check_username))
        .route(
            "/api/me/avatar",
            put(profile::upload_avatar)
                .delete(profile::delete_avatar)
                // A little headroom so oversized uploads get our friendly 1 MB message.
                .layer(DefaultBodyLimit::max(profile::MAX_AVATAR_BYTES + 64 * 1024)),
        )
        .route("/api/avatars/:id", get(profile::get_avatar))
        .route("/api/import/kahoot", post(import::kahoot))
        .route("/api/import/session", post(media::start_session))
        .route("/api/import/session/:id", axum::routing::delete(media::discard_session))
        .route(
            "/api/quizzes/:id/images",
            put(media::upload_quiz_image).layer(DefaultBodyLimit::max(media::MAX_UPLOAD_BYTES + 64 * 1024)),
        )
        .route("/api/quizzes/:id/images/:file", axum::routing::delete(media::delete_quiz_image))
        .route(
            "/api/import/session/:id/images",
            put(media::upload_image).layer(DefaultBodyLimit::max(media::MAX_UPLOAD_BYTES + 64 * 1024)),
        )
        .route("/api/gifs/status", get(gifs::status))
        .route("/api/gifs/search", get(gifs::search))
        .route("/api/assignments", post(assignments::create))
        .route("/api/assignments/mine", get(assignments::list_mine))
        .route("/api/assignments/:code", get(assignments::get).delete(assignments::delete))
        .route("/api/assignments/:code/toggle", post(assignments::toggle))
        .route("/api/assignments/:code/results", get(assignments::results))
        .route("/api/attempts", post(attempts::start))
        .route("/api/attempts/:id", get(attempts::get))
        .route("/api/attempts/:id/next", post(attempts::next))
        .route("/api/attempts/:id/answer", post(attempts::answer))
        .route("/api/games", post(live::create))
        .route("/api/games/:pin", get(live::info))
        .route("/ws", get(live::ws_handler));

    // Serve the built frontend; unknown paths fall back to index.html for client-side routing.
    // Unknown /api paths get a JSON 404, and missing build assets a plain 404, instead of the app page.
    let spa = ServeDir::new(&static_dir).fallback(ServeFile::new(format!("{static_dir}/index.html")));
    let app = api
        .route("/api/*rest", any(|| async { error::ApiError::not_found("API route") }))
        .nest_service("/assets", ServeDir::new(format!("{static_dir}/assets")))
        // Stored images: random file names never change, so cache them for good.
        .nest_service(
            "/images",
            Router::new()
                .fallback_service(ServeDir::new(&images_dir))
                .layer(SetResponseHeaderLayer::overriding(
                    header::X_CONTENT_TYPE_OPTIONS,
                    HeaderValue::from_static("nosniff"),
                ))
                .layer(SetResponseHeaderLayer::overriding(
                    header::CACHE_CONTROL,
                    HeaderValue::from_static("public, max-age=31536000, immutable"),
                )),
        )
        .fallback_service(spa).layer(CorsLayer::permissive()).with_state(state);

    let listener = tokio::net::TcpListener::bind(("0.0.0.0", port)).await.expect("failed to bind port");
    tracing::info!("PleaseStudy listening on http://localhost:{port}");
    axum::serve(listener, app).await.unwrap();
}
