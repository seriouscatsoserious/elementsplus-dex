// Fetch implementation that serves the §4.1 API from the in-memory mock state.
// Query flags (mock mode only): ?api=down  → network errors; ?api=empty → no markets.

import { cmpRatio, ratio, ratioToDecimal, type Ratio } from "../amount";
import { firstInputOutpoint } from "../elementsTx";
import { parseBookEntry, type FetchFn } from "../api";
import { selectRoute } from "../route";
import { ECX, GENESIS, state, type MockOffer } from "./state";

const flags = typeof location !== "undefined" ? new URLSearchParams(location.search) : new URLSearchParams();
const mode = flags.get("api");

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body, (_k, v) => (typeof v === "bigint" ? v.toString() : v)), {
    status,
    headers: { "Content-Type": "application/json" },
  });
const priceStr = (r: Ratio) => ratioToDecimal(r, 12, "round", false).replace(/\.?0+$/, "");
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

function bookEntry(m: MockOffer, base: string) {
  const isAsk = m.offer.give.asset_id === base;
  const b = BigInt(isAsk ? m.offer.give.amount : m.offer.want.amount);
  const q = BigInt(isAsk ? m.offer.want.amount : m.offer.give.amount);
  // Same shape as the server's OfferRecord: flattened offer + `offer` + metadata.
  return {
    ...m.offer,
    offer: m.offer,
    outpoint: `${m.txid}:${m.vout}`,
    txid: m.txid,
    vout: m.vout,
    maker_address: m.maker,
    side: isAsk ? "ask" : "bid",
    base_amount: b.toString(),
    quote_amount: q.toString(),
    price: Number(priceStr(ratio(q, b))),
    status: "open",
    created_at: m.created_at,
  };
}

function pairs(): [string, string][] {
  if (mode === "empty") return [];
  const seen = new Map<string, [string, string]>();
  const add = (a: string, b: string) => {
    const [base, quote] = b === ECX ? [a, b] : a === ECX ? [b, a] : [a, b].sort() as [string, string];
    seen.set(`${base}/${quote}`, [base, quote]);
  };
  for (const o of state.offers.values()) add(o.offer.give.asset_id, o.offer.want.asset_id);
  for (const t of state.trades) add(t.base, t.quote);
  return [...seen.values()];
}

function market(base: string, quote: string) {
  const trades = state.trades.filter((t) => t.base === base && t.quote === quote).sort((a, b) => a.time - b.time);
  const now = Date.now() / 1000;
  const last = trades.at(-1);
  const before = [...trades].reverse().find((t) => t.time <= now - 86400);
  const lastP = last ? ratio(last.quote_amount, last.base_amount) : null;
  const prevP = before ? ratio(before.quote_amount, before.base_amount) : null;
  let change: string | null = null;
  if (lastP && prevP) change = ratioToDecimal(ratio(lastP.num * prevP.den - prevP.num * lastP.den, lastP.den * prevP.num), 6, "round", false);
  const day = trades.filter((t) => t.time > now - 86400);
  const vol = day.reduce((s, t) => s + t.quote_amount, 0n);
  const baseVol = day.reduce((s, t) => s + t.base_amount, 0n);
  let nb = 0;
  let na = 0;
  let bid: Ratio | null = null;
  let ask: Ratio | null = null;
  for (const o of state.offers.values()) {
    if (o.offer.give.asset_id === base && o.offer.want.asset_id === quote) {
      const p = ratio(BigInt(o.offer.want.amount), BigInt(o.offer.give.amount));
      na++;
      if (!ask || cmpRatio(p, ask) < 0) ask = p;
    } else if (o.offer.give.asset_id === quote && o.offer.want.asset_id === base) {
      const p = ratio(BigInt(o.offer.give.amount), BigInt(o.offer.want.amount));
      nb++;
      if (!bid || cmpRatio(p, bid) > 0) bid = p;
    }
  }
  return {
    base,
    quote,
    // Server sends f64 prices (quote atomic per base atomic) and a fractional change.
    last_price: lastP ? Number(priceStr(lastP)) : null,
    change_24h: change === null ? null : Number(change),
    volume_24h: vol.toString(),
    base_volume_24h: baseVol.toString(),
    trades_24h: day.length,
    bids: nb,
    asks: na,
    best_bid: bid ? Number(priceStr(bid)) : null,
    best_ask: ask ? Number(priceStr(ask)) : null,
  };
}

const INTERVALS: Record<string, number> = { "15m": 900, "1h": 3600, "4h": 14400, "1d": 86400 };

