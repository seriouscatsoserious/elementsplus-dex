// Typed wrapper over the injected `window.elementsplus` provider (SPEC §3.3).

import { atomic, cleanOffer, parseOffer } from "./api";
import type { AssetContract, Balance, IssueResult, NetworkInfo, Offer } from "./types";

export interface ElementsPlusProvider {
  isElementsPlus: true;
  request(args: { method: string; params?: unknown }): Promise<unknown>;
  on(event: "accountsChanged" | "disconnect", handler: (...a: unknown[]) => void): void;
  removeListener(event: string, handler: (...a: unknown[]) => void): void;
}

declare global {
  interface Window {
    elementsplus?: ElementsPlusProvider;
  }
}

export const WalletErrorCode = {
  USER_REJECTED: 4001,
  UNAUTHORIZED: 4100,
  UNSUPPORTED_METHOD: 4200,
  INVALID_PARAMS: -32602,
  INTERNAL: -32603,
} as const;

export class WalletError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
  }
}

/** Normalise anything a provider might throw into a WalletError. */
export function toWalletError(e: unknown): WalletError {
  if (e instanceof WalletError) return e;
  if (typeof e === "object" && e !== null) {
    const o = e as { code?: unknown; message?: unknown; data?: unknown };
    const code = typeof o.code === "number" ? o.code : WalletErrorCode.INTERNAL;
    const msg = typeof o.message === "string" ? o.message : "Wallet error";
    return new WalletError(code, msg, o.data);
  }
  return new WalletError(WalletErrorCode.INTERNAL, typeof e === "string" ? e : "Wallet error");
}

export interface ErrorPresentation {
  /** Show a low-key toast (user deliberately cancelled). */
  quiet: boolean;
  title: string;
  detail?: string;
}

export function describeWalletError(e: unknown): ErrorPresentation {
  const err = toWalletError(e);
  switch (err.code) {
    case WalletErrorCode.USER_REJECTED:
      return { quiet: true, title: "Request cancelled in wallet" };
    case WalletErrorCode.UNAUTHORIZED:
      return { quiet: false, title: "Wallet not connected", detail: "Connect your wallet to this site and try again." };
    case WalletErrorCode.UNSUPPORTED_METHOD:
      return { quiet: false, title: "Wallet doesn't support this", detail: "Update the Elements+ wallet extension." };
    case WalletErrorCode.INVALID_PARAMS:
      return { quiet: false, title: "Wallet rejected the request", detail: err.message };
    default:
      if (/locked/i.test(err.message)) return { quiet: false, title: "Wallet is locked", detail: "Unlock the Elements+ wallet and try again." };
      return { quiet: false, title: "Wallet error", detail: err.message };
  }
}

export const getProvider = (): ElementsPlusProvider | undefined =>
  typeof window !== "undefined" && window.elementsplus?.isElementsPlus ? window.elementsplus : undefined;

/** Resolve the provider: immediately, on `elementsplus#initialized`, or undefined after timeout. */
export function waitForProvider(timeoutMs = 1500): Promise<ElementsPlusProvider | undefined> {
  const now = getProvider();
  if (now) return Promise.resolve(now);
  return new Promise((resolve) => {
    const done = () => {
      window.removeEventListener("elementsplus#initialized", done);
      clearTimeout(t);
      resolve(getProvider());
    };
    const t = setTimeout(done, timeoutMs);
    window.addEventListener("elementsplus#initialized", done);
  });
}

// ------------------------------------------------------------ typed calls

type Obj = Record<string, unknown>;
const asObj = (v: unknown, what: string): Obj => {
  if (typeof v !== "object" || v === null) throw new WalletError(WalletErrorCode.INTERNAL, `Unexpected wallet response (${what})`);
  return v as Obj;
};
const asStr = (v: unknown, what: string): string => {
  if (typeof v !== "string" || !v) throw new WalletError(WalletErrorCode.INTERNAL, `Unexpected wallet response (${what})`);
  return v;
};

