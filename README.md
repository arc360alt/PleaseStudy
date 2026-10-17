# PleaseStudy

A Kahoot/Blooket-style quiz game. Rust (axum + SQLite + WebSockets) backend, TypeScript (React + Vite) frontend.

## Run it

**Development** (two terminals, hot reload):

```sh
cd backend && cargo run          # API on http://localhost:8080
cd frontend && npm install && npm run dev   # open http://localhost:5173
```

**Single server** (build the frontend, the backend serves it):

```sh
cd frontend && npm run build
cd ../backend && cargo run --release        # open http://localhost:8080
```

Env vars: `PORT` (8080), `DATABASE_PATH` (pleasestudy.db), `STATIC_DIR` (../frontend/dist).

**The first account you register becomes the admin.** Admins can promote others to moderator under Moderation → Users & roles.

## How it works

- **Quizzes**: 1–100 questions, 2–6 answers each (one or more correct), 5–240s timer, optional image/GIF *link* (media is never hosted here, only text).
- **Moderation**: new quizzes are private. "Submit to go public" puts them in the mod queue; a moderator approves or sends them back with a note. Editing a public quiz sends it back for review.
- **Solo**: any public quiz (or your own) can be played alone from its page.
- **Assignments**: "Assign" creates a link (`/a/<code>`). Anyone with it plays solo; optional due date and "require account" (one attempt each). Results and per-question stats are in Library → Assignments. Questions are snapshotted, so later edits don't affect them.
- **Live hosting**: "Host live" opens a lobby with a 6-digit PIN. Players join at `/join` with or without an account. Host options: question on big screen only or on devices too, a timer override, read-countdown length, shuffle, and late join. Each round goes: question + countdown → answering → answer counts / % correct → leaderboard → next question. It ends on a podium. Players who drop reconnect automatically.
- Scoring happens on the server in every mode: 1000 for an instant answer, falling to 500 at the buzzer, plus a streak bonus.
