import { resolve } from "node:path";
import { defineConfig } from "vite";
import solid from "vite-plugin-solid";

// Two pages: the Web Trader (index.html) and the admin panel (admin.html).
// `npm run dev` serves them on their own port and forwards the trading
// WebSocket and the Manager API to a locally running ntrader-server.
export default defineConfig({
  plugins: [solid()],
  server: {
    proxy: {
      "/ws": { target: "ws://127.0.0.1:8080", ws: true },
      "/api": { target: "http://127.0.0.1:8080" },
    },
  },
  build: {
    target: "es2022",
    rollupOptions: { input: { main: resolve(import.meta.dirname, "index.html"), admin: resolve(import.meta.dirname, "admin.html") } },
  },
});
