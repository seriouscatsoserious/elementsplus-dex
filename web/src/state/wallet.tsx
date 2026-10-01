import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { NetworkInfo } from "../lib/types";
import { WalletClient, WalletErrorCode, getProvider, toWalletError, waitForProvider } from "../lib/wallet";
import { useToast } from "./toast";

export type WalletStatus = "detecting" | "missing" | "disconnected" | "connecting" | "connected";

export interface WalletState {
  status: WalletStatus;
  client: WalletClient | null;
  address: string | null;
  network: NetworkInfo | null;
  /** Wallet reported it is locked on the last request. */
  locked: boolean;
  balances: Map<string, bigint>;
  balancesLoaded: boolean;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  refreshBalances(): Promise<void>;
  balanceOf(assetId: string | null | undefined): bigint;
}

const Ctx = createContext<WalletState | null>(null);

export function useWallet(): WalletState {
  const c = useContext(Ctx);
  if (!c) throw new Error("WalletProvider missing");
  return c;
}

const BALANCE_POLL_MS = 10_000;

export function WalletProvider({ children }: { children: ReactNode }) {
  const toast = useToast();
  const [status, setStatus] = useState<WalletStatus>("detecting");
  const [client, setClient] = useState<WalletClient | null>(null);
  const [address, setAddress] = useState<string | null>(null);
  const [network, setNetwork] = useState<NetworkInfo | null>(null);
  const [locked, setLocked] = useState(false);
  const [balances, setBalances] = useState<Map<string, bigint>>(new Map());
  const [balancesLoaded, setBalancesLoaded] = useState(false);
  const clientRef = useRef<WalletClient | null>(null);

  const reset = useCallback(() => {
    setStatus(clientRef.current ? "disconnected" : "missing");
    setAddress(null);
    setBalances(new Map());
    setBalancesLoaded(false);
  }, []);

  const refreshBalances = useCallback(async () => {
    const c = clientRef.current;
    if (!c) return;
    try {
      const list = await c.getBalances();
      const m = new Map<string, bigint>();
      for (const b of list) m.set(b.assetId, (m.get(b.assetId) ?? 0n) + b.amount);
      setBalances(m);
      setBalancesLoaded(true);
      setLocked(false);
    } catch (e) {
      const err = toWalletError(e);
      if (err.code === WalletErrorCode.UNAUTHORIZED) reset();
      else if (/locked/i.test(err.message)) setLocked(true);
    }
  }, [reset]);

  // Detect provider + silently restore an existing connection (no popup).
  useEffect(() => {
    let cancelled = false;
    const init = async () => {
      const p = await waitForProvider();
      if (cancelled) return;
      if (!p) {
        setStatus("missing");
        return;
      }
      const c = new WalletClient(p);
      clientRef.current = c;
      setClient(c);
      try {
        const addr = await c.getAddress();
        if (cancelled) return;
        setAddress(addr);
        setStatus("connected");
      } catch (e) {
        if (cancelled) return;
        if (/locked/i.test(toWalletError(e).message)) setLocked(true);
        setStatus("disconnected");
      }
    };
    void init();
    // Late injection (extension installed / enabled after load).
    const onInit = () => {
      if (!clientRef.current && getProvider()) void init();
    };
    window.addEventListener("elementsplus#initialized", onInit);
    return () => {
      cancelled = true;
      window.removeEventListener("elementsplus#initialized", onInit);
    };
  }, []);

  // Provider events.
  useEffect(() => {
    const p = client?.provider;
    if (!p) return;
    const onAccounts = (...a: unknown[]) => {
      const list = a[0];
      const next = Array.isArray(list) && typeof list[0] === "string" ? list[0] : typeof list === "string" ? list : null;
      if (next) {
        setAddress(next);
        setStatus("connected");
        void refreshBalances();
      } else reset();
    };
    const onDisconnect = () => reset();
    p.on("accountsChanged", onAccounts);
    p.on("disconnect", onDisconnect);
    return () => {
      p.removeListener("accountsChanged", onAccounts);
      p.removeListener("disconnect", onDisconnect);
    };
  }, [client, refreshBalances, reset]);

  // Balance polling while connected.
  useEffect(() => {
    if (status !== "connected") return;
    void refreshBalances();
    const t = setInterval(() => {
      if (document.visibilityState === "visible") void refreshBalances();
    }, BALANCE_POLL_MS);
    return () => clearInterval(t);
  }, [status, address, refreshBalances]);

  const connect = useCallback(async () => {
    const c = clientRef.current;
    if (!c) return;
    setStatus("connecting");
    try {
      const r = await c.connect();
      setAddress(r.address);
      setNetwork(r.network);
      setLocked(false);
      setStatus("connected");
    } catch (e) {
      setStatus("disconnected");
      toast.error(toWalletError(e));
    }
  }, [toast]);

  const disconnect = useCallback(async () => {
    try {
      await clientRef.current?.disconnect();
    } catch {
      /* best effort */
    }
    reset();
  }, [reset]);

  const balanceOf = useCallback((id: string | null | undefined) => (id ? (balances.get(id) ?? 0n) : 0n), [balances]);

  const value = useMemo<WalletState>(
    () => ({ status, client, address, network, locked, balances, balancesLoaded, connect, disconnect, refreshBalances, balanceOf }),
    [status, client, address, network, locked, balances, balancesLoaded, connect, disconnect, refreshBalances, balanceOf],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
