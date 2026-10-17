// pm2 process definition for PleaseStudy.
// One process serves everything: the API, live-game WebSockets and the built frontend.
// Settings come from ./.env (see .env.example) so they survive `pm2 restart` and reboots.

const fs = require("fs");
const path = require("path");

const root = __dirname;

function loadEnv(file) {
  const env = {};
  if (!fs.existsSync(file)) return env;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m || line.trim().startsWith("#")) continue;
    env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, "$2");
  }
  return env;
}

const env = loadEnv(path.join(root, ".env"));
const resolve = (p) => (path.isAbsolute(p) ? p : path.join(root, p));

module.exports = {
  apps: [
    {
      name: "pleasestudy",
      cwd: path.join(root, "backend"),
      script: path.join(root, "backend/target/release/pleasestudy"),
      interpreter: "none",
      env: {
        PORT: env.PORT || "8010",
        DATABASE_PATH: resolve(env.DATABASE_PATH || "backend/pleasestudy.db"),
        // Pictures saved from Blooket PDF imports (<dir>/<quiz id>/<file>.webp).
        IMAGES_DIR: resolve(env.IMAGES_DIR || "backend/images"),
        STATIC_DIR: path.join(root, "frontend/dist"),
        KLIPY_API_KEY: env.KLIPY_API_KEY || "",
        RUST_LOG: env.RUST_LOG || "pleasestudy=info",
      },
      autorestart: true,
      max_restarts: 20,
      restart_delay: 2000,
      // Live games live in memory; give in-flight requests a moment on restart.
      kill_timeout: 5000,
      time: true,
    },
  ],
};
