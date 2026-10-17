#!/usr/bin/env bash
# Build and (re)start PleaseStudy under pm2.
#
# One process serves the website, the API and live-game WebSockets on a single port,
# so a single tunnel (e.g. Cloudflare Tunnel) pointed at http://localhost:$PORT is all you need.
#
# Usage:  ./deploy.sh               pull the latest code from git, build, start/reload
#         ./deploy.sh --no-pull     build + start/reload without updating from git
#         ./deploy.sh --skip-build  just restart with the current build (no pull)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
step() { printf '\n\033[1;33m▶ %s\033[0m\n' "$*"; }
fail() { printf '\033[1;31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

SKIP_BUILD=false
NO_PULL=false
for arg in "$@"; do
  case "$arg" in
    --skip-build) SKIP_BUILD=true; NO_PULL=true ;;
    --no-pull) NO_PULL=true ;;
    *) fail "Unknown option: $arg (use --no-pull or --skip-build)" ;;
  esac
done

# ---------------------------------------------------------------- update from git
if ! $NO_PULL; then
  if git -C "$ROOT" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    step "Updating from git"
    BRANCH="$(git rev-parse --abbrev-ref HEAD)"
    UPSTREAM="$(git rev-parse --abbrev-ref --symbolic-full-name '@{u}' 2>/dev/null || true)"
    if [[ "$BRANCH" == "HEAD" || -z "$UPSTREAM" ]]; then
      bold "No upstream branch to pull from (branch: $BRANCH). Deploying the current checkout."
    else
      # Never clobber local edits: a deploy should only ever move forward to what's on the remote.
      if ! git diff --quiet || ! git diff --cached --quiet; then
        git status --short
        fail "There are uncommitted changes (above). Commit or stash them, or deploy as-is with ./deploy.sh --no-pull"
      fi
      git fetch --prune
      OLD_HEAD="$(git rev-parse HEAD)"
      if ! git merge --ff-only "$UPSTREAM" >/dev/null 2>&1; then
        fail "Local '$BRANCH' and '$UPSTREAM' have diverged. Sort it out with git (e.g. git pull --rebase), then deploy again."
      fi
      NEW_HEAD="$(git rev-parse HEAD)"
      if [[ "$OLD_HEAD" == "$NEW_HEAD" ]]; then
        echo "Already up to date with $UPSTREAM ($(git rev-parse --short HEAD))."
      else
        echo "Updated $BRANCH: $(git rev-parse --short "$OLD_HEAD") → $(git rev-parse --short "$NEW_HEAD")"
        git log --oneline "$OLD_HEAD..$NEW_HEAD" | sed 's/^/  /'
        # Bash reads scripts as it runs them, so if this file changed, hand over to the new version.
        if ! git diff --quiet "$OLD_HEAD" "$NEW_HEAD" -- deploy.sh; then
          bold "deploy.sh was updated, restarting with the new version…"
          exec "$ROOT/deploy.sh" --no-pull
        fi
      fi
    fi
  else
    bold "Not a git checkout, skipping update."
  fi
fi

# ---------------------------------------------------------------- config
if [[ ! -f .env ]]; then
  cp .env.example .env
  bold "Created .env from .env.example (edit it to set KLIPY_API_KEY etc.)"
