import { describe, expect, it } from "vitest";
import { ratio } from "./amount";
import { stubOfferTxHex } from "./elementsTx";
import { estimateTakeFee, selectRoute, usableOffers } from "./route";
import type { BookEntry } from "./types";

const PAY = "a".repeat(64);
const RECV = "b".repeat(64);
let n = 0;
function offer(give: bigint, want: bigint, giveAsset = RECV, wantAsset = PAY): BookEntry {
  const txid = (++n).toString(16).padStart(64, "0");
  return {
    id: `${txid}:0`,
    txid,
    vout: 0,
    offer: { version: 1, network: "t", genesis_hash: "00", tx: stubOfferTxHex(txid, 0), give: { asset_id: giveAsset, amount: String(give) }, want: { asset_id: wantAsset, amount: String(want) } },
    giveAsset,
    giveAmount: give,
    wantAsset,
    wantAmount: want,
  };
}

describe("selectRoute", () => {
  // unit costs (pay per receive): A=2, B=3, C=2.5, D=10; wrong-direction E ignored
  const A = offer(100n, 200n);
  const B = offer(100n, 300n);
  const C = offer(40n, 100n);
  const D = offer(10n, 100n);
  const E = offer(100n, 1n, PAY, RECV);
  const book = [B, D, E, C, A];

  it("orders usable offers cheapest first and ignores other directions", () => {
    expect(usableOffers(book, PAY, RECV).map((e) => e.id)).toEqual([A, C, B, D].map((e) => e.id));
  });

  it("exact pay: fills greedily and stops before exceeding", () => {
    const r = selectRoute(book, PAY, RECV, "pay", 350n);
    expect(r.fills.map((e) => e.id)).toEqual([A.id, C.id]);
    expect(r.totalPay).toBe(300n);
    expect(r.totalReceive).toBe(140n);
    expect(r.partial).toBe(true);
    expect(r.bestPrice).toEqual(ratio(2n, 1n));
    expect(r.avgPrice).toEqual(ratio(300n, 140n));
    // impact = (300/140 - 2) / 2 = 1/14
    expect(r.impact).toEqual(ratio(1n, 14n));
  });

  it("exact receive: hits the amount exactly when possible", () => {
    const r = selectRoute(book, PAY, RECV, "receive", 240n);
    expect(r.fills.map((e) => e.id)).toEqual([A.id, C.id, B.id]);
    expect(r.totalReceive).toBe(240n);
    expect(r.totalPay).toBe(600n);
    expect(r.partial).toBe(false);
  });

  it("stops at the first offer that would overshoot (no skipping to worse prices)", () => {
    const r = selectRoute(book, PAY, RECV, "receive", 120n);
    expect(r.fills.map((e) => e.id)).toEqual([A.id]);
    expect(r.totalReceive).toBe(100n);
  });

  it("reports too-small and empty cases", () => {
    const r = selectRoute(book, PAY, RECV, "pay", 50n);
    expect(r.fills).toHaveLength(0);
    expect(r.tooSmall).toBe(true);
    expect(r.impact).toBeNull();
    const empty = selectRoute([], PAY, RECV, "pay", 50n);
    expect(empty.tooSmall).toBe(false);
    expect(empty.available).toBe(0n);
    expect(selectRoute(book, PAY, RECV, "pay", 0n).fills).toHaveLength(0);
  });

  it("uses all liquidity when the request exceeds it", () => {
    const r = selectRoute(book, PAY, RECV, "pay", 10_000n);
    expect(r.fills).toHaveLength(4);
    expect(r.totalPay).toBe(700n);
    expect(r.available).toBe(700n);
  });

  it("breaks price ties by larger size", () => {
    const small = offer(10n, 20n);
    const big = offer(1000n, 2000n);
    expect(usableOffers([small, big], PAY, RECV)[0]!.id).toBe(big.id);
  });
});

describe("fee estimate", () => {
  it("grows with offers and is ≥ 1 sat/vB", () => {
    expect(estimateTakeFee(1, true)).toBeGreaterThan(300n);
    expect(estimateTakeFee(3, true)).toBeGreaterThan(estimateTakeFee(1, true));
    expect(estimateTakeFee(1, false)).toBeGreaterThan(estimateTakeFee(1, true));
  });
});
