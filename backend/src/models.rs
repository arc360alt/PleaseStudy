use serde::{Deserialize, Serialize};

use crate::error::{ApiError, ApiResult};

pub const MIN_ANSWERS: usize = 2;
pub const MAX_ANSWERS: usize = 6;
pub const MIN_TIME: u32 = 5;
pub const MAX_TIME: u32 = 240;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Answer {
    #[serde(default)]
    pub text: String,
    pub correct: bool,
    /// Optional hot-linked picture/GIF shown on the answer box.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub image_url: Option<String>,
}

pub const MAX_TEXT_ANSWERS: usize = 10;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum QuestionKind {
    /// Pick one box. Several may be marked correct; picking any of them counts.
    #[default]
    Single,
    /// Pick every correct box, then submit. Only the exact set counts.
    Multi,
    /// Type the answer. `answers` holds the accepted wordings (all correct).
    Text,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Question {
    #[serde(default)]
    pub kind: QuestionKind,
    pub text: String,
    #[serde(default)]
    pub image_url: Option<String>,
    pub time_limit: u32,
    pub answers: Vec<Answer>,
}

/// Partial credit for "pick several" questions. A pick-several answer's accuracy is
/// (right boxes picked − wrong boxes picked) / correct boxes, so picking everything doesn't pay.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PartialCredit {
    /// Only the exact set scores.
    #[default]
    None,
    /// Half points when accuracy ≥ 50%.
    AtLeastHalf,
    /// Half points when accuracy > 50%.
    MoreThanHalf,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Grade {
    Correct,
    /// Pick-several answer that earned half points under a partial-credit setting.
    Partial,
    Wrong,
}

/// What a player sent for one question. Which field matters depends on the question kind.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Submission {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub choice: Option<usize>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub choices: Option<Vec<usize>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
}

impl Submission {
    pub fn is_empty(&self) -> bool {
        self.choice.is_none() && self.choices.as_ref().map_or(true, |c| c.is_empty()) && self.text.is_none()
    }

    /// Picked answer indices, for counting how many people chose each box.
    pub fn picked(&self) -> Vec<usize> {
        match (&self.choices, self.choice) {
            (Some(c), _) => c.clone(),
            (None, Some(c)) => vec![c],
            _ => Vec::new(),
        }
    }
}

/// Typed answers are compared ignoring case, spacing, and punctuation that doesn't change meaning.
/// Commas, quotes, apostrophes and the like are dropped anywhere ("Paris, France" == "paris france",
/// "don't" == "dont"); full stops only at the ends so numbers like 3.14 keep their meaning.
pub fn normalize_answer(s: &str) -> String {
    let stripped: String = s
        .chars()
        .filter(|c| !",!?;:'\"“”‘’`()".contains(*c))
        .collect::<String>()
        .to_lowercase();
    stripped
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .trim_matches('.')
        .trim()
        .to_string()
}

/// Options for solo runs (plain solo play or an assignment).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StudySettings {
    /// Count down each question; when off, there's no time pressure and every correct answer is worth the same.
    #[serde(default = "yes")]
    pub timer: bool,
    /// Show the question alone for a few seconds before the answers appear.
    #[serde(default = "yes")]
    pub read_countdown: bool,
    /// Missed questions go to the back of the line until answered correctly.
    #[serde(default)]
    pub repeat_wrong: bool,
    #[serde(default)]
    pub shuffle_questions: bool,
    #[serde(default)]
    pub shuffle_answers: bool,
    #[serde(default)]
    pub multi_partial: PartialCredit,
}

fn yes() -> bool {
    true
}

impl Default for StudySettings {
    fn default() -> Self {
        Self {
            timer: true,
            read_countdown: true,
            repeat_wrong: false,
            shuffle_questions: false,
            shuffle_answers: false,
            multi_partial: PartialCredit::None,
        }
    }
}

