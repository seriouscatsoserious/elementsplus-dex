const env = import.meta.env;

export const API_URL: string = env.VITE_API_URL || "/api";
export const MOCK_WALLET = env.VITE_MOCK_WALLET === "1";
export const MOCK_API = env.VITE_MOCK_API === "1";
/** Optional pin for the policy asset (ECX); otherwise learned from the wallet / markets. */
export const ENV_POLICY_ASSET: string | undefined = env.VITE_POLICY_ASSET?.toLowerCase() || undefined;
/** Optional Esplora-style explorer base, used for tx links (`${EXPLORER_URL}/tx/<txid>`). */
export const EXPLORER_URL: string | undefined = env.VITE_EXPLORER_URL?.replace(/\/+$/, "") || undefined;
export const WALLET_INSTALL_URL: string =
  env.VITE_WALLET_INSTALL_URL || "https://github.com/elementsplus/elementsplus-wallet-extension";
export const NETWORK_LABEL: string = env.VITE_NETWORK_LABEL || "eCash Beta · Elements";

/** Display names for the network profile ids the server and wallet use. */
const NETWORK_NAMES: Record<string, string> = {
  "ecx-beta": "eCash Beta · Elements",
  "ecx-mainnet": "eCash · Elements",
  "elementsplus-regtest": "Local test chain",
};

/** Human label for a network profile id (falls back to the id itself). */
export function networkLabel(id: string | null | undefined): string {
  if (!id) return NETWORK_LABEL;
  return NETWORK_NAMES[id] ?? id;
}

export const txUrl = (txid: string): string | undefined => (EXPLORER_URL ? `${EXPLORER_URL}/tx/${txid}` : undefined);

/** Agent-facing docs served by the DEX server (SPEC §6.1). */
export const OPENAPI_URL = `${API_URL.replace(/\/+$/, "")}/openapi.json`;
export const LLMS_TXT_URL = /^https?:\/\//.test(API_URL) ? new URL("/llms.txt", API_URL).toString() : "/llms.txt";
