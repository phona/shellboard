import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const apiPort = process.env.SHELLBOARD_PORT ?? "7700";

export default defineConfig({
  plugins: [react()],
  server: {
    host: process.env.SHELLBOARD_WEB_HOST ?? "localhost",
    port: Number(process.env.SHELLBOARD_WEB_PORT ?? 5173),
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
