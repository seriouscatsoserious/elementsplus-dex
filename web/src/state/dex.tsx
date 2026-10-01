import { createContext, useCallback, useContext, useMemo, type ReactNode } from "react";
import { ApiUnavailableError } from "../lib/api";
import { ENV_POLICY_ASSET } from "../lib/config";
import { useQuery } from "../lib/hooks";
import type { AssetEntry, Health, Market } from "../lib/types";
import { api } from "./api";
import { useWallet } from "./wallet";

export interface AssetInfo {
  id: string;
  name: string;
  ticker: string;
  precision: number;
  /** In the verified registry (or the built-in policy asset). */
  verified: boolean;
  isPolicy: boolean;
  color: string;
  iconUrl?: string | null;
}

interface DexData {
  health: Health | undefined;
  /** True when the server cannot be reached. */
  serverDown: boolean;
  markets: Market[] | undefined;
  marketsError: unknown;
  marketsLoading: boolean;
  refetchMarkets(): Promise<void>;
  assets: AssetEntry[] | undefined;
  refetchAssets(): Promise<void>;
  policyAsset: string | null;
  info(id: string): AssetInfo;
}

const Ctx = createContext<DexData | null>(null);
export function useDex(): DexData {
  const c = useContext(Ctx);
  if (!c) throw new Error("DexProvider missing");
  return c;
}

const PALETTE = ["#F2B661", "#E58FD0", "#4FC3A1", "#FF8A5B", "#7FD1E8", "#C3A6FF", "#B8D86B", "#F28B8B"];
export function assetColor(id: string): string {
  let h = 0;
  for (let i = 0; i < Math.min(id.length, 16); i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return PALETTE[h % PALETTE.length]!;
}

export function DexProvider({ children }: { children: ReactNode }) {
  const wallet = useWallet();
  const health = useQuery("health", () => api.health(), { interval: 15_000 });
  const assets = useQuery("assets", () => api.assets(), { interval: 60_000 });
  const markets = useQuery("markets", () => api.markets(), { interval: 10_000 });

  const policyAsset = useMemo(() => {
    if (ENV_POLICY_ASSET) return ENV_POLICY_ASSET;
    if (health.data?.policyAsset) return health.data.policyAsset;
    if (wallet.network?.policyAsset) return wallet.network.policyAsset;
    // Fall back to the most common quote asset.
    const counts = new Map<string, number>();
    for (const m of markets.data ?? []) counts.set(m.quote, (counts.get(m.quote) ?? 0) + 1);
    let best: string | null = null;
    let n = 0;
    for (const [k, v] of counts) if (v > n) [best, n] = [k, v];
    return best;
  }, [health.data, wallet.network, markets.data]);

  const registry = useMemo(() => new Map((assets.data ?? []).map((a) => [a.asset_id, a])), [assets.data]);

  const info = useCallback(
    (id: string): AssetInfo => {
      if (id === policyAsset) return { id, name: "ECX", ticker: "ECX", precision: 8, verified: true, isPolicy: true, color: "#8FA8FF" };
      const a = registry.get(id);
      if (a)
        return {
          id,
          name: a.contract.name,
          ticker: a.contract.ticker,
          precision: a.contract.precision,
          verified: true,
          isPolicy: false,
          color: assetColor(id),
          iconUrl: a.icon_url,
        };
      return { id, name: "Unknown asset", ticker: id.slice(0, 6), precision: 0, verified: false, isPolicy: false, color: "#5A5E68" };
    },
    [registry, policyAsset],
  );

  const serverDown =
    health.error instanceof ApiUnavailableError || (markets.error instanceof ApiUnavailableError && !markets.data);

  const value = useMemo<DexData>(
    () => ({
      health: health.data,
      serverDown,
      markets: markets.data,
      marketsError: markets.error,
      marketsLoading: markets.loading,
      refetchMarkets: markets.refetch,
      assets: assets.data,
      refetchAssets: assets.refetch,
      policyAsset,
      info,
    }),
    [health.data, serverDown, markets.data, markets.error, markets.loading, markets.refetch, assets.data, assets.refetch, policyAsset, info],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
