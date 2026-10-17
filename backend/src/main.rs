mod assignments;
mod attempts;
mod auth;
mod db;
mod error;
mod gifs;
mod live;
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
use tower_http::{
    cors::CorsLayer,
    services::{ServeDir, ServeFile},
};
use tracing_subscriber::EnvFilter;

pub struct AppState {
    pub db: Mutex<Connection>,
    pub games: live::Registry,
    pub http: reqwest::Client,
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
    let state: Shared = Arc::new(AppState {
        db: Mutex::new(conn),
        games: live::Registry::default(),
        http,
        klipy_key,
    });
    live::spawn_reaper(state.clone());

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
        .fallback_service(spa).layer(CorsLayer::permissive()).with_state(state);

    let listener = tokio::net::TcpListener::bind(("0.0.0.0", port)).await.expect("failed to bind port");
    tracing::info!("PleaseStudy listening on http://localhost:{port}");
    axum::serve(listener, app).await.unwrap();
}