/// A question as players see it before answering: no correctness info,
/// and for typed questions no accepted answers at all.
#[derive(Debug, Serialize)]
pub struct PublicQuestion<'a> {
    pub kind: QuestionKind,
    pub text: &'a str,
    pub image_url: Option<&'a str>,
    pub time_limit: u32,
    pub answers: Vec<&'a str>,
    pub answer_images: Vec<Option<&'a str>>,
}

impl Question {
    pub fn public(&self) -> PublicQuestion<'_> {
        PublicQuestion {
            kind: self.kind,
            text: &self.text,
            image_url: self.image_url.as_deref(),
            time_limit: self.time_limit,
            answers: if self.kind == QuestionKind::Text {
                Vec::new()
            } else {
                self.answers.iter().map(|a| a.text.as_str()).collect()
            },
            answer_images: self.answer_images(),
        }
    }

    /// Per-box images (empty for typed questions).
    pub fn answer_images(&self) -> Vec<Option<&str>> {
        if self.kind == QuestionKind::Text {
            Vec::new()
        } else {
            self.answers.iter().map(|a| a.image_url.as_deref()).collect()
        }
    }

    /// Box count shown to players (0 for typed answers).
    pub fn choice_count(&self) -> usize {
        if self.kind == QuestionKind::Text {
            0
        } else {
            self.answers.len()
        }
    }

    pub fn accepted(&self) -> Vec<&str> {
        self.answers.iter().map(|a| a.text.as_str()).collect()
    }

    /// Drop anything that doesn't apply to this question's kind or is out of range.
    pub fn clean_submission(&self, sub: Submission) -> Submission {
        let n = self.answers.len();
        match self.kind {
            QuestionKind::Single => Submission { choice: sub.choice.filter(|&c| c < n), ..Default::default() },
            QuestionKind::Multi => {
                let mut c: Vec<usize> = sub.choices.unwrap_or_default().into_iter().filter(|&c| c < n).collect();
                c.sort_unstable();
                c.dedup();
                Submission { choices: (!c.is_empty()).then_some(c), ..Default::default() }
            }
            QuestionKind::Text => Submission {
                text: sub
                    .text
                    .map(|t| t.trim().chars().take(200).collect::<String>())
                    .filter(|t| !t.is_empty()),
                ..Default::default()
            },
        }
    }

    /// Like `grade`, but pick-several answers can earn partial credit.
    pub fn grade_with(&self, sub: &Submission, partial: PartialCredit) -> Grade {
        if self.grade(sub) {
            return Grade::Correct;
        }
        if self.kind != QuestionKind::Multi || partial == PartialCredit::None {
            return Grade::Wrong;
        }
        let Some(picked) = &sub.choices else { return Grade::Wrong };
        let correct = self.correct_indices();
        let hits = picked.iter().filter(|c| correct.contains(c)).count() as i64;
        let misses = picked.len() as i64 - hits;
        // Compare (hits - misses) / correct against one half without floating point.
        let doubled = 2 * (hits - misses);
        let total = correct.len() as i64;
        let earns = match partial {
            PartialCredit::AtLeastHalf => doubled >= total,
            PartialCredit::MoreThanHalf => doubled > total,
            PartialCredit::None => false,
        };
        if earns && hits > 0 {
            Grade::Partial
        } else {
            Grade::Wrong
        }
    }

    /// Expects a submission already passed through `clean_submission`.
    pub fn grade(&self, sub: &Submission) -> bool {
        match self.kind {
            QuestionKind::Single => sub.choice.is_some_and(|c| self.answers[c].correct),
            QuestionKind::Multi => sub.choices.as_ref().is_some_and(|c| *c == self.correct_indices()),
            QuestionKind::Text => sub.text.as_ref().is_some_and(|t| {
                let t = normalize_answer(t);
                self.answers.iter().any(|a| normalize_answer(&a.text) == t)
            }),
        }
    }

    pub fn correct_indices(&self) -> Vec<usize> {
        self.answers.iter().enumerate().filter(|(_, a)| a.correct).map(|(i, _)| i).collect()
    }
}

