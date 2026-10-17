//! GIF search for quiz creators, proxied to KLIPY so the API key stays on the server.
//! Set KLIPY_API_KEY to enable it; without a key the picker reports itself as unavailable.

use axum::{
    extract::{Query, State},
    Json,
};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::{
    auth::AuthUser,
    error::{ApiError, ApiResult},
    Shared,
};

const KLIPY_BASE: &str = "https://api.klipy.com/api/v1";

#[derive(Deserialize)]
pub struct SearchQuery {
    #[serde(default)]
    q: String,
    #[serde(default)]
    page: Option<u32>,
}

pub async fn status(State(state): State<Shared>) -> Json<Value> {
    Json(json!({ "enabled": state.klipy_key.is_some() }))
}

/// Trending GIFs when `q` is empty, otherwise search results.
pub async fn search(
    State(state): State<Shared>,
    AuthUser(user): AuthUser,
    Query(query): Query<SearchQuery>,
) -> ApiResult<Json<Value>> {
    let Some(key) = &state.klipy_key else {
        return Err(ApiError::bad("GIF search isn't set up on this server"));
    };
    let q: String = query.q.trim().chars().take(100).collect();
    let page = query.page.unwrap_or(1).clamp(1, 50).to_string();
    let endpoint = if q.is_empty() { "trending" } else { "search" };
    let customer = user.id.to_string();
    let mut params = vec![
        ("page", page.as_str()),
        ("per_page", "24"),
        ("customer_id", customer.as_str()),
        // Strictest filter: this is a school-friendly site.
        ("content_filter", "high"),
        ("format_filter", "gif,webp"),
    ];
    if !q.is_empty() {
        params.push(("q", q.as_str()));
    }

    let res = state
        .http
        .get(format!("{KLIPY_BASE}/{key}/gifs/{endpoint}"))
        .query(&params)
        .send()
        .await
        .map_err(|e| {
            tracing::warn!("klipy request failed: {e}");
            ApiError::new(axum::http::StatusCode::BAD_GATEWAY, "Couldn't reach the GIF service")
        })?;
    let status = res.status();
    let body: Value = res.json().await.unwrap_or(Value::Null);
    if !status.is_success() || body["result"] != json!(true) {
        tracing::warn!("klipy error {status}: {body}");
        let msg = if status.as_u16() == 429 {
            "Too many GIF searches right now. Try again in a bit."
        } else {
            "The GIF service returned an error"
        };
        return Err(ApiError::new(axum::http::StatusCode::BAD_GATEWAY, msg));
    }

    let pick = |file: &Value, sizes: &[&str]| -> Option<Value> {
        sizes.iter().find_map(|s| {
            let f = &file[*s]["gif"];
            f["url"].as_str().map(|u| json!({ "url": u, "width": f["width"], "height": f["height"] }))
        })
    };
    let items: Vec<Value> = body["data"]["data"]
        .as_array()
        .map(|list| {
            list.iter()
                .filter_map(|item| {
                    let file = &item["file"];
                    // Small rendition for the picker grid, medium one saved into the quiz.
                    let preview = pick(file, &["sm", "xs", "md"])?;
                    let full = pick(file, &["md", "hd", "sm"])?;
                    Some(json!({
                        "id": item["id"],
                        "title": item["title"],
                        "preview": preview["url"],
                        "url": full["url"],
                        "width": preview["width"],
                        "height": preview["height"],
                    }))
                })
                .collect()
        })
        .unwrap_or_default();
    Ok(Json(json!({ "items": items, "has_next": body["data"]["has_next"].as_bool().unwrap_or(false) })))
}
