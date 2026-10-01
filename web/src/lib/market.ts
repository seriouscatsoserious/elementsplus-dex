// Market orientation helpers: base/quote, book sides, atomic ↔ display prices.

import { atomicToDisplayPrice, cmpRatio, pow10, ratio, type Ratio } from "./amount";
import type { Book, BookEntry } from "./types";

/** Parse a server price string (decimal, optional exponent) into an exact Ratio. */
export function parsePriceString(s: string | null | undefined): Ratio | null {
  if (s == null) return null;
  const m = /^(-?)(\d*)(?:\.(\d*))?(?:e([-+]?\d+))?$/i.exec(s.trim());
  if (!m || (!m[2] && !m[3])) return null;
  const frac = m[3] ?? "";
  let num = BigInt((m[2] ?? "") + frac || "0");
  let den = pow10(frac.length);
  const exp = Number(m[4] ?? 0);
  if (exp > 0) num *= pow10(exp);
  else if (exp < 0) den *= pow10(-exp);
  if (m[1] === "-") num = -num;
  return ratio(num, den);
}

/** Server atomic price string → display price ratio. */
export function displayFromAtomicString(s: string | null | undefined, bp: number, qp: number): Ratio | null {
  const r = parsePriceString(s);
  return r ? atomicToDisplayPrice(r, bp, qp) : null;
}

export const isAsk = (e: BookEntry, base: string): boolean => e.giveAsset === base;

/** Atomic price (quote atomic per base atomic) of an entry. */
export function entryAtomicPrice(e: BookEntry, base: string): Ratio {
  return isAsk(e, base) ? ratio(e.wantAmount, e.giveAmount) : ratio(e.giveAmount, e.wantAmount);
}
export const entryBaseAmount = (e: BookEntry, base: string): bigint => (isAsk(e, base) ? e.giveAmount : e.wantAmount);
export const entryQuoteAmount = (e: BookEntry, base: string): bigint => (isAsk(e, base) ? e.wantAmount : e.giveAmount);

/**
 * Re-sort a book by price (asks ascending, bids descending), and re-file any
 * entry the server put on the wrong side.
 */
export function orientBook(book: Book, base: string, quote: string): { asks: BookEntry[]; bids: BookEntry[] } {
  const all = [...book.asks, ...book.bids];
  const asks = all.filter((e) => e.giveAsset === base && e.wantAsset === quote);
  const bids = all.filter((e) => e.giveAsset === quote && e.wantAsset === base);
  asks.sort((a, b) => cmpRatio(entryAtomicPrice(a, base), entryAtomicPrice(b, base)));
  bids.sort((a, b) => cmpRatio(entryAtomicPrice(b, base), entryAtomicPrice(a, base)));
  return { asks, bids };
}

/** Canonical market orientation for two assets: quote is the policy asset when present. */
export function orientPair(a: string, b: string, policy: string | null): { base: string; quote: string } {
  if (policy && b === policy) return { base: a, quote: b };
  if (policy && a === policy) return { base: b, quote: a };
  return a < b ? { base: a, quote: b } : { base: b, quote: a };
}
