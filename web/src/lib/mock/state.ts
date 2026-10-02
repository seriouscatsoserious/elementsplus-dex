// In-memory "chain + server" used by mock API / mock wallet (dev & screenshots only).

import { stubOfferTxHex } from "../elementsTx";
import type { AssetContract, Offer } from "../types";

export function fakeHex(seed: string): string {
  // Deterministic 32-byte hex from a seed (FNV-1a chained); not cryptographic.
  let out = "";
  let h = 0x811c9dc5;
  for (let round = 0; out.length < 64; round++) {
    for (const ch of `${seed}#${round}`) {
      h ^= ch.charCodeAt(0);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    out += h.toString(16).padStart(8, "0");
  }
  return out.slice(0, 64);
}

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const GENESIS = fakeHex("genesis");
export const NETWORK = "ecx-beta";
export const ECX = fakeHex("ECX");

export interface MockAsset {
  asset_id: string;
  token_id: string | null;
  contract: AssetContract;
  issuance_txid: string;
  issuance_vin: number;
  description?: string;
  website?: string;
}
export interface MockOffer {
  offer: Offer;
  txid: string;
  vout: number;
  maker: string;
  created_at: number;
}
export interface MockTrade {
  base: string;
  quote: string;
  txid: string;
  base_amount: bigint;
  quote_amount: bigint;
  time: number;
  makerSide?: "ask" | "bid";
}

const tokens: { ticker: string; name: string; precision: number; mid: number; change: number }[] = [
  { ticker: "ALPHA", name: "Alpha", precision: 2, mid: 0.02, change: 4.2 },
  { ticker: "ORBIT", name: "Orbit", precision: 8, mid: 0.25, change: -1.8 },
  { ticker: "NOVA", name: "Nova", precision: 8, mid: 0.0031, change: 12.6 },
  { ticker: "KITE", name: "Kite", precision: 4, mid: 1.14, change: -0.3 },
];

export const WALLET_ADDRESS = "ex1qw5" + fakeHex("addr").slice(0, 32) + "8f2d";

export const state = {
  assets: new Map<string, MockAsset>(),
  offers: new Map<string, MockOffer>(),
  trades: [] as MockTrade[],
  balances: new Map<string, bigint>(),
  nonce: 0,
};

const toAtomic = (display: number, precision: number): bigint => BigInt(Math.round(display * 10 ** precision));

export function makeOffer(give: string, giveAmount: bigint, want: string, wantAmount: bigint, maker: string, created = Date.now() / 1000): MockOffer {
  const txid = fakeHex(`utxo-${state.nonce++}`);
  const vout = state.nonce % 3;
  const offer: Offer = {
    version: 1,
    network: NETWORK,
    genesis_hash: GENESIS,
    tx: stubOfferTxHex(txid, vout),
    give: { asset_id: give, amount: giveAmount.toString() },
    want: { asset_id: want, amount: wantAmount.toString() },
  };
  const m = { offer, txid, vout, maker, created_at: Math.floor(created) };
  state.offers.set(`${txid}:${vout}`, m);
  return m;
}

function seed() {
  const r = rng(42);
  const now = Math.floor(Date.now() / 1000);
  for (const t of tokens) {
    const id = fakeHex(`asset-${t.ticker}`);
    state.assets.set(id, {
      asset_id: id,
      token_id: null,
      contract: { name: t.name, ticker: t.ticker, precision: t.precision, version: 0 },
      issuance_txid: fakeHex(`iss-${t.ticker}`),
      issuance_vin: 0,
    });
    // Trades: random walk over 48h ending at mid, with drift matching `change`.
    const n = 160;
    const start = t.mid / (1 + t.change / 100);
    let p = start * 0.92;
    for (let i = 0; i < n; i++) {
      const time = now - 48 * 3600 + Math.floor((i / n) * 48 * 3600) + Math.floor(r() * 600);
      const target = i < n / 2 ? start : start + ((t.mid - start) * (i - n / 2)) / (n / 2);
      p = p + (target - p) * 0.15 + p * (r() - 0.5) * 0.03;
      if (i === n - 1) p = t.mid;
      const baseDisp = (50 + r() * 4000 * (0.02 / t.mid) ** 0.5) * (t.ticker === "ALPHA" ? 40 : 1);
      const base_amount = toAtomic(baseDisp, t.precision) || 1n;
      const quote_amount = toAtomic(Number(base_amount) / 10 ** t.precision * p, 8);
      state.trades.push({ base: id, quote: ECX, txid: fakeHex(`trade-${t.ticker}-${i}`), base_amount, quote_amount, time, makerSide: r() > 0.5 ? "ask" : "bid" });
    }
    // Book: asks give base for ECX above mid; bids give ECX for base below mid.
    const steps = [0.005, 0.01, 0.025, 0.05, 0.075, 0.1, 0.2];
    steps.forEach((s, i) => {
      const size = (i < 3 ? 150 + r() * 1500 : 800 + r() * 9000) * Math.sqrt(0.02 / t.mid) * (t.ticker === "ALPHA" ? 1 : 0.2);
      const askBase = toAtomic(size, t.precision) || 1n;
      const askPrice = t.mid * (1 + s);
      makeOffer(id, askBase, ECX, toAtomic((Number(askBase) / 10 ** t.precision) * askPrice, 8), fakeHex(`maker-a-${i}`).slice(0, 40), now - i * 900);
      const bidBase = toAtomic(size * (0.6 + r()), t.precision) || 1n;
      const bidPrice = t.mid * (1 - s);
      makeOffer(ECX, toAtomic((Number(bidBase) / 10 ** t.precision) * bidPrice, 8), id, bidBase, fakeHex(`maker-b-${i}`).slice(0, 40), now - i * 700);
    });
  }
  const alpha = fakeHex("asset-ALPHA");
  // A couple of open orders owned by the mock wallet.
  makeOffer(ECX, toAtomic(10000 * 0.0185, 8), alpha, toAtomic(10000, 2), WALLET_ADDRESS, now - 7200);
  makeOffer(alpha, toAtomic(2000, 2), ECX, toAtomic(2000 * 0.024, 8), WALLET_ADDRESS, now - 3600);

  state.balances.set(ECX, toAtomic(1284.5, 8));
  state.balances.set(alpha, toAtomic(12000, 2));
  state.balances.set(fakeHex("asset-ORBIT"), toAtomic(40.125, 8));
}

seed();
