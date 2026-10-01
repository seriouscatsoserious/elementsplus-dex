import { createApi, type DexApi } from "../lib/api";
import { API_URL } from "../lib/config";

let current: DexApi = createApi(API_URL);

/** Swap the API implementation (mock mode installs a mock fetch at boot). */
export function setApi(api: DexApi): void {
  current = api;
}

/** Stable proxy so modules can import `api` before boot completes. */
export const api: DexApi = new Proxy({} as DexApi, {
  get: (_t, prop) => current[prop as keyof DexApi],
});