fi
set -a
# shellcheck disable=SC1091
source .env
set +a
PORT="${PORT:-8010}"
DATABASE_PATH="${DATABASE_PATH:-backend/pleasestudy.db}"
[[ "$DATABASE_PATH" = /* ]] || DATABASE_PATH="$ROOT/$DATABASE_PATH"
IMAGES_DIR="${IMAGES_DIR:-backend/images}"
[[ "$IMAGES_DIR" = /* ]] || IMAGES_DIR="$ROOT/$IMAGES_DIR"

# ---------------------------------------------------------------- tools
step "Checking tools"
command -v node >/dev/null || fail "Node.js is missing (brew install node)"
command -v cargo >/dev/null || fail "Rust is missing (brew install rust)"
if ! command -v pm2 >/dev/null; then
  bold "pm2 not found, installing it globally with npm…"
  npm install -g pm2
fi
echo "node $(node -v) · $(cargo --version) · pm2 $(pm2 -v)"

# ---------------------------------------------------------------- port check
# A server started by hand would block pm2 from binding the port.
if command -v lsof >/dev/null; then
  PID_ON_PORT="$(lsof -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null | head -n1 || true)"
  PM2_PID="$(pm2 pid pleasestudy 2>/dev/null | tr -d '[:space:]' || true)"
  if [[ -n "$PID_ON_PORT" && "$PID_ON_PORT" != "$PM2_PID" ]]; then
    CMD="$(ps -o command= -p "$PID_ON_PORT" 2>/dev/null || true)"
    echo "Port $PORT is in use by PID $PID_ON_PORT: $CMD"
    if [[ "$CMD" == *pleasestudy* ]]; then
      read -r -p "That's a PleaseStudy server started outside pm2. Stop it? [Y/n] " ans
      if [[ "${ans:-Y}" =~ ^[Yy]$ ]]; then
        kill "$PID_ON_PORT"
        sleep 1
      else
        fail "Stop it first, or set a different PORT in .env"
      fi
    else
      fail "Something else is using port $PORT. Free it or set a different PORT in .env"
    fi
  fi
fi

# ---------------------------------------------------------------- build
if ! $SKIP_BUILD; then
  step "Building frontend"
  (cd frontend && npm ci --no-audit --no-fund && npm run build)

  step "Building backend (release)"
  (cd backend && cargo build --release)
fi
[[ -x backend/target/release/pleasestudy ]] || fail "No backend build found. Run without --skip-build."
[[ -f frontend/dist/index.html ]] || fail "No frontend build found. Run without --skip-build."

# ---------------------------------------------------------------- backup
if [[ -f "$DATABASE_PATH" ]] && command -v sqlite3 >/dev/null; then
  step "Backing up database"
  mkdir -p "$ROOT/backups"
  BACKUP="$ROOT/backups/pleasestudy-$(date +%Y%m%d-%H%M%S).db"
  sqlite3 "$DATABASE_PATH" ".backup '$BACKUP'"
  echo "Saved $BACKUP"
  if [[ -d "$IMAGES_DIR" ]] && [[ -n "$(ls -A "$IMAGES_DIR" 2>/dev/null)" ]]; then
    tar -czf "${BACKUP%.db}-images.tar.gz" -C "$(dirname "$IMAGES_DIR")" "$(basename "$IMAGES_DIR")"
    echo "Saved ${BACKUP%.db}-images.tar.gz"
  fi
  # Keep the 10 most recent backups.
  ls -1t "$ROOT"/backups/pleasestudy-*.db 2>/dev/null | tail -n +11 | xargs rm -f
  ls -1t "$ROOT"/backups/pleasestudy-*-images.tar.gz 2>/dev/null | tail -n +11 | xargs rm -f
fi

# ---------------------------------------------------------------- run
step "Starting with pm2"
if pm2 describe pleasestudy >/dev/null 2>&1; then
  pm2 reload ecosystem.config.cjs --update-env
else
  pm2 start ecosystem.config.cjs
fi
pm2 save >/dev/null

step "Health check"
for i in $(seq 1 20); do
  if curl -fsS "http://localhost:$PORT/api/quizzes" >/dev/null 2>&1 \
    && curl -fsS "http://localhost:$PORT/" | grep -q '<div id="root">'; then
    printf '\033[1;32m✓ PleaseStudy is up on http://localhost:%s\033[0m\n' "$PORT"
    break
  fi
  [[ $i == 20 ]] && { pm2 logs pleasestudy --lines 30 --nostream; fail "Server didn't come up. Logs above."; }
  sleep 0.5
done

cat <<EOF

Next steps
  • Point your tunnel at http://localhost:$PORT  (e.g. cloudflared tunnel --url http://localhost:$PORT)
  • Logs:      pm2 logs pleasestudy
  • Status:    pm2 status
  • Restart:   ./deploy.sh --skip-build
  • Start on boot (once): run 'pm2 startup' and follow the command it prints
EOF
