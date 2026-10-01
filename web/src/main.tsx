import "@fontsource/geist/latin-400.css";
import "@fontsource/geist/latin-500.css";
import "@fontsource/geist/latin-600.css";
import "@fontsource/geist/latin-700.css";
import "@fontsource/geist-mono/latin-400.css";
import "@fontsource/geist-mono/latin-500.css";
import "@fontsource/geist-mono/latin-600.css";
import "./styles.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { createApi } from "./lib/api";
import { API_URL } from "./lib/config";
import { setApi } from "./state/api";

async function boot() {
  // Literal env checks so production builds drop the mock chunks entirely.
  if (import.meta.env.VITE_MOCK_API === "1") {
    const { mockFetch } = await import("./lib/mock/api");
    setApi(createApi(API_URL, mockFetch));
  }
  if (import.meta.env.VITE_MOCK_WALLET === "1") {
    const { installMockWallet } = await import("./lib/mockWallet");
    installMockWallet();
  }
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

void boot();
