import { describe, expect, it } from "vitest";
import { ApiError, ApiParseError, ApiUnavailableError, createApi, parseBookEntry, parseMarket } from "./api";
import { firstInputOutpoint, stubOfferTxHex } from "./elementsTx";
import { displayFromAtomicString, parsePriceString } from "./market";
import { ratio } from "./amount";

const A = "a".repeat(64);
const B = "b".repeat(64);
const TXID = "c1".repeat(32);
const offer = { version: 1, network: "ecx-beta", genesis_hash: "00", tx: stubOfferTxHex(TXID, 3), give: { asset_id: A, amount: "1000" }, want: { asset_id: B, amount: "5000" } };

function fakeFetch(routes: Record<string, { status?: number; body: unknown } | (() => never)>) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fn = async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const key = `${init?.method ?? "GET"} ${url}`;
    const r = routes[key];
    if (!r) return new Response(JSON.stringify({ error: { code: "not_found", message: "nope" } }), { status: 404 });
    if (typeof r === "function") r();
    const { status = 200, body } = r as { status?: number; body: unknown };
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
  };
  return { fn, calls };
}

describe("elementsTx", () => {
  it("reads the first input outpoint (masking issuance flags)", () => {
    expect(firstInputOutpoint(stubOfferTxHex(TXID, 3))).toEqual({ txid: TXID, vout: 3 });
    const flagged = stubOfferTxHex(TXID, 1).replace("01000000" + "00ffffffff", "01000080" + "00ffffffff");
    expect(firstInputOutpoint(flagged).vout).toBe(1);
    expect(() => firstInputOutpoint("zz")).toThrow();
  });
});

describe("parsers", () => {
  it("parses the server's OfferRecord shape (flattened + offer + outpoint)", () => {
    const e = parseBookEntry({ ...offer, offer, outpoint: `${TXID}:3`, txid: TXID, vout: 3, maker_address: "ert1qxyz", status: "open", price: 5, created_at: 1700000000 });
    expect(e.id).toBe(`${TXID}:3`);
    expect(e.giveAmount).toBe(1000n);
    expect(e.wantAmount).toBe(5000n);
    expect(e.maker).toBe("ert1qxyz");
    expect(e.createdAt).toBe(1700000000);
  });
  it("derives the outpoint from the tx when the server omits it", () => {
    expect(parseBookEntry(offer).id).toBe(`${TXID}:3`);
  });
  it("rejects malformed offers", () => {
    expect(() => parseBookEntry({ ...offer, give: { asset_id: A, amount: "-1" } })).toThrow(ApiParseError);
    expect(() => parseBookEntry({ ...offer, give: { asset_id: A, amount: 1.5 } })).toThrow(ApiParseError);
    expect(() => parseBookEntry({ ...offer, want: { asset_id: "xyz", amount: "1" } })).toThrow(ApiParseError);
  });
  it("parses markets with float prices and fractional change", () => {
    const m = parseMarket({ base: A, quote: B, last_price: 2e-7, change_24h: 0.042, volume_24h: "18240", best_bid: null, best_ask: 0.5 });
    expect(m.volume_24h).toBe(18240n);
    expect(parsePriceString(m.last_price)).toEqual(ratio(2n, 10_000_000n));
    expect(m.change_24h).toBe("0.042");
    // 2e-7 ECX-sat per ALPHA-atomic (p=2) → 2e-7 * 1e2 / 1e8 ... display = 2e-13
    expect(displayFromAtomicString("20000", 2, 8)).toEqual(ratio(2n, 100n));
  });
});

