//! Import a public Kahoot as a draft quiz.
//!
//! Kahoot serves public kahoots as JSON without logging in. We convert what maps onto our
//! question types and report what was skipped. Nothing is saved here: the draft goes to the
//! editor so the creator can review it, and it still goes through moderation to become public.
//! (Blooket isn't supported: its API sits behind a bot challenge and requires a login.)

use axum::{extract::State, Json};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::{
    auth::AuthUser,
    error::{ApiError, ApiResult},
    models::{Answer, Question, QuestionKind, MAX_ANSWERS, MAX_TEXT_ANSWERS, MAX_TIME, MIN_TIME},
    Shared,
};

const KAHOOT_API: &str = "https://create.kahoot.it/rest/kahoots";
const KAHOOT_MEDIA: &str = "https://media.kahoot.it";
const MAX_QUESTIONS: usize = 100;

#[derive(Deserialize)]
pub struct ImportBody {
    url: String,
}

/// Pull the kahoot id (a UUID) out of whatever link the user pasted.
fn kahoot_id(input: &str) -> Option<String> {
    let s = input.trim().to_ascii_lowercase();
    let bytes = s.as_bytes();
    let groups = [8, 4, 4, 4, 12];
    let total = 36;
    (0..=bytes.len().saturating_sub(total)).find_map(|start| {
        let cand = s.get(start..start + total)?;
        let mut pos = 0;
        for (i, len) in groups.iter().enumerate() {
            let part = cand.get(pos..pos + len)?;
            if !part.bytes().all(|b| b.is_ascii_hexdigit()) {
                return None;
            }
            pos += len;
            if i < 4 {
                if cand.as_bytes().get(pos) != Some(&b'-') {
                    return None;
                }
                pos += 1;
            }
        }
        Some(cand.to_string())
    })
}

