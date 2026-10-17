use rand::Rng;
use std::time::{SystemTime, UNIX_EPOCH};

pub fn now_secs() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs() as i64
}

pub fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis() as i64
}

const ALNUM: &[u8] = b"abcdefghjkmnpqrstuvwxyz23456789";
const TOKEN: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

/// Short, human-friendly id (no ambiguous characters) used in URLs.
pub fn short_id(len: usize) -> String {
    random_from(ALNUM, len)
}

/// Long unguessable token.
pub fn token(len: usize) -> String {
    random_from(TOKEN, len)
}

pub fn pin() -> String {
    let n: u32 = rand::thread_rng().gen_range(100_000..1_000_000);
    n.to_string()
}

fn random_from(alphabet: &[u8], len: usize) -> String {
    let mut rng = rand::thread_rng();
    (0..len).map(|_| alphabet[rng.gen_range(0..alphabet.len())] as char).collect()
}