describe("createApi", () => {
  it("hits the right URLs and parses responses", async () => {
    const { fn, calls } = fakeFetch({
      "GET /api/markets": { body: [{ base: A, quote: B, last_price: "5", change_24h: null, volume_24h: "0", best_bid: null, best_ask: null }] },
      [`GET /api/markets/${A}/${B}/book`]: { body: { base: A, quote: B, asks: [{ ...offer, offer, outpoint: `${TXID}:3` }], bids: [] } },
      [`GET /api/markets/${A}/${B}/trades`]: { body: [{ txid: TXID, price: 5, price_num: "5", price_den: "1", base_amount: "10", quote_amount: "50", time: 1700000000, maker_side: "ask", confirmed: true }] },
      [`GET /api/markets/${A}/${B}/candles?interval=4h`]: { body: [{ time: 20, open: 1, high: 2, low: 0.5, close: 1.5, volume: "7" }, { time: 10, open: 1, high: 1, low: 1, close: 1, volume: "1" }] },
      "GET /api/health": { body: { ok: true, tip: 12, network: { name: "regtest", genesis_hash: "ff", policy_asset: B } } },
      [`GET /api/quote?sell=${B}&buy=${A}&amount=6000&side=exact_in`]: { body: { offers: [offer], sell_amount: "5000", buy_amount: "1000", price: 5, price_impact_bps: 0, unfilled: "1000" } },
      "POST /api/offers": { status: 201, body: { ...offer, offer, outpoint: `${TXID}:3` } },
      "GET /api/offers?maker=ert1q%2Fx": { body: [] },
    });
    const api = createApi("/api/", fn);
    expect((await api.markets())[0]!.last_price).toBe("5");
    const book = await api.book(A, B);
    expect(book.asks[0]!.vout).toBe(3);
    const trades = await api.trades(A, B);
    expect(trades[0]!.side).toBe("buy");
    expect(trades[0]!.quote_amount).toBe(50n);
    const candles = await api.candles(A, B, "4h");
    expect(candles.map((c) => c.time)).toEqual([10, 20]);
    expect(candles[1]!.volume).toBe(7n);
    const h = await api.health();
    expect(h).toMatchObject({ ok: true, tip: 12, policyAsset: B, network: "regtest" });
    const q = await api.quote({ sell: B, buy: A, amount: 6000n, side: "exact_in" });
    expect(q).toMatchObject({ sellAmount: 5000n, buyAmount: 1000n, unfilled: 1000n, priceImpactBps: 0 });
    expect(q.offers[0]!.tx).toBe(offer.tx);
    const posted = await api.postOffer({ ...offer, extra: 1 } as typeof offer);
    expect(posted?.id).toBe(`${TXID}:3`);
    const sent = JSON.parse(String(calls.find((c) => c.init?.method === "POST")!.init!.body));
    expect(Object.keys(sent).sort()).toEqual(["genesis_hash", "give", "network", "tx", "version", "want"]);
    expect(await api.offersByMaker("ert1q/x")).toEqual([]);
  });

  it("reads flat health and 503 health bodies", async () => {
    const { fn } = fakeFetch({ "GET /api/health": { status: 503, body: { ok: false, tip: null, network: "ecx-beta", genesis_hash: "ff", policy_asset: A } } });
    expect(await createApi("/api", fn).health()).toMatchObject({ ok: false, policyAsset: A, network: "ecx-beta" });
  });

  it("maps errors", async () => {
    const { fn } = fakeFetch({
      "GET /api/assets/x": { status: 400, body: { error: { code: "unknown_asset", message: "asset not registered" } } },
      "GET /api/assets/y": { status: 400, body: { error: "legacy message" } },
      "GET /api/markets": { status: 502, body: "Bad Gateway" },
    });
    const api = createApi("/api", fn);
    await expect(api.asset("x")).rejects.toMatchObject({ message: "asset not registered", code: "unknown_asset", status: 400 });
    await expect(api.asset("y")).rejects.toMatchObject({ message: "legacy message" });
    await expect(api.markets()).rejects.toBeInstanceOf(ApiUnavailableError);
    const down = createApi("/api", () => Promise.reject(new TypeError("Failed to fetch")));
    await expect(down.health()).rejects.toBeInstanceOf(ApiUnavailableError);
    await expect(api.asset("x")).rejects.toBeInstanceOf(ApiError);
  });

  it("unwraps {items, next_cursor} pages and quote entries", async () => {
    const entry = { ...offer, offer, id: 1, outpoint: `${TXID}:3`, txid: TXID, vout: 3, side: "ask", price: 5, price_num: "5", price_den: "1", status: "open" };
    const { fn } = fakeFetch({
      "GET /api/offers?maker=m": { body: { items: [entry], next_cursor: "abc" } },
      [`GET /api/quote?sell=${B}&buy=${A}&amount=1000&side=exact_out`]: { body: { side: "exact_out", sell_asset: B, buy_asset: A, amount: "1000", base: A, quote: B, offers: [entry], sell_amount: "5000", buy_amount: "1000", price: 5, price_impact_bps: 12, unfilled: "0" } },
    });
    const api = createApi("/api", fn);
    expect((await api.offersByMaker("m"))[0]!.id).toBe(`${TXID}:3`);
    const q = await api.quote({ sell: B, buy: A, amount: 1000n, side: "exact_out" });
    expect(Object.keys(q.offers[0]!).sort()).toEqual(["genesis_hash", "give", "network", "tx", "version", "want"]);
    expect(q.priceImpactBps).toBe(12);
  });

  it("rejects malformed payloads", async () => {
    const { fn } = fakeFetch({ "GET /api/markets": { body: { nope: true } } });
    await expect(createApi("/api", fn).markets()).rejects.toBeInstanceOf(ApiParseError);
  });
});
