import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// In development the Rust backend runs on :8080; Vite proxies API and WebSocket traffic to it.
export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
    port: 5173,
    proxy: {
      "/api": "http://localhost:8080",
      "/ws": { target: "ws://localhost:8080", ws: true },
    },
  },
});
