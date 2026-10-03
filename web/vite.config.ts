import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  // Sub-path deploys (e.g. GitHub Pages) set DEX_BASE=/repo/dex/.
  base: process.env.DEX_BASE ?? "/",
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": { target: process.env.DEX_SERVER ?? "http://127.0.0.1:8790", changeOrigin: true },
      "/llms.txt": { target: process.env.DEX_SERVER ?? "http://127.0.0.1:8790", changeOrigin: true },
    },
  },
  preview: {
    proxy: {
      "/api": { target: process.env.DEX_SERVER ?? "http://127.0.0.1:8790", changeOrigin: true },
      "/llms.txt": { target: process.env.DEX_SERVER ?? "http://127.0.0.1:8790", changeOrigin: true },
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
