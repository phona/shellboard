import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const apiPort = process.env.SHELLBOARD_PORT ?? "7700";

// SHELLBOARD_ALLOWED_ORIGINS lists full origins for the API server's origin
// check. vite's allowedHosts matches bare hostnames (it strips the port from
// the Host header before comparing), so derive the hostname per entry;
// entries without a scheme pass through as-is.
const allowedHosts = (process.env.SHELLBOARD_ALLOWED_ORIGINS ?? "")
  .split(",")
  .map((entry) => entry.trim())
  .filter((entry) => entry.length > 0)
  .map((entry) => {
    try {
      const url = new URL(entry);
      if (url.protocol === "http:" || url.protocol === "https:") return url.hostname;
    } catch {
      // fall through to the bare-hostname case
    }
    return entry;
  });

export default defineConfig({
  plugins: [react()],
  server: {
    host: process.env.SHELLBOARD_WEB_HOST ?? "localhost",
    port: Number(process.env.SHELLBOARD_WEB_PORT ?? 5173),
    allowedHosts,
    proxy: {
      "/api": {
        target: `http://127.0.0.1:${apiPort}`,
        ws: true,
        // keep the client's Host so the server's Origin<->Host check passes
        // for LAN/remote browsers; browsers cannot forge Host, so this
        // remains a real origin check
        xfwd: true,
      },
    },
  },
});