/// Media is always hot-linked from elsewhere; we only store the URL.
pub fn clean_url(url: Option<String>, field: &str) -> ApiResult<Option<String>> {
    let Some(url) = url.map(|u| u.trim().to_string()).filter(|u| !u.is_empty()) else {
        return Ok(None);
    };
    if url.len() > 2000 {
        return Err(ApiError::bad(format!("{field} is too long")));
    }
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return Err(ApiError::bad(format!("{field} must start with http:// or https://")));
    }
    Ok(Some(url))
}

pub fn validate_questions(questions: Vec<Question>) -> ApiResult<Vec<Question>> {
    if questions.is_empty() {
        return Err(ApiError::bad("A quiz needs at least one question"));
    }
    if questions.len() > 100 {
        return Err(ApiError::bad("A quiz can have at most 100 questions"));
    }
    questions
        .into_iter()
        .enumerate()
        .map(|(i, q)| {
            let n = i + 1;
            let text = q.text.trim().to_string();
            if text.is_empty() || text.chars().count() > 300 {
                return Err(ApiError::bad(format!("Question {n}: text must be 1–300 characters")));
            }
            if q.kind == QuestionKind::Text {
                let mut seen = std::collections::HashSet::new();
                let answers: Vec<Answer> = q
                    .answers
                    .into_iter()
                    .map(|a| a.text.trim().chars().take(120).collect::<String>())
                    .filter(|t| !normalize_answer(t).is_empty() && seen.insert(normalize_answer(t)))
                    .map(|text| Answer { text, correct: true, image_url: None })
                    .collect();
                if answers.is_empty() {
                    return Err(ApiError::bad(format!("Question {n}: add at least one accepted answer")));
                }
                if answers.len() > MAX_TEXT_ANSWERS {
                    return Err(ApiError::bad(format!("Question {n}: at most {MAX_TEXT_ANSWERS} accepted answers")));
                }
                return Ok(Question {
                    kind: q.kind,
                    text,
                    image_url: clean_url(q.image_url, &format!("Question {n} image"))?,
                    time_limit: q.time_limit.clamp(MIN_TIME, MAX_TIME),
                    answers,
                });
            }
            if !(MIN_ANSWERS..=MAX_ANSWERS).contains(&q.answers.len()) {
                return Err(ApiError::bad(format!("Question {n}: needs 2–6 answers")));
            }
            let answers = q
                .answers
                .into_iter()
                .enumerate()
                .map(|(j, a)| {
                    let text = a.text.trim().to_string();
                    let image_url = clean_url(a.image_url, &format!("Question {n} answer {} image", j + 1))?;
                    if text.chars().count() > 120 {
                        return Err(ApiError::bad(format!("Question {n}: answers can be at most 120 characters")));
                    }
                    if text.is_empty() && image_url.is_none() {
                        return Err(ApiError::bad(format!(
                            "Question {n}: every answer needs text or an image"
                        )));
                    }
                    Ok(Answer { text, correct: a.correct, image_url })
                })
                .collect::<ApiResult<Vec<_>>>()?;
            if !answers.iter().any(|a| a.correct) {
                return Err(ApiError::bad(format!("Question {n}: mark at least one correct answer")));
            }
            Ok(Question {
                kind: q.kind,
                text,
                image_url: clean_url(q.image_url, &format!("Question {n} image"))?,
                time_limit: q.time_limit.clamp(MIN_TIME, MAX_TIME),
                answers,
            })
        })
        .collect()
}

/// Kahoot-style speed scoring: 1000 for an instant answer, down to 500 at the buzzer,
/// plus a streak bonus.
pub fn score_answer(elapsed_ms: u64, limit_ms: u64, streak_after: u32) -> i64 {
    let frac = (elapsed_ms as f64 / limit_ms.max(1) as f64).min(1.0);
    let base = (1000.0 * (1.0 - frac / 2.0)).round() as i64;
    let bonus = 100 * (streak_after.saturating_sub(1).min(5)) as i64;
    base + bonus
}
