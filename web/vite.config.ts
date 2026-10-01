import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
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