async function handle(method: string, url: URL, body: unknown): Promise<Response> {
  const p = url.pathname.replace(/^.*\/api/, "");
  const parts = p.split("/").filter(Boolean);
  if (p === "/health") return json({ ok: true, tip: 18_204, network: "ecx-alpha", genesis_hash: GENESIS, policy_asset: ECX });
  if (p === "/assets" && method === "GET") return page(mode === "empty" ? [] : [...state.assets.values()]);
  if (p === "/assets" && method === "POST") {
    const b = body as { issuance_txid: string; vin: number; contract: MockAsset["contract"]; description?: string; website?: string; asset_id?: string };
    const id = pendingIssued.get(b.issuance_txid);
    if (!id) return err(400, "tx_not_found", "issuance transaction not found");
    const entry = { asset_id: id.assetId, token_id: id.tokenId, contract: b.contract, issuance_txid: b.issuance_txid, issuance_vin: b.vin, description: b.description, website: b.website };
    state.assets.set(id.assetId, entry);
    return json(entry, 201);
  }
  if (parts[0] === "assets" && parts[1]) {
    const a = state.assets.get(parts[1]);
    return a ? json(a) : err(404, "unknown_asset", "asset not registered");
  }
  if (p === "/markets") return page(pairs().map(([b, q]) => market(b, q)));
  if (parts[0] === "markets" && parts.length === 4) {
    const [, base, quote, what] = parts as [string, string, string, string];
    if (what === "book") {
      const asks = [], bids = [];
      for (const o of state.offers.values()) {
        if (o.offer.give.asset_id === base && o.offer.want.asset_id === quote) asks.push(bookEntry(o, base));
        else if (o.offer.give.asset_id === quote && o.offer.want.asset_id === base) bids.push(bookEntry(o, base));
      }
      return json({ base, quote, bids, asks });
    }
    if (what === "trades") {
      return page(
        state.trades
          .filter((t) => t.base === base && t.quote === quote)
          .sort((a, b) => b.time - a.time)
          .slice(0, 50)
          .map((t) => ({ txid: t.txid, price: Number(priceStr(ratio(t.quote_amount, t.base_amount))), base_amount: t.base_amount, quote_amount: t.quote_amount, time: t.time, maker_side: t.makerSide ?? "ask" })),
      );
    }
    if (what === "candles") {
      const step = INTERVALS[url.searchParams.get("interval") ?? "1h"] ?? 3600;
      const buckets = new Map<number, { o: Ratio; h: Ratio; l: Ratio; c: Ratio; v: bigint; qv: bigint; n: number }>();
      for (const t of [...state.trades].filter((t) => t.base === base && t.quote === quote).sort((a, b) => a.time - b.time)) {
        const k = Math.floor(t.time / step) * step;
        const pr = ratio(t.quote_amount, t.base_amount);
        const b = buckets.get(k);
        if (!b) buckets.set(k, { o: pr, h: pr, l: pr, c: pr, v: t.base_amount, qv: t.quote_amount, n: 1 });
        else {
          if (cmpRatio(pr, b.h) > 0) b.h = pr;
          if (cmpRatio(pr, b.l) < 0) b.l = pr;
          b.c = pr;
          b.v += t.base_amount;
          b.qv += t.quote_amount;
          b.n += 1;
        }
      }
      return page([...buckets].map(([time, b]) => ({ time, open: Number(priceStr(b.o)), high: Number(priceStr(b.h)), low: Number(priceStr(b.l)), close: Number(priceStr(b.c)), volume: b.v, quote_volume: b.qv, trades: b.n })));
    }
  }
  if (p === "/quote") {
    // Mock-mode implementation of the server's whole-offer greedy routing.
    const sell = url.searchParams.get("sell") ?? "";
    const buy = url.searchParams.get("buy") ?? "";
    const side = url.searchParams.get("side") === "exact_out" ? "receive" : "pay";
    const amountStr = url.searchParams.get("amount") ?? "";
    if (!/^\d+$/.test(amountStr)) return err(400, "bad_amount", "amount must be atomic units");
    const amount = BigInt(amountStr);
    const entries = [...state.offers.values()].map((m) => parseBookEntry(bookEntry(m, m.offer.give.asset_id)));
    const r = selectRoute(entries, sell, buy, side, amount);
    const reached = side === "pay" ? r.totalPay : r.totalReceive;
    const mk = sell === ECX ? { base: buy, quote: sell } : { base: sell, quote: buy };
    return json({
      side: side === "pay" ? "exact_in" : "exact_out",
      sell_asset: sell,
      buy_asset: buy,
      amount: amountStr,
      ...mk,
      offers: r.fills.map((e) => bookEntry(state.offers.get(e.id)!, mk.base)),
      sell_amount: r.totalPay,
      buy_amount: r.totalReceive,
      price: r.avgPrice ? Number(priceStr(r.avgPrice)) : null,
      price_impact_bps: r.impact ? Number((r.impact.num * 10_000n) / r.impact.den) : 0,
      unfilled: amount - reached,
    });
  }
  if (p === "/offers" && method === "POST") {
    const offer = body as MockOffer["offer"];
    const { txid, vout } = firstInputOutpoint(offer.tx);
    const owned = pendingOffers.get(`${txid}:${vout}`);
    const m: MockOffer = { offer, txid, vout, maker: owned ?? "unknown", created_at: Math.floor(Date.now() / 1000) };
    state.offers.set(`${txid}:${vout}`, m);
    return json(bookEntry(m, offer.give.asset_id === ECX ? offer.want.asset_id : offer.give.asset_id), 201);
  }
  if (p === "/offers" && method === "GET") {
    const maker = url.searchParams.get("maker");
    return page([...state.offers.values()].filter((o) => o.maker === maker).map((o) => bookEntry(o, o.offer.give.asset_id === ECX ? o.offer.want.asset_id : o.offer.give.asset_id)));
  }
  return err(404, "not_found", "not found");
}

const page = (items: unknown[]) => json({ items, next_cursor: null });
const err = (status: number, code: string, message: string) => json({ error: { code, message } }, status);

type MockAsset = typeof state.assets extends Map<string, infer V> ? V : never;

/** Mock wallet → mock API side channel (who made which offer, which issuance produced which asset). */
export const pendingOffers = new Map<string, string>();
export const pendingIssued = new Map<string, { assetId: string; tokenId: string | null }>();

export const mockFetch: FetchFn = async (input, init) => {
  await delay(120 + Math.random() * 120);
  if (mode === "down") throw new TypeError("Failed to fetch");
  const url = new URL(input, "http://mock.local");
  const body = init?.body ? JSON.parse(String(init.body)) : undefined;
  return handle(init?.method ?? "GET", url, body);
};
