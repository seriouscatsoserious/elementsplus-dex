// Shared wire + domain types (SPEC §2, §3.3, §4.1).

/** Swap offer (SPEC §2). Amounts are decimal strings of atomic units. */
export interface Offer {
  version: number;
  network: string;
  genesis_hash: string;
  tx: string;
  give: { asset_id: string; amount: string };
  want: { asset_id: string; amount: string };
}

export interface AssetContract {
  name: string;
  ticker: string;
  precision: number;
  version: number;
  issuer_pubkey?: string;
  [k: string]: unknown;
}

export interface AssetEntry {
  asset_id: string;
  token_id: string | null;
  contract: AssetContract;
  issuance_txid: string;
  issuance_vin: number;
  icon_url?: string | null;
}

export interface Market {
  base: string;
  quote: string;
  /** Atomic-unit price (quote atomic per base atomic) as a decimal string. */
  last_price: string | null;
  /** 24h change as a fraction (e.g. "0.042" = +4.2%). */
  change_24h: string | null;
  /** Quote volume, atomic units. */
  volume_24h: bigint;
  best_bid: string | null;
  best_ask: string | null;
}

/** A live offer on the book, normalised. */
export interface BookEntry {
  /** "txid:vout" of the offered UTXO. */
  id: string;
  txid: string;
  vout: number;
  offer: Offer;
  giveAsset: string;
  giveAmount: bigint;
  wantAsset: string;
  wantAmount: bigint;
  maker?: string;
  status?: string;
  createdAt?: number;
}

export interface Book {
  bids: BookEntry[];
  asks: BookEntry[];
}

export interface Trade {
  txid: string;
  /** Atomic-unit price (quote atomic per base atomic), decimal string. */
  price: string;
  base_amount: bigint;
  quote_amount: bigint;
  /** Unix seconds. */
  time: number;
  /** Taker direction, if known: buy = taker bought base (filled an ask). */
  side?: "buy" | "sell";
}

export interface Candle {
  /** Bucket start, unix seconds. */
  time: number;
  /** Atomic-unit prices, decimal strings. */
  open: string;
  high: string;
  low: string;
  close: string;
  /** Base volume, atomic. */
  volume: bigint;
}

export interface Health {
  ok: boolean;
  tip: number | null;
  network: string | null;
  /** Optional: policy asset (ECX) id, if the server advertises it. */
  policyAsset: string | null;
  genesisHash: string | null;
}

export interface Balance {
  assetId: string;
  amount: bigint;
  confirmed: boolean;
}

export interface NetworkInfo {
  name: string;
  genesisHash: string;
  policyAsset: string;
}

export interface IssueResult {
  txid: string;
  assetId: string;
  tokenId?: string | null;
  contract: AssetContract;
  vin: number;
}
