import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

// 개발: npm run dev (5173) → /api 는 백엔드(8000)로 프록시. 운영: dist 를 FastAPI 가 제공.
export default defineConfig({
  plugins: [react()],
  resolve: { alias: { "@": path.resolve(__dirname, "src") } },
  server: {
    port: 5173,
    proxy: { "/api": { target: process.env.API_URL ?? "http://127.0.0.1:8000", changeOrigin: true } },
  },
  build: { outDir: "dist", sourcemap: false, chunkSizeWarningLimit: 1200 },
});
