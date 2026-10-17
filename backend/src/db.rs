use rusqlite::Connection;

const SCHEMA: &str = r#"
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    role          TEXT NOT NULL DEFAULT 'user',
    created_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
    token      TEXT PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL
);

-- status: private | pending | approved | rejected
CREATE TABLE IF NOT EXISTS quizzes (
    id             TEXT PRIMARY KEY,
    owner_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title          TEXT NOT NULL,
    description    TEXT NOT NULL DEFAULT '',
    cover_url      TEXT,
    questions      TEXT NOT NULL,
    question_count INTEGER NOT NULL,
    status         TEXT NOT NULL DEFAULT 'private',
    mod_note       TEXT,
    reviewed_by    INTEGER,
    plays          INTEGER NOT NULL DEFAULT 0,
    created_at     INTEGER NOT NULL,
    updated_at     INTEGER NOT NULL,
    submitted_at   INTEGER
);
CREATE INDEX IF NOT EXISTS quizzes_status ON quizzes(status);
CREATE INDEX IF NOT EXISTS quizzes_owner ON quizzes(owner_id);

-- An assignment snapshots the quiz so later edits don't change graded work.
CREATE TABLE IF NOT EXISTS assignments (
    code            TEXT PRIMARY KEY,
    quiz_id         TEXT NOT NULL,
    owner_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title           TEXT NOT NULL,
    quiz_title      TEXT NOT NULL,
    questions       TEXT NOT NULL,
    question_count  INTEGER NOT NULL,
    due_at          INTEGER,
    require_account INTEGER NOT NULL DEFAULT 0,
    open            INTEGER NOT NULL DEFAULT 1,
    created_at      INTEGER NOT NULL
);

-- One solo run of a quiz (plain solo play or an assignment attempt).
CREATE TABLE IF NOT EXISTS attempts (
    id              TEXT PRIMARY KEY,
    quiz_id         TEXT,
    assignment_code TEXT REFERENCES assignments(code) ON DELETE CASCADE,
    user_id         INTEGER,
    name            TEXT NOT NULL,
    title           TEXT NOT NULL,
    questions       TEXT NOT NULL,
    responses       TEXT NOT NULL DEFAULT '[]',
    current         INTEGER NOT NULL DEFAULT -1,
    served_at       INTEGER,
    score           INTEGER NOT NULL DEFAULT 0,
    streak          INTEGER NOT NULL DEFAULT 0,
    correct_count   INTEGER NOT NULL DEFAULT 0,
    started_at      INTEGER NOT NULL,
    finished_at     INTEGER
);
CREATE INDEX IF NOT EXISTS attempts_assignment ON attempts(assignment_code);

-- kind: quiz | user. target_id is the quiz id or the user id (as text).
-- status: open | resolved | dismissed
CREATE TABLE IF NOT EXISTS reports (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    kind        TEXT NOT NULL,
    target_id   TEXT NOT NULL,
    reporter_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    reason      TEXT NOT NULL,
    details     TEXT NOT NULL DEFAULT '',
    status      TEXT NOT NULL DEFAULT 'open',
    resolution  TEXT,
    resolved_by INTEGER,
    created_at  INTEGER NOT NULL,
    resolved_at INTEGER
);
CREATE INDEX IF NOT EXISTS reports_target ON reports(kind, target_id, status);

-- Messages from staff to a user (warnings, ban notices, takedowns), shown until acknowledged.
CREATE TABLE IF NOT EXISTS notices (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind       TEXT NOT NULL,
    message    TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    read_at    INTEGER
);
CREATE INDEX IF NOT EXISTS notices_user ON notices(user_id, read_at);
"#;

pub fn open(path: &str) -> rusqlite::Result<Connection> {
    let conn = Connection::open(path)?;
    conn.execute_batch(SCHEMA)?;
    add_column(&conn, "attempts", "settings", "TEXT NOT NULL DEFAULT '{}'")?;
    // NULL queue marks rows created before study settings existed.
    add_column(&conn, "attempts", "queue", "TEXT")?;
    add_column(&conn, "assignments", "settings", "TEXT NOT NULL DEFAULT '{}'")?;
    add_column(&conn, "users", "banned_until", "INTEGER")?;
    // 0 = unlisted: hidden from Discover/search/profiles but reachable by link once approved.
    add_column(&conn, "quizzes", "listed", "INTEGER NOT NULL DEFAULT 1")?;
    // Last time this account sent a quiz to the review queue (for the submission cooldown).
    // Kept on the user so deleting a quiz doesn't reset it.
    add_column(&conn, "users", "last_submit_at", "INTEGER")?;
    add_column(&conn, "users", "display_name", "TEXT")?;
    add_column(&conn, "users", "username_changed_at", "INTEGER")?;
    // A username someone just moved away from stays reserved for them for a while,
    // so nobody else can grab it and impersonate them.
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS username_holds (
            username   TEXT PRIMARY KEY COLLATE NOCASE,
            user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            held_until INTEGER NOT NULL
        );",
    )?;
    add_column(&conn, "users", "bio", "TEXT NOT NULL DEFAULT ''")?;
    // Profile pictures are the only user files we host; kept in the DB so backups are one file.
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS avatars (
            user_id    INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
            mime       TEXT NOT NULL,
            data       BLOB NOT NULL,
            updated_at INTEGER NOT NULL
        );",
    )?;
    add_column(&conn, "users", "ban_reason", "TEXT")?;
    Ok(conn)
}

fn add_column(conn: &Connection, table: &str, column: &str, def: &str) -> rusqlite::Result<()> {
    let exists = conn
        .prepare(&format!("SELECT 1 FROM pragma_table_info('{table}') WHERE name = ?1"))?
        .exists([column])?;
    if !exists {
        conn.execute_batch(&format!("ALTER TABLE {table} ADD COLUMN {column} {def}"))?;
    }
    Ok(())
}
