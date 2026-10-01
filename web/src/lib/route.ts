// Route selection over whole-UTXO offers (no partial fills).
//
// The taker pays asset P and receives asset R, so usable offers are those
// giving R and wanting P. Each offer costs `want` P for `give` R; the unit
// cost want/give (P atomic per R atomic) orders them cheapest-first. We add
// offers greedily and stop before the requested amount would be exceeded.

import { cmpRatio, divRatio, ratio, subRatio, type Ratio } from "./amount";
import type { BookEntry } from "./types";

export type RouteMode = "pay" | "receive";

export interface Route {
  fills: BookEntry[];
  /** Total P paid to makers (atomic). */
  totalPay: bigint;
  /** Total R received (atomic). */
  totalReceive: bigint;
  /** Best available unit cost (P per R, atomic) — first offer on the book. */
  bestPrice: Ratio | null;
  /** Average unit cost of the route (P per R, atomic). */
  avgPrice: Ratio | null;
  /** (avg − best) / best, ≥ 0. */
  impact: Ratio | null;
  /** Requested amount could not be met exactly with whole offers. */
  partial: boolean;
  /** Usable offers exist but none fit under the requested amount. */
  tooSmall: boolean;
  /** Total liquidity in the requested unit across all usable offers. */
  available: bigint;
}

export const unitCost = (e: BookEntry): Ratio => ratio(e.wantAmount, e.giveAmount);

/** Offers giving `receive` and wanting `pay`, cheapest first (ties: larger first, then id). */
export function usableOffers(entries: BookEntry[], pay: string, receive: string): BookEntry[] {
  return entries
    .filter((e) => e.giveAsset === receive && e.wantAsset === pay && e.giveAmount > 0n && e.wantAmount > 0n)
    .sort((a, b) => {
      const c = cmpRatio(unitCost(a), unitCost(b));
      if (c !== 0) return c;
      if (a.giveAmount !== b.giveAmount) return a.giveAmount > b.giveAmount ? -1 : 1;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
}

export function selectRoute(entries: BookEntry[], pay: string, receive: string, mode: RouteMode, amount: bigint): Route {
  const offers = usableOffers(entries, pay, receive);
  const available = offers.reduce((s, e) => s + (mode === "pay" ? e.wantAmount : e.giveAmount), 0n);
  const fills: BookEntry[] = [];
  let totalPay = 0n;
  let totalReceive = 0n;
  if (amount > 0n) {
    for (const e of offers) {
      const nextPay = totalPay + e.wantAmount;
      const nextRecv = totalReceive + e.giveAmount;
      if ((mode === "pay" ? nextPay : nextRecv) > amount) break;
      fills.push(e);
      totalPay = nextPay;
      totalReceive = nextRecv;
      if ((mode === "pay" ? totalPay : totalReceive) === amount) break;
    }
  }
  const first = offers[0];
  const bestPrice = first ? unitCost(first) : null;
  const avgPrice = fills.length ? ratio(totalPay, totalReceive) : null;
  const impact = bestPrice && avgPrice ? divRatio(subRatio(avgPrice, bestPrice), bestPrice) : null;
  const reached = mode === "pay" ? totalPay : totalReceive;
  return {
    fills,
    totalPay,
    totalReceive,
    bestPrice,
    avgPrice,
    impact,
    partial: amount > 0n && reached < amount,
    tooSmall: amount > 0n && offers.length > 0 && fills.length === 0,
    available,
  };
}

/** Same set of offers (by outpoint) — used to detect re-quotes. */
export const sameFills = (a: BookEntry[], b: BookEntry[]): boolean =>
  a.length === b.length && a.every((e, i) => e.id === b[i]?.id);

// ------------------------------------------------------------ fee estimate

/** Wallet floor (SPEC §1.2: min 1 sat/vB). */
export const FEE_RATE_SAT_VB = 1n;
// Explicit (unblinded) Elements sizes, segwit v0 P2WPKH, conservative.
const TX_OVERHEAD_VB = 12n;
const INPUT_VB = 70n; // outpoint+sequence+issuance flag+witness(sig,pubkey)/4
const OUTPUT_VB = 67n; // explicit asset(33)+value(9)+nonce(1)+script(~23)+len
const FEE_OUTPUT_VB = 44n;

export function estimateVsize(inputs: number, outputs: number): bigint {
  return TX_OVERHEAD_VB + BigInt(inputs) * INPUT_VB + BigInt(outputs) * OUTPUT_VB + FEE_OUTPUT_VB;
}

/** Taker tx: n maker in/out pairs + taker inputs (pay asset, fee) + receive outputs + 2 change. */
export function estimateTakeFee(nOffers: number, payIsPolicy: boolean): bigint {
  const takerInputs = payIsPolicy ? 1 : 2;
  const outputs = nOffers /* maker */ + nOffers /* taker receives */ + (payIsPolicy ? 1 : 2) /* change */;
  return estimateVsize(nOffers + takerInputs, outputs) * FEE_RATE_SAT_VB;
}

/** Issuance: 1 policy input; asset (+token) outputs + change. */
export function estimateIssuanceFee(withToken: boolean): bigint {
  return (estimateVsize(1, withToken ? 3 : 2) + 66n /* issuance fields */) * FEE_RATE_SAT_VB;
}

/** Split self-send that may precede an offer. */
export function estimateSplitFee(): bigint {
  return estimateVsize(2, 3) * FEE_RATE_SAT_VB;
}
