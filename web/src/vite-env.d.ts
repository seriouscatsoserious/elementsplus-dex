/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_URL?: string;
  readonly VITE_MOCK_WALLET?: string;
  readonly VITE_MOCK_API?: string;
  readonly VITE_POLICY_ASSET?: string;
  readonly VITE_EXPLORER_URL?: string;
  readonly VITE_WALLET_INSTALL_URL?: string;
  readonly VITE_NETWORK_LABEL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
