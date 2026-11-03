import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// 开发时 vite 跑在 5173，/api 与 /events 代理到本地采集服务（默认 8787）。
const API = process.env.MONITOR_API ?? "http://127.0.0.1:8787";

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: "dist",
    sourcemap: false,
  },
  server: {
    port: 5173,
    proxy: {
      "/api": { target: API, changeOrigin: true },
      "/events": { target: API, changeOrigin: true },
    },
  },
});
