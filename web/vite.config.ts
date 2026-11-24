import { defineConfig } from "vite";
import solid from "vite-plugin-solid";

// `npm run dev` serves the app on its own port and forwards the trading
// WebSocket to a locally running ntrader-server.
export default defineConfig({
  plugins: [solid()],
  server: { proxy: { "/ws": { target: "ws://127.0.0.1:8080", ws: true } } },
  build: { target: "es2022" },
});
