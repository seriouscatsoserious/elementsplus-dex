import { describe, expect, it } from "vitest";
import { stubOfferTxHex } from "./elementsTx";
import { validateLaunch } from "./launch";
import { WalletClient, WalletError, describeWalletError, toWalletError, type ElementsPlusProvider } from "./wallet";

const A = "a".repeat(64);
function provider(handler: (m: string, p: unknown) => unknown): ElementsPlusProvider & { calls: { method: string; params?: unknown }[] } {
  const calls: { method: string; params?: unknown }[] = [];
  return {
    isElementsPlus: true,
    calls,
    async request(args) {
      calls.push(args);
      return handler(args.method, args.params);
    },
    on() {},
    removeListener() {},
  };
}

describe("wallet wrapper", () => {
  it("maps provider errors", () => {
    expect(describeWalletError({ code: 4001, message: "x" }).quiet).toBe(true);
    expect(describeWalletError({ code: 4100, message: "x" }).title).toMatch(/not connected/);
    expect(describeWalletError({ code: -32603, message: "Wallet is locked" }).title).toMatch(/locked/);
    expect(toWalletError("boom")).toBeInstanceOf(WalletError);
  });

  it("serialises amounts as strings and parses results", async () => {
    const offer = { version: 1, network: "n", genesis_hash: "00", tx: stubOfferTxHex(A, 0), give: { asset_id: A, amount: "5" }, want: { asset_id: A, amount: "6" } };
    const p = provider((m) => {
      if (m === "ep_getBalances") return [{ assetId: A.toUpperCase(), amount: "123", confirmed: true }];
      if (m === "ep_makeSwapOffer") return { offer, splitTxid: "s" };
      if (m === "ep_takeSwapOffers") return { txid: "t" };
      throw { code: 4200, message: "unsupported" };
    });
    const w = new WalletClient(p);
    expect(await w.getBalances()).toEqual([{ assetId: A, amount: 123n, confirmed: true }]);
    const r = await w.makeSwapOffer({ giveAsset: A, giveAmount: 5n, wantAsset: A, wantAmount: 6n });
    expect(p.calls[1]!.params).toEqual({ giveAsset: A, giveAmount: "5", wantAsset: A, wantAmount: "6" });
    expect(r.splitTxid).toBe("s");
    expect(await w.takeSwapOffers([{ ...offer, junk: 1 } as typeof offer])).toEqual({ txid: "t" });
    expect(Object.keys((p.calls[2]!.params as { offers: object[] }).offers[0]!)).not.toContain("junk");
    await expect(w.cancelSwapOffer(A, 0)).rejects.toMatchObject({ code: 4200 });
  });
});

describe("launch validation (server rules)", () => {
  const ok = { name: "Nova", ticker: "NOVA", supply: "21000000", decimals: "8", website: "", list: true, listAmount: "2100000", listPrice: "0.003" };
  it("accepts valid input", () => expect(validateLaunch(ok)).toEqual({}));
  it("enforces name/ticker/precision/supply", () => {
    expect(validateLaunch({ ...ok, name: " " }).name).toBeDefined();
    expect(validateLaunch({ ...ok, name: "x".repeat(256) }).name).toBeDefined();
    expect(validateLaunch({ ...ok, ticker: "AB" }).ticker).toBeDefined();
    expect(validateLaunch({ ...ok, ticker: "A".repeat(25) }).ticker).toBeDefined();
    expect(validateLaunch({ ...ok, ticker: "NO_VA" }).ticker).toBeDefined();
    expect(validateLaunch({ ...ok, ticker: "n.o-1" }).ticker).toBeUndefined();
    expect(validateLaunch({ ...ok, decimals: "9" }).decimals).toBeDefined();
    expect(validateLaunch({ ...ok, decimals: "0", supply: "1.5" }).supply).toBeDefined();
    expect(validateLaunch({ ...ok, supply: "21000001" }).supply).toBeDefined(); // > MAX_MONEY at 8 dp
    expect(validateLaunch({ ...ok, listAmount: "30000000" }).listAmount).toBeDefined();
    expect(validateLaunch({ ...ok, listPrice: "0" }).listPrice).toBeDefined();
    expect(validateLaunch({ ...ok, website: "ftp://x" }).website).toBeDefined();
    expect(validateLaunch({ ...ok, list: false, listAmount: "", listPrice: "" })).toEqual({});
  });
});
