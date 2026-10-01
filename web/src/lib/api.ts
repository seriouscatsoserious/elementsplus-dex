// Typed client for the DEX server (SPEC §4.1). Responses are parsed
// defensively: amounts may arrive as strings or integers and are converted to
// BigInt; anything malformed throws ApiParseError rather than leaking `any`.

import { firstInputOutpoint } from "./elementsTx";
import type {
  AssetContract,
  AssetEntry,
  Book,
  BookEntry,
  Candle,
  Health,
  Market,
  Offer,
  Trade,
} from "./types";

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body?: unknown,
    /** Stable machine code from `{ error: { code, message } }`, when given. */
    readonly code?: string,
  ) {
    super(message);
  }
}
/** Server unreachable (network error / proxy 502-504). */
export class ApiUnavailableError extends ApiError {}
export class ApiParseError extends Error {}

type Json = unknown;
type Obj = Record<string, unknown>;

// ------------------------------------------------------------ parse helpers

function isObj(v: Json): v is Obj {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function obj(v: Json, what: string): Obj {
  if (!isObj(v)) throw new ApiParseError(`${what}: expected object`);
  return v;
}
function arr(v: Json, what: string): unknown[] {
  if (!Array.isArray(v)) throw new ApiParseError(`${what}: expected array`);
  return v;
}
function str(v: Json, what: string): string {
  if (typeof v !== "string") throw new ApiParseError(`${what}: expected string`);
  return v;
}
function optStr(v: Json, what: string): string | null {
  if (v === undefined || v === null) return null;
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return str(v, what);
}
function num(v: Json, what: string): number {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  throw new ApiParseError(`${what}: expected number`);
}
/** Atomic amount: decimal string (preferred) or safe integer. */
export function atomic(v: Json, what: string): bigint {
  if (typeof v === "string" && /^\d+$/.test(v)) return BigInt(v);
  if (typeof v === "number" && Number.isSafeInteger(v) && v >= 0) return BigInt(v);
  if (typeof v === "bigint" && v >= 0n) return v;
  throw new ApiParseError(`${what}: expected atomic amount`);
}
/** Price: decimal string or number → canonical string. */
function priceStr(v: Json, what: string): string {
  if (typeof v === "string" && /^-?\d*\.?\d+(e[-+]?\d+)?$/i.test(v.trim())) return v.trim();
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  throw new ApiParseError(`${what}: expected price`);
}
/** Time: unix seconds, unix ms, or ISO string → unix seconds. */
function time(v: Json, what: string): number {
  if (typeof v === "string" && !/^\d+$/.test(v)) {
    const t = Date.parse(v);
    if (Number.isNaN(t)) throw new ApiParseError(`${what}: bad time`);
    return Math.floor(t / 1000);
  }
  const n = num(v, what);
  return n > 1e12 ? Math.floor(n / 1000) : Math.floor(n);
}
const HEX64 = /^[0-9a-f]{64}$/i;
function hex64(v: Json, what: string): string {
  const s = str(v, what);
  if (!HEX64.test(s)) throw new ApiParseError(`${what}: expected 32-byte hex`);
  return s.toLowerCase();
}

// ------------------------------------------------------------ entity parsers

export function parseOffer(v: Json): Offer {
  const o = obj(v, "offer");
  const g = obj(o.give, "offer.give");
  const w = obj(o.want, "offer.want");
  return {
    version: num(o.version ?? 1, "offer.version"),
    network: str(o.network, "offer.network"),
    genesis_hash: str(o.genesis_hash, "offer.genesis_hash"),
    tx: str(o.tx, "offer.tx"),
    give: { asset_id: hex64(g.asset_id, "give.asset_id"), amount: atomic(g.amount, "give.amount").toString() },
    want: { asset_id: hex64(w.asset_id, "want.asset_id"), amount: atomic(w.amount, "want.amount").toString() },
  };
}

/** Strip any server-side extras so wallets receive exactly the §2 shape. */
export function cleanOffer(o: Offer): Offer {
  return {
    version: o.version,
    network: o.network,
    genesis_hash: o.genesis_hash,
    tx: o.tx,
    give: { asset_id: o.give.asset_id, amount: o.give.amount },
    want: { asset_id: o.want.asset_id, amount: o.want.amount },
  };
}

/**
 * Book / open-offer entry. Accepts either `{ offer: Offer, ...extras }` or a
 * flattened `Offer & extras`. Outpoint comes from `txid`/`vout`, `outpoint`
 * ("txid:vout"), or is read from the offer tx itself.
 */
export function parseBookEntry(v: Json): BookEntry {
  const o = obj(v, "book entry");
  const offer = parseOffer(isObj(o.offer) ? o.offer : o);
  let txid: string | undefined;
  let vout: number | undefined;
  if (typeof o.outpoint === "string" && o.outpoint.includes(":")) {
    const [t, i] = o.outpoint.split(":");
    txid = t;
    vout = Number(i);
  } else if (typeof o.txid === "string" && o.vout !== undefined && HEX64.test(o.txid)) {
    txid = o.txid;
    vout = num(o.vout, "vout");
  } else if (typeof o.input_txid === "string" && o.input_vout !== undefined) {
    txid = o.input_txid;
    vout = num(o.input_vout, "input_vout");
  }
  if (!txid || vout === undefined || !Number.isInteger(vout)) {
    try {
      ({ txid, vout } = firstInputOutpoint(offer.tx));
    } catch (e) {
      throw new ApiParseError(`book entry: cannot determine outpoint (${(e as Error).message})`);
    }
  }
  const maker = optStr(o.maker ?? o.maker_address, "maker") ?? undefined;
  const status = optStr(o.status, "status") ?? undefined;
  const createdRaw = o.created_at ?? o.time;
  return {
    id: `${txid.toLowerCase()}:${vout}`,
    txid: txid.toLowerCase(),
    vout,
    offer,
    giveAsset: offer.give.asset_id,
    giveAmount: BigInt(offer.give.amount),
    wantAsset: offer.want.asset_id,
    wantAmount: BigInt(offer.want.amount),
    maker,
    status,
    createdAt: createdRaw === undefined || createdRaw === null ? undefined : time(createdRaw, "created_at"),
  };
}

function parseContract(v: Json): AssetContract {
  const c = obj(v, "contract");
  const precision = num(c.precision ?? 0, "contract.precision");
  if (!Number.isInteger(precision) || precision < 0 || precision > 8) throw new ApiParseError("contract.precision out of range");
  return { ...c, name: str(c.name, "contract.name"), ticker: str(c.ticker, "contract.ticker"), precision, version: num(c.version ?? 0, "contract.version") };
}

export function parseAsset(v: Json): AssetEntry {
  const o = obj(v, "asset");
  return {
    asset_id: hex64(o.asset_id, "asset_id"),
    token_id: o.token_id ? hex64(o.token_id, "token_id") : null,
    contract: parseContract(typeof o.contract === "string" ? JSON.parse(o.contract) : o.contract),
    issuance_txid: str(o.issuance_txid, "issuance_txid"),
    issuance_vin: num(o.issuance_vin ?? o.vin ?? 0, "issuance_vin"),
    icon_url: optStr(o.icon_url, "icon_url"),
  };
}

export function parseMarket(v: Json): Market {
  const o = obj(v, "market");
  return {
    base: hex64(o.base, "market.base"),
    quote: hex64(o.quote, "market.quote"),
    last_price: o.last_price == null ? null : priceStr(o.last_price, "last_price"),
    change_24h: o.change_24h == null ? null : priceStr(o.change_24h, "change_24h"),
    volume_24h: o.volume_24h == null ? 0n : atomic(o.volume_24h, "volume_24h"),
    best_bid: o.best_bid == null ? null : priceStr(o.best_bid, "best_bid"),
    best_ask: o.best_ask == null ? null : priceStr(o.best_ask, "best_ask"),
  };
}

export function parseBook(v: Json): Book {
  const o = obj(v, "book");
  return {
    bids: arr(o.bids ?? [], "bids").map(parseBookEntry),
    asks: arr(o.asks ?? [], "asks").map(parseBookEntry),
  };
}

export function parseTrade(v: Json): Trade {
  const o = obj(v, "trade");
  return {
    txid: str(o.txid, "trade.txid"),
    price: priceStr(o.price, "trade.price"),
    base_amount: atomic(o.base_amount, "trade.base_amount"),
    quote_amount: atomic(o.quote_amount, "trade.quote_amount"),
    time: time(o.time, "trade.time"),
    side: o.maker_side === "ask" ? "buy" : o.maker_side === "bid" ? "sell" : o.side === "buy" || o.side === "sell" ? o.side : undefined,
  };
}

export function parseCandle(v: Json): Candle {
  // Accept object form or [time, o, h, l, c, v] tuples.
  if (Array.isArray(v)) {
    const [t, op, h, l, c, vol] = v;
    return { time: time(t, "candle.time"), open: priceStr(op, "o"), high: priceStr(h, "h"), low: priceStr(l, "l"), close: priceStr(c, "c"), volume: vol == null ? 0n : atomic(vol, "v") };
  }
  const o = obj(v, "candle");
  return {
    time: time(o.time ?? o.t, "candle.time"),
    open: priceStr(o.open ?? o.o, "candle.open"),
    high: priceStr(o.high ?? o.h, "candle.high"),
    low: priceStr(o.low ?? o.l, "candle.low"),
    close: priceStr(o.close ?? o.c, "candle.close"),
    volume: (o.volume ?? o.v) == null ? 0n : atomic(o.volume ?? o.v, "candle.volume"),
  };
}

/** Lists may be bare arrays or wrapped (`{ markets: [...] }`, `{ items: [...] }`). */
function list(v: Json, key: string): unknown[] {
  if (Array.isArray(v)) return v;
  if (isObj(v)) {
    const inner = v[key] ?? v.items ?? v.data;
    if (Array.isArray(inner)) return inner;
  }
  throw new ApiParseError(`${key}: expected array`);
}

// ------------------------------------------------------------ client

/** Error body: `{ error: { code, message } }` (preferred), `{ error: "msg" }`, `{ message }` or text. */
export function errorFromBody(body: Json, status: number): { message: string; code?: string } {
  if (isObj(body)) {
    const e = body.error;
    if (isObj(e)) {
      const code = typeof e.code === "string" ? e.code : undefined;
      const message = typeof e.message === "string" && e.message ? e.message : (code ?? `HTTP ${status}`);
      return { message, code };
    }
    if (typeof e === "string" && e) return { message: e, code: typeof body.code === "string" ? body.code : undefined };
    if (typeof body.message === "string" && body.message) return { message: body.message };
  }
  if (typeof body === "string" && body && body.length < 200) return { message: body };
  return { message: `HTTP ${status}` };
}

export function parseHealth(v: Json): Health {
  const o = obj(v, "health");
  // Accept flat `{ policy_asset, genesis_hash, network: "name" }` or nested `network: { ... }`.
  const n = isObj(o.network) ? o.network : {};
  const pa = o.policy_asset ?? o.policyAsset ?? n.policy_asset ?? n.policyAsset;
  const gh = o.genesis_hash ?? o.genesisHash ?? n.genesis_hash ?? n.genesisHash;
  const name = typeof o.network === "string" ? o.network : typeof n.name === "string" ? n.name : null;
  return {
    ok: o.ok === true,
    tip: o.tip == null ? null : num(o.tip, "tip"),
    network: name,
    policyAsset: typeof pa === "string" && HEX64.test(pa) ? pa.toLowerCase() : null,
    genesisHash: typeof gh === "string" ? gh : null,
  };
}

export type QuoteSide = "exact_in" | "exact_out";

export interface QuoteRequest {
  sell: string;
  buy: string;
  /** exact_in: amount of `sell`; exact_out: amount of `buy` (atomic). */
  amount: bigint;
  side: QuoteSide;
}

export interface Quote {
  offers: Offer[];
  sellAmount: bigint;
  buyAmount: bigint;
  /** Server-reported average price (informational). */
  price: string | null;
  priceImpactBps: number;
  /** Requested amount that whole offers could not cover (atomic, requested unit). */
  unfilled: bigint;
}

export function parseQuote(v: Json): Quote {
  const o = obj(v, "quote");
  return {
    offers: arr(o.offers ?? [], "quote.offers").map((x) => parseOffer(isObj(x) && isObj(x.offer) ? x.offer : x)),
    sellAmount: o.sell_amount == null ? 0n : atomic(o.sell_amount, "sell_amount"),
    buyAmount: o.buy_amount == null ? 0n : atomic(o.buy_amount, "buy_amount"),
    price: o.price == null ? null : priceStr(o.price, "quote.price"),
    priceImpactBps: o.price_impact_bps == null ? 0 : num(o.price_impact_bps, "price_impact_bps"),
    unfilled: o.unfilled == null ? 0n : atomic(o.unfilled, "unfilled"),
  };
}

export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

export interface PostAssetBody {
  issuance_txid: string;
  vin: number;
  contract: AssetContract;
  /** Optional off-chain metadata (not committed in the contract). */
  description?: string;
  website?: string;
}

export interface DexApi {
  health(): Promise<Health>;
  quote(r: QuoteRequest): Promise<Quote>;
  assets(): Promise<AssetEntry[]>;
  asset(id: string): Promise<AssetEntry>;
  registerAsset(body: PostAssetBody): Promise<AssetEntry | null>;
  markets(): Promise<Market[]>;
  book(base: string, quote: string): Promise<Book>;
  trades(base: string, quote: string): Promise<Trade[]>;
  candles(base: string, quote: string, interval?: string): Promise<Candle[]>;
  postOffer(offer: Offer): Promise<BookEntry | null>;
  offersByMaker(maker: string): Promise<BookEntry[]>;
}

export function createApi(baseUrl: string, fetchFn: FetchFn = (i, init) => fetch(i, init)): DexApi {
  const base = baseUrl.replace(/\/+$/, "");

  async function call(path: string, init?: RequestInit): Promise<Json> {
    let res: Response;
    try {
      res = await fetchFn(base + path, {
        ...init,
        headers: { Accept: "application/json", ...(init?.body ? { "Content-Type": "application/json" } : {}), ...init?.headers },
      });
    } catch (e) {
      throw new ApiUnavailableError(`DEX server unreachable (${(e as Error).message})`, 0);
    }
    const text = await res.text();
    let body: Json = null;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
    }
    if (!res.ok) {
      const { message, code } = errorFromBody(body, res.status);
      const Cls = res.status >= 502 && res.status <= 504 ? ApiUnavailableError : ApiError;
      throw new Cls(message, res.status, body, code);
    }
    return body;
  }
  const seg = encodeURIComponent;

  return {
    async health() {
      try {
        return parseHealth(await call("/health"));
      } catch (e) {
        // 503 still carries network info when only the explorer is down.
        if (e instanceof ApiError && isObj(e.body) && "ok" in e.body) return parseHealth(e.body);
        throw e;
      }
    },
    async quote(r) {
      const qs = `sell=${seg(r.sell)}&buy=${seg(r.buy)}&amount=${r.amount.toString()}&side=${r.side}`;
      return parseQuote(await call(`/quote?${qs}`));
    },
    async assets() {
      return list(await call("/assets"), "assets").map(parseAsset);
    },
    async asset(id) {
      return parseAsset(await call(`/assets/${seg(id)}`));
    },
    async registerAsset(body) {
      const r = await call("/assets", { method: "POST", body: JSON.stringify(body) });
      try {
        return parseAsset(isObj(r) && isObj(r.asset) ? r.asset : r);
      } catch {
        return null;
      }
    },
    async markets() {
      return list(await call("/markets"), "markets").map(parseMarket);
    },
    async book(b, q) {
      return parseBook(await call(`/markets/${seg(b)}/${seg(q)}/book`));
    },
    async trades(b, q) {
      return list(await call(`/markets/${seg(b)}/${seg(q)}/trades`), "trades").map(parseTrade);
    },
    async candles(b, q, interval = "1h") {
      return list(await call(`/markets/${seg(b)}/${seg(q)}/candles?interval=${seg(interval)}`), "candles")
        .map(parseCandle)
        .sort((x, y) => x.time - y.time);
    },
    async postOffer(offer) {
      const r = await call("/offers", { method: "POST", body: JSON.stringify(cleanOffer(offer)) });
      try {
        return parseBookEntry(r);
      } catch {
        return null;
      }
    },
    async offersByMaker(maker) {
      return list(await call(`/offers?maker=${seg(maker)}`), "offers").map(parseBookEntry);
    },
  };
}
