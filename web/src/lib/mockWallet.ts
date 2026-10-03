// Mock `window.elementsplus` provider — only installed when VITE_MOCK_WALLET=1.
// URL flags: ?wallet=none (not installed) | disconnected | locked | reject

import { pendingIssued, pendingOffers } from "./mock/api";
import { ECX, GENESIS, WALLET_ADDRESS, fakeHex, makeOffer, state } from "./mock/state";
import type { ElementsPlusProvider } from "./wallet";
import type { Offer } from "./types";

const flags = new URLSearchParams(location.search);
const walletMode = flags.get("wallet");

const err = (code: number, message: string) => Object.assign(new Error(message), { code });
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const bal = (id: string) => state.balances.get(id) ?? 0n;
const addBal = (id: string, d: bigint) => state.balances.set(id, bal(id) + d);

export function installMockWallet(): void {
  if (walletMode === "none") return;
  let connected = walletMode !== "disconnected";
  const listeners = new Map<string, Set<(...a: unknown[]) => void>>();
  const emit = (ev: string, ...a: unknown[]) => listeners.get(ev)?.forEach((h) => h(...a));

  const approve = async () => {
    await wait(700);
    if (walletMode === "reject") throw err(4001, "User rejected the request");
    if (walletMode === "locked") throw err(-32603, "Wallet is locked");
  };
  const needConn = () => {
    if (!connected) throw err(4100, "Not connected");
  };

  const provider: ElementsPlusProvider = {
    isElementsPlus: true,
    on(ev, h) {
      if (!listeners.has(ev)) listeners.set(ev, new Set());
      listeners.get(ev)!.add(h);
    },
    removeListener(ev, h) {
      listeners.get(ev)?.delete(h);
    },
    async request({ method, params }) {
      const p = (params ?? {}) as Record<string, unknown>;
      switch (method) {
        case "ep_connect":
          await wait(500);
          if (walletMode === "reject") throw err(4001, "User rejected the request");
          connected = true;
          emit("accountsChanged", [WALLET_ADDRESS]);
          return { address: WALLET_ADDRESS, network: { name: "Demo (simulated)", genesisHash: GENESIS, policyAsset: ECX } };
        case "ep_disconnect":
          connected = false;
          emit("disconnect");
          return null;
        case "ep_getAddress":
          needConn();
          return { address: WALLET_ADDRESS };
        case "ep_getBalances":
          needConn();
          return [...state.balances].filter(([, v]) => v > 0n).map(([assetId, v]) => ({ assetId, amount: v.toString(), confirmed: true }));
        case "ep_takeSwapOffers": {
          needConn();
          const offers = (p.offers ?? []) as Offer[];
          await approve();
          for (const o of offers) {
            const key = [...state.offers].find(([, m]) => m.offer.tx === o.tx)?.[0];
            if (!key) throw err(-32603, "Offer no longer available");
          }
          const txid = fakeHex(`take-${Date.now()}`);
          const now = Math.floor(Date.now() / 1000);
          for (const o of offers) {
            const key = [...state.offers].find(([, m]) => m.offer.tx === o.tx)![0];
            state.offers.delete(key);
            addBal(o.want.asset_id, -BigInt(o.want.amount));
            addBal(o.give.asset_id, BigInt(o.give.amount));
            const isAsk = o.want.asset_id === ECX;
            const base = isAsk ? o.give : o.want;
            const quote = isAsk ? o.want : o.give;
            state.trades.push({ base: base.asset_id, quote: quote.asset_id, txid, base_amount: BigInt(base.amount), quote_amount: BigInt(quote.amount), time: now, makerSide: isAsk ? "ask" : "bid" });
          }
          addBal(ECX, -BigInt(300 + offers.length * 200));
          return { txid };
        }
        case "ep_makeSwapOffer": {
          needConn();
          const give = String(p.giveAsset);
          const giveAmount = BigInt(String(p.giveAmount));
          if (bal(give) < giveAmount) throw err(-32602, "Insufficient balance");
          await approve();
          const m = makeOffer(give, giveAmount, String(p.wantAsset), BigInt(String(p.wantAmount)), WALLET_ADDRESS);
          // The mock API re-adds it on POST /offers; remove so the publish step is real.
          state.offers.delete(`${m.txid}:${m.vout}`);
          pendingOffers.set(`${m.txid}:${m.vout}`, WALLET_ADDRESS);
          return { offer: m.offer, splitTxid: fakeHex(`split-${m.txid}`) };
        }
        case "ep_cancelSwapOffer": {
          needConn();
          await approve();
          const key = `${String(p.txid)}:${String(p.vout)}`;
          if (!state.offers.has(key)) throw err(-32602, "Unknown outpoint");
          state.offers.delete(key);
          return { txid: fakeHex(`cancel-${key}`) };
        }
        case "ep_issueAsset": {
          needConn();
          await approve();
          const txid = fakeHex(`issue-${Date.now()}`);
          const assetId = fakeHex(`asset-${p.ticker}-${txid}`);
          const tokenId = BigInt(String(p.tokenAmount)) > 0n ? fakeHex(`token-${assetId}`) : null;
          addBal(assetId, BigInt(String(p.amount)));
          pendingIssued.set(txid, { assetId, tokenId });
          return {
            txid,
            assetId,
            tokenId,
            vin: 0,
            contract: { name: p.name, ticker: p.ticker, precision: p.precision, version: 0, issuer_pubkey: fakeHex("pk").slice(0, 66) },
          };
        }
        default:
          throw err(4200, `Unsupported method ${method}`);
      }
    },
  };
  window.elementsplus = provider;
  window.dispatchEvent(new Event("elementsplus#initialized"));
}