/// Kahoot text can contain light HTML (<b>, <i>, <sup>…) and entities. Make it plain text.
/// Inline tags vanish ("H<sub>2</sub>O" → "H2O"); line/block tags become a space.
fn plain(html: &str) -> String {
    let mut out = String::with_capacity(html.len());
    let mut tag: Option<String> = None;
    for c in html.chars() {
        match (&mut tag, c) {
            (None, '<') => tag = Some(String::new()),
            (Some(name), '>') => {
                let n: String = name
                    .trim_start_matches('/')
                    .chars()
                    .take_while(|c| c.is_ascii_alphanumeric())
                    .collect::<String>()
                    .to_ascii_lowercase();
                if matches!(n.as_str(), "br" | "p" | "div" | "li" | "ul" | "ol" | "tr" | "td" | "h1" | "h2" | "h3") {
                    out.push(' ');
                }
                tag = None;
            }
            (Some(name), c) => name.push(c),
            (None, c) => out.push(c),
        }
    }
    let decoded = decode_entities(&out);
    decoded.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn decode_entities(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(i) = rest.find('&') {
        out.push_str(&rest[..i]);
        let tail = &rest[i..];
        let Some(end) = tail[..tail.len().min(12)].find(';') else {
            out.push('&');
            rest = &tail[1..];
            continue;
        };
        let ent = &tail[1..end];
        let ch = match ent {
            "amp" => Some('&'),
            "lt" => Some('<'),
            "gt" => Some('>'),
            "quot" => Some('"'),
            "apos" => Some('\''),
            "nbsp" => Some(' '),
            _ if ent.starts_with("#x") || ent.starts_with("#X") => {
                u32::from_str_radix(&ent[2..], 16).ok().and_then(char::from_u32)
            }
            _ if ent.starts_with('#') => ent[1..].parse::<u32>().ok().and_then(char::from_u32),
            _ => None,
        };
        match ch {
            Some(c) => {
                out.push(c);
                rest = &tail[end + 1..];
            }
            None => {
                out.push('&');
                rest = &tail[1..];
            }
        }
    }
    out.push_str(rest);
    out
}

fn clip(s: &str, max: usize) -> String {
    let s: String = s.chars().take(max).collect();
    s.trim().to_string()
}

fn http_url(v: &Value) -> Option<String> {
    v.as_str().filter(|u| u.starts_with("https://") || u.starts_with("http://")).map(str::to_string)
}

/// A choice's picture is either a full URL or a Kahoot media id.
fn choice_image(c: &Value) -> Option<String> {
    let img = &c["image"];
    http_url(&img["url"]).or_else(|| {
        img["id"]
            .as_str()
            .filter(|id| id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-'))
            .map(|id| format!("{KAHOOT_MEDIA}/{id}"))
    })
}

fn convert_question(q: &Value) -> Result<Question, String> {
    let kind = match q["type"].as_str().unwrap_or("") {
        "quiz" | "true_false" => QuestionKind::Single,
        "multiple_select_quiz" => QuestionKind::Multi,
        "open_ended" => QuestionKind::Text,
        "survey" | "poll" => return Err("poll (no right answer)".into()),
        "content" => return Err("info slide".into()),
        "jumble" => return Err("put-in-order puzzle".into()),
        "word_cloud" | "brainstorm" | "open_question" => return Err("open discussion".into()),
        "slider" => return Err("slider".into()),
        "pin_it" | "drop_pin" => return Err("pin-on-image".into()),
        "scale" | "nps" => return Err("rating scale".into()),
        other if other.is_empty() => return Err("unknown type".into()),
        other => return Err(format!("“{other}” question")),
    };
    let text = clip(&plain(q["question"].as_str().unwrap_or("")), 300);
    if text.is_empty() {
        return Err("no question text".into());
    }
    let time_limit = (q["time"].as_u64().unwrap_or(20_000) / 1000).clamp(MIN_TIME as u64, MAX_TIME as u64) as u32;
    let image_url = http_url(&q["image"]);
    let choices = q["choices"].as_array().cloned().unwrap_or_default();

    let answers: Vec<Answer> = if kind == QuestionKind::Text {
        let mut seen = std::collections::HashSet::new();
        choices
            .iter()
            .map(|c| clip(&plain(c["answer"].as_str().unwrap_or("")), 120))
            .filter(|t| !t.is_empty() && seen.insert(t.to_lowercase()))
            .take(MAX_TEXT_ANSWERS)
            .map(|text| Answer { text, correct: true, image_url: None })
            .collect()
    } else {
        choices
            .iter()
            .map(|c| Answer {
                text: clip(&plain(c["answer"].as_str().unwrap_or("")), 120),
                correct: c["correct"].as_bool().unwrap_or(false),
                image_url: choice_image(c),
            })
            // Kahoot leaves unused slots empty.
            .filter(|a| !a.text.is_empty() || a.image_url.is_some())
            .take(MAX_ANSWERS)
            .collect()
    };

    match kind {
        QuestionKind::Text if answers.is_empty() => return Err("no accepted answers".into()),
        QuestionKind::Text => {}
        _ if answers.len() < 2 => return Err("fewer than 2 answers".into()),
        _ if !answers.iter().any(|a| a.correct) => return Err("no correct answer marked".into()),
        _ => {}
    }
    Ok(Question { kind, text, image_url, time_limit, answers })
}

pub async fn kahoot(
    State(state): State<Shared>,
    AuthUser(_user): AuthUser,
    Json(body): Json<ImportBody>,
) -> ApiResult<Json<Value>> {
    let Some(id) = kahoot_id(&body.url) else {
        return Err(ApiError::bad(
            "That doesn't look like a Kahoot link. Open the kahoot on create.kahoot.it and copy the address.",
        ));
    };
    let res = state
        .http
        .get(format!("{KAHOOT_API}/{id}/card/"))
        .query(&[("includeKahoot", "true")])
        .header(reqwest::header::USER_AGENT, "Mozilla/5.0 (compatible; PleaseStudy importer)")
        .send()
        .await
        .map_err(|e| {
            tracing::warn!("kahoot request failed: {e}");
            ApiError::new(axum::http::StatusCode::BAD_GATEWAY, "Couldn't reach Kahoot. Try again in a moment.")
        })?;
    match res.status().as_u16() {
        200 => {}
        403 | 404 => {
            return Err(ApiError::new(
                axum::http::StatusCode::NOT_FOUND,
                "Couldn't find that kahoot. It may be private: only public kahoots can be imported.",
            ))
        }
        429 => return Err(ApiError::too_many("Kahoot is rate-limiting us. Try again in a minute.")),
        code => {
            tracing::warn!("kahoot import got HTTP {code}");
            return Err(ApiError::new(axum::http::StatusCode::BAD_GATEWAY, "Kahoot returned an error"));
        }
    }
    let data: Value = res
        .json()
        .await
        .map_err(|_| ApiError::new(axum::http::StatusCode::BAD_GATEWAY, "Kahoot sent something we couldn't read"))?;
    let k = &data["kahoot"];

    let mut questions = Vec::new();
    let mut skipped = Vec::new();
    let raw = k["questions"].as_array().cloned().unwrap_or_default();
    for (i, q) in raw.iter().enumerate() {
        match convert_question(q) {
            Ok(q) if questions.len() < MAX_QUESTIONS => questions.push(q),
            Ok(_) => skipped.push(json!({ "number": i + 1, "reason": "over the 100-question limit" })),
            Err(reason) => skipped.push(json!({ "number": i + 1, "reason": reason })),
        }
    }
    if questions.is_empty() {
        return Err(ApiError::bad(
            "None of this kahoot's questions can be imported (only quiz, multi-select and type-answer questions work).",
        ));
    }

    let title = clip(&plain(k["title"].as_str().unwrap_or("Imported quiz")), 120);
    Ok(Json(json!({
        "quiz": {
            "title": if title.is_empty() { "Imported quiz".to_string() } else { title },
            "description": clip(&plain(k["description"].as_str().unwrap_or("")), 1000),
            "cover_url": http_url(&k["cover"]),
            "questions": questions,
        },
        "source": format!("https://create.kahoot.it/details/{id}"),
        "imported": questions.len(),
        "total": raw.len(),
        "skipped": skipped,
    })))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_ids_in_links() {
        let id = "7c4ef3fe-7266-4a6b-861b-15719738ad2c";
        for url in [
            id.to_string(),
            format!("https://create.kahoot.it/details/{id}"),
            format!("https://create.kahoot.it/details/capitals-quiz/{id}?foo=1"),
            format!("https://play.kahoot.it/v2/?quizId={}", id.to_uppercase()),
        ] {
            assert_eq!(kahoot_id(&url).as_deref(), Some(id), "{url}");
        }
        assert_eq!(kahoot_id("https://kahoot.it/challenge/0123456"), None);
    }

    #[test]
    fn strips_html() {
        assert_eq!(plain("What is <b>2</b> &amp;&nbsp;<i>2</i>?"), "What is 2 & 2?");
        assert_eq!(plain("H<sub>2</sub>O &#39;water&#x27;"), "H2O 'water'");
        assert_eq!(plain("Line one<br>line two"), "Line one line two");
        assert_eq!(plain("Fish & chips"), "Fish & chips");
    }
}