export interface ConnectResult {
  address: string;
  network: NetworkInfo;
}

export interface MakeOfferParams {
  giveAsset: string;
  giveAmount: bigint;
  wantAsset: string;
  wantAmount: bigint;
}

export interface IssueParams {
  name: string;
  ticker: string;
  precision: number;
  amount: bigint;
  tokenAmount: bigint;
}

export class WalletClient {
  constructor(readonly provider: ElementsPlusProvider) {}

  private async req(method: string, params?: unknown): Promise<unknown> {
    try {
      return await this.provider.request(params === undefined ? { method } : { method, params });
    } catch (e) {
      throw toWalletError(e);
    }
  }

  async connect(): Promise<ConnectResult> {
    return parseConnect(await this.req("ep_connect"));
  }
  async disconnect(): Promise<void> {
    await this.req("ep_disconnect");
  }
  async getAddress(): Promise<string> {
    return asStr(asObj(await this.req("ep_getAddress"), "address").address, "address");
  }
  async getBalances(): Promise<Balance[]> {
    const r = await this.req("ep_getBalances");
    if (!Array.isArray(r)) throw new WalletError(WalletErrorCode.INTERNAL, "Unexpected wallet response (balances)");
    return r.map((b) => {
      const o = asObj(b, "balance");
      return { assetId: asStr(o.assetId, "assetId").toLowerCase(), amount: atomic(o.amount, "amount"), confirmed: o.confirmed !== false };
    });
  }
  async makeSwapOffer(p: MakeOfferParams): Promise<{ offer: Offer; splitTxid?: string }> {
    const r = asObj(
      await this.req("ep_makeSwapOffer", {
        giveAsset: p.giveAsset,
        giveAmount: p.giveAmount.toString(),
        wantAsset: p.wantAsset,
        wantAmount: p.wantAmount.toString(),
      }),
      "offer",
    );
    const offer = parseOffer(typeof r.offer === "string" ? JSON.parse(r.offer) : r.offer);
    return { offer, splitTxid: typeof r.splitTxid === "string" ? r.splitTxid : undefined };
  }
  async takeSwapOffers(offers: Offer[]): Promise<{ txid: string }> {
    const r = asObj(await this.req("ep_takeSwapOffers", { offers: offers.map(cleanOffer) }), "take");
    return { txid: asStr(r.txid, "txid") };
  }
  async cancelSwapOffer(txid: string, vout: number): Promise<{ txid: string }> {
    const r = asObj(await this.req("ep_cancelSwapOffer", { txid, vout }), "cancel");
    return { txid: asStr(r.txid, "txid") };
  }
  async issueAsset(p: IssueParams): Promise<IssueResult> {
    const r = asObj(
      await this.req("ep_issueAsset", {
        name: p.name,
        ticker: p.ticker,
        precision: p.precision,
        amount: p.amount.toString(),
        tokenAmount: p.tokenAmount.toString(),
      }),
      "issue",
    );
    const contract = asObj(typeof r.contract === "string" ? JSON.parse(r.contract) : r.contract, "contract") as AssetContract;
    return {
      txid: asStr(r.txid, "txid"),
      assetId: asStr(r.assetId, "assetId"),
      tokenId: typeof r.tokenId === "string" ? r.tokenId : null,
      contract,
      vin: typeof r.vin === "number" ? r.vin : 0,
    };
  }
}

export function parseConnect(r: unknown): ConnectResult {
  const o = asObj(r, "connect");
  const n = asObj(o.network ?? {}, "network");
  return {
    address: asStr(o.address, "address"),
    network: {
      name: typeof n.name === "string" ? n.name : "ECX Alpha",
      genesisHash: typeof n.genesisHash === "string" ? n.genesisHash : "",
      policyAsset: typeof n.policyAsset === "string" ? n.policyAsset.toLowerCase() : "",
    },
  };
}

export const shortAddress = (a: string): string => (a.length > 14 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a);
export const shortId = (a: string): string => (a.length > 14 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a);
