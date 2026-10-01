import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { PriceChart, toChartPoints } from "../components/PriceChart";
import { TokenPicker } from "../components/TokenPicker";
import { CopyText, Skeleton, StateBox, TokenIcon } from "../components/ui";
import {
  atomicToDisplayPrice,
  cmpRatio,
  displayPrice,
  divRatio,
  formatCompact,
  formatPercent,
  formatPrice,
  formatUnits,
  isDecimalInput,
  quoteForBase,
  ratio,
  ratioToDecimal,
  subRatio,
  toInputString,
  tryParseDecimalRatio,
  tryParseUnits,
  type Ratio,
} from "../lib/amount";
import { ApiUnavailableError } from "../lib/api";
import { useQuery } from "../lib/hooks";
import { displayFromAtomicString, parsePriceString, entryAtomicPrice, entryBaseAmount, entryQuoteAmount, orientBook, orientPair } from "../lib/market";
import { forgetOffer, loadMyOffers, rememberOffer } from "../lib/myOffers";
import { estimateSplitFee, estimateTakeFee } from "../lib/route";
import { useDebounced } from "../lib/hooks";
import type { Quote } from "../lib/api";
import type { BookEntry, Market, Offer, Trade } from "../lib/types";
import { shortId } from "../lib/wallet";
import { api } from "../state/api";
import { useDex, type AssetInfo } from "../state/dex";
import { useToast } from "../state/toast";
import { useWallet } from "../state/wallet";
import { parseBookEntry } from "../lib/api";

// ---------------------------------------------------------------- helpers

function changeClass(c: string | null): string | undefined {
  const n = c == null ? 0 : Number(c);
  return n > 0 ? "up" : n < 0 ? "dn" : undefined;
}
/** `change_24h` is a fraction (0.042 = +4.2%). */
function formatChange(c: string | null): string {
  const r = parsePriceString(c);
  if (!r) return "—";
  const s = formatPercent(r, 1).replace("-", "");
  return (r.num > 0n ? "+" : r.num < 0n ? "−" : "") + s;
}
function timeAgo(t: number): string {
  const s = Math.max(0, Math.floor(Date.now() / 1000 - t));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return new Date(t * 1000).toLocaleDateString();
}

function toRoute(qt: Quote) {
  return {
    fills: qt.offers,
    totalPay: qt.sellAmount,
    totalReceive: qt.buyAmount,
    avgPrice: qt.offers.length && qt.buyAmount > 0n ? ratio(qt.sellAmount, qt.buyAmount) : null,
    partial: qt.unfilled > 0n,
  };
}

// ---------------------------------------------------------------- market list

function MarketList({ current, onNew }: { current: { base: string; quote: string } | null; onNew: () => void }) {
  const dex = useDex();
  const nav = useNavigate();
  const [q, setQ] = useState("");
  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (dex.markets ?? [])
      .map((m) => ({ m, b: dex.info(m.base), qi: dex.info(m.quote) }))
      .filter(({ m, b, qi }) => !needle || b.ticker.toLowerCase().includes(needle) || qi.ticker.toLowerCase().includes(needle) || b.name.toLowerCase().includes(needle) || m.base.includes(needle) || m.quote.includes(needle))
      .sort((a, b) => (b.m.volume_24h > a.m.volume_24h ? 1 : b.m.volume_24h < a.m.volume_24h ? -1 : a.b.ticker.localeCompare(b.b.ticker)));
  }, [dex, q]);

  return (
    <aside className="col markets-col">
      <label>
        <span className="sr-only">Search markets</span>
        <input className="search" placeholder="Search tokens or asset ID" value={q} onChange={(e) => setQ(e.target.value)} />
      </label>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div className="h">Markets</div>
        <button type="button" className="linkish" style={{ fontSize: 12 }} onClick={onNew}>
          + New market
        </button>
      </div>
      <div className="mk-list">
        {dex.marketsLoading && !dex.markets && [0, 1, 2, 3].map((i) => <div key={i} style={{ padding: "9px 8px" }}><Skeleton h={16} /></div>)}
        {dex.marketsError != null && !dex.markets && <StateBox title="Couldn't load markets" detail={dex.marketsError instanceof ApiUnavailableError ? "DEX server unreachable." : String((dex.marketsError as Error).message)} />}
        {dex.markets && dex.markets.length === 0 && <StateBox title="No markets yet" detail="Markets appear once someone places an order." />}
        {dex.markets && dex.markets.length > 0 && rows.length === 0 && <StateBox title="No matches" detail="Try a ticker or an asset ID prefix." />}
        {rows.map(({ m, b, qi }) => {
          // Same ticker on different assets: show the id so look-alikes can't hide.
          const dup = rows.some((o) => o.m.base !== m.base && o.b.ticker === b.ticker);
          const last = displayFromAtomicString(m.last_price ?? m.best_ask ?? m.best_bid, b.precision, qi.precision);
          const on = current?.base === m.base && current.quote === m.quote;
          return (
            <button key={`${m.base}/${m.quote}`} type="button" className={`mk${on ? " on" : ""}`} onClick={() => nav(`/markets/${m.base}/${m.quote}`)} aria-current={on ? "true" : undefined}>
              <strong>
                {b.ticker}/{qi.ticker} {!b.verified && <span className="tag">?</span>}
                {dup && <span className="muted mono" style={{ display: "block", fontSize: 11, fontWeight: 400 }}>{shortId(m.base)}</span>}
              </strong>
              <span className="mono">{formatPrice(last)}</span>
              <span className={`chg ${changeClass(m.change_24h) ?? "muted"}`}>{formatChange(m.change_24h)}</span>
            </button>
          );
        })}
      </div>
    </aside>
  );
}

// ---------------------------------------------------------------- order book

const BOOK_ROWS = 8;

function OrderBook({ asks, bids, b, q, last, loading, onPick }: { asks: BookEntry[]; bids: BookEntry[]; b: AssetInfo; q: AssetInfo; last: Ratio | null; loading: boolean; onPick: (price: Ratio, side: "buy" | "sell") => void }) {
  const showAsks = asks.slice(0, BOOK_ROWS).reverse();
  const showBids = bids.slice(0, BOOK_ROWS);
  const maxBase = [...showAsks, ...showBids].reduce((m, e) => (entryBaseAmount(e, b.id) > m ? entryBaseAmount(e, b.id) : m), 1n);
  const disp = (e: BookEntry) => atomicToDisplayPrice(entryAtomicPrice(e, b.id), b.precision, q.precision);
  const bestAsk = asks[0] ? disp(asks[0]) : null;
  const bestBid = bids[0] ? disp(bids[0]) : null;
  const mid = last ?? bestAsk ?? bestBid;
  const spread = bestAsk && bestBid && bestAsk.num > 0n ? divRatio(subRatio(bestAsk, bestBid), bestAsk) : null;

  const row = (e: BookEntry, side: "ask" | "bid") => {
    const p = disp(e);
    const ba = entryBaseAmount(e, b.id);
    const pct = Number((ba * 100n) / maxBase);
    return (
      <button key={e.id} type="button" className={`ob ${side === "ask" ? "dn" : "up"}`} onClick={() => onPick(p, side === "ask" ? "buy" : "sell")} title={`Whole order · ${shortId(e.id)}`}>
        <span>{formatPrice(p)}</span>
        <span>{formatCompact(ba, b.precision)}</span>
        <span>{formatCompact(entryQuoteAmount(e, b.id), q.precision)}</span>
        <i className="depth" style={{ width: `${pct}%`, background: side === "ask" ? "var(--down)" : "var(--up)" }} />
      </button>
    );
  };

  return (
    <div>
      <div className="ob hd muted">
        <span>Price</span>
        <span>{b.ticker}</span>
        <span>{q.ticker}</span>
      </div>
      {loading && [0, 1, 2, 3, 4, 5].map((i) => <div key={i} style={{ padding: "4px" }}><Skeleton h={12} /></div>)}
      {!loading && asks.length === 0 && bids.length === 0 && <StateBox title="Empty order book" detail="Place the first order below." />}
      {!loading && showAsks.map((e) => row(e, "ask"))}
      {!loading && (asks.length > 0 || bids.length > 0) && (
        <div className="ob mid">
          <strong className="mono">{formatPrice(mid)}</strong>
          <span className="muted" style={{ fontFamily: "var(--font)" }}>{spread ? `spread ${formatPercent(spread, 1)}` : ""}</span>
          <span />
        </div>
      )}
      {!loading && showBids.map((e) => row(e, "bid"))}
    </div>
  );
}

// ---------------------------------------------------------------- order form

function OrderForm({ b, q, asks, bids, prefill, onDone }: { b: AssetInfo; q: AssetInfo; asks: BookEntry[]; bids: BookEntry[]; prefill: { price: Ratio; side: "buy" | "sell"; n: number } | null; onDone: () => void }) {
  const w = useWallet();
  const dex = useDex();
  const toast = useToast();
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [type, setType] = useState<"limit" | "market">("limit");
  const [priceText, setPriceText] = useState("");
  const [amountText, setAmountText] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!prefill) return;
    setPriceText(ratioToDecimal(prefill.price, Math.max(4, formatPrice(prefill.price).split(".")[1]?.length ?? 4), "round", false));
    setSide(prefill.side);
    setType("limit");
  }, [prefill]);
  // Reset when market changes.
  useEffect(() => {
    setPriceText("");
    setAmountText("");
  }, [b.id, q.id]);

  const price = tryParseDecimalRatio(priceText);
  const amount = tryParseUnits(amountText || "0", b.precision);
  const isBuy = side === "buy";
  const total = price && amount !== null && price.num > 0n ? quoteForBase(amount, price, b.precision, q.precision, isBuy ? "floor" : "ceil") : null;

  // Market orders route server-side via GET /api/quote (same as Swap).
  const settled = useDebounced(amountText, 250) === amountText;
  const quoteReq = useMemo(
    () => (type === "market" && amount !== null && amount > 0n ? (isBuy ? { sell: q.id, buy: b.id, amount, side: "exact_out" as const } : { sell: b.id, buy: q.id, amount, side: "exact_in" as const }) : null),
    [type, amount, isBuy, b.id, q.id],
  );
  const quote = useQuery(quoteReq && settled ? `mq:${quoteReq.sell}:${quoteReq.buy}:${quoteReq.side}:${quoteReq.amount}` : null, () => api.quote(quoteReq!), { interval: 10_000 });
  const route = quote.data && quoteReq ? toRoute(quote.data) : null;

  const giveAsset = isBuy ? q.id : b.id;
  const giveInfo = isBuy ? q : b;
  const bal = w.balanceOf(giveAsset);
  const policy = dex.policyAsset;
  const bestAsk = asks[0] ? atomicToDisplayPrice(entryAtomicPrice(asks[0], b.id), b.precision, q.precision) : null;
  const bestBid = bids[0] ? atomicToDisplayPrice(entryAtomicPrice(bids[0], b.id), b.precision, q.precision) : null;
  const crosses = type === "limit" && price && price.num > 0n && ((isBuy && bestAsk && cmpRatio(price, bestAsk) >= 0) || (!isBuy && bestBid && cmpRatio(price, bestBid) <= 0));

  let error: string | null = null;
  let label = type === "limit" ? `Place ${side} order` : `${isBuy ? "Buy" : "Sell"} ${b.ticker} now`;
  const fee = type === "limit" ? estimateSplitFee() : estimateTakeFee(route?.fills.length || 1, giveAsset === policy);
  if (amount === null) error = b.precision === 0 ? `${b.ticker} has no decimals` : `At most ${b.precision} decimals`;
  else if (type === "limit" && priceText && !price) error = "Invalid price";
  if (type === "limit") {
    if (amount !== null && amount > 0n && total === 0n) error = "Total rounds to zero";
    else if (total !== null && amount && (isBuy ? total : amount) + (giveAsset === policy ? fee : 0n) > bal && w.status === "connected") error = `Insufficient ${giveInfo.ticker} balance`;
  } else if (quote.error) {
    error = `Quote unavailable: ${(quote.error as Error).message}`;
  } else if (route && amount) {
    if (route.fills.length === 0) error = (isBuy ? asks : bids).length === 0 ? "No orders to fill" : "No whole orders fit this amount";
    else if ((isBuy ? route.totalPay : amount) + (giveAsset === policy ? fee : 0n) > bal && w.status === "connected") error = `Insufficient ${giveInfo.ticker} balance`;
  }
  const ready =
    w.status === "connected" &&
    !error &&
    !busy &&
    amount !== null &&
    amount > 0n &&
    (type === "limit" ? !!price && price.num > 0n && !!total && total > 0n : settled && !!route && route.fills.length > 0);
  if (w.status === "missing") label = "Install wallet to trade";
  else if (w.status !== "connected") label = "Connect wallet";
  if (busy) label = "Confirm in wallet…";

  async function publish(offer: Offer) {
    try {
      await api.postOffer(offer);
      toast.push({ kind: "success", title: `${isBuy ? "Buy" : "Sell"} order placed`, detail: `${amountText} ${b.ticker} @ ${priceText} ${q.ticker}` });
      onDone();
    } catch (e) {
      toast.push({ kind: "error", title: "Order signed but not listed", detail: e instanceof Error ? e.message : String(e), action: { label: "Retry listing", onClick: () => void publish(offer) } });
    }
  }

  async function submit() {
    if (w.status !== "connected") {
      if (w.status !== "missing") void w.connect();
      return;
    }
    if (!ready || !w.client || amount === null) return;
    setBusy(true);
    try {
      if (type === "limit" && price && total !== null) {
        const r = await w.client.makeSwapOffer(
          isBuy ? { giveAsset: q.id, giveAmount: total, wantAsset: b.id, wantAmount: amount } : { giveAsset: b.id, giveAmount: amount, wantAsset: q.id, wantAmount: total },
        );
        if (w.address) rememberOffer(w.address, r.offer);
        await publish(r.offer);
        setAmountText("");
      } else if (route && quoteReq) {
        const r2 = toRoute(await api.quote(quoteReq));
        if (r2.fills.length === 0 || r2.totalPay > route.totalPay || r2.totalReceive < route.totalReceive) {
          toast.push({ kind: "info", title: "The order book changed", detail: "Review the new quote and try again." });
          onDone();
          return;
        }
        const { txid } = await w.client.takeSwapOffers(r2.fills);
        toast.push({ kind: "success", title: `${isBuy ? "Bought" : "Sold"} ${formatUnits(isBuy ? r2.totalReceive : r2.totalPay, b.precision)} ${b.ticker}`, txid });
        setAmountText("");
        onDone();
      }
    } catch (e) {
      toast.error(e, "Order failed");
    } finally {
      setBusy(false);
      void w.refreshBalances();
    }
  }

  const routeAvg = route?.avgPrice ? atomicToDisplayPrice(isBuy ? route.avgPrice : ratio(route.avgPrice.den, route.avgPrice.num), b.precision, q.precision) : null;

  return (
    <form
      style={{ display: "contents" }}
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <div className="seg" role="tablist" aria-label="Side">
        <button type="button" role="tab" aria-selected={isBuy} className={isBuy ? "on buy" : undefined} onClick={() => setSide("buy")}>Buy</button>
        <button type="button" role="tab" aria-selected={!isBuy} className={!isBuy ? "on sell" : undefined} onClick={() => setSide("sell")}>Sell</button>
      </div>
      <div className="seg" role="tablist" aria-label="Order type">
        <button type="button" role="tab" aria-selected={type === "limit"} className={type === "limit" ? "on" : undefined} onClick={() => setType("limit")}>Limit</button>
        <button type="button" role="tab" aria-selected={type === "market"} className={type === "market" ? "on" : undefined} onClick={() => setType("market")}>Market</button>
      </div>
      {type === "limit" && (
        <label className="fl">
          <span className="muted">Price</span>
          <input inputMode="decimal" placeholder="0.00" value={priceText} onChange={(e) => isDecimalInput(e.target.value, 18) && setPriceText(e.target.value)} />
          <span className="unit">{q.ticker}</span>
        </label>
      )}
      <label className="fl">
        <span className="muted">Amount</span>
        <input inputMode="decimal" placeholder="0" value={amountText} onChange={(e) => isDecimalInput(e.target.value, b.precision) && setAmountText(e.target.value)} />
        <span className="unit">{b.ticker}</span>
      </label>
      {w.status === "connected" && (
        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12 }}>
          <span className="muted">Available</span>
          <button
            type="button"
            className="linkish"
            style={{ fontWeight: 500 }}
            onClick={() => {
              if (!isBuy) setAmountText(toInputString(bal, b.precision));
              else if (price && price.num > 0n) {
                // Max base for the quote balance at this price.
                const spend = giveAsset === policy && bal > fee ? bal - fee : bal;
                const maxBase = (spend * price.den * 10n ** BigInt(b.precision)) / (price.num * 10n ** BigInt(q.precision));
                setAmountText(toInputString(maxBase, b.precision));
              }
            }}
          >
            {formatUnits(bal, giveInfo.precision, { maxDecimals: 6 })} {giveInfo.ticker}
          </button>
        </div>
      )}
      {type === "limit" ? (
        <div style={{ display: "flex", justifyContent: "space-between" }}>
          <span className="muted">Total</span>
          <strong className="mono">
            {total !== null ? formatUnits(total, q.precision, { minDecimals: 2 }) : "—"} {q.ticker}
          </strong>
        </div>
      ) : (
        <>
          <div style={{ display: "flex", justifyContent: "space-between" }}>
            <span className="muted">{isBuy ? "Est. cost" : "Est. proceeds"}</span>
            <strong className="mono">
              {route && route.fills.length ? formatUnits(isBuy ? route.totalPay : route.totalReceive, q.precision, { minDecimals: 2 }) : "—"} {q.ticker}
            </strong>
          </div>
          {route && route.fills.length > 0 && (
            <div className="muted" style={{ fontSize: 12 }}>
              Fills {route.fills.length} whole order{route.fills.length === 1 ? "" : "s"} · avg {formatPrice(routeAvg)}
              {route.partial ? ` · ${formatUnits(isBuy ? route.totalReceive : route.totalPay, b.precision)} ${b.ticker} fillable` : ""}
            </div>
          )}
        </>
      )}
      {crosses && <div className="note">This price crosses the book. Limit orders don't auto-match here — use Market to fill existing orders now.</div>}
      {error && <div className="err-text">{error}</div>}
      <button type="submit" className={`btn ${isBuy ? "buy" : "sell"}`} disabled={(w.status === "connected" && !ready) || w.status === "missing" || w.status === "detecting" || busy}>
        {busy && <span className="spin" style={{ marginRight: 8 }} />}
        {label}
      </button>
      <p className="muted" style={{ margin: 0, fontSize: 12 }}>
        Orders are signed swap offers. Cancel anytime by spending the offered coins.
      </p>
    </form>
  );
}

// ---------------------------------------------------------------- open orders + trades

function OpenOrders({ book, current, onChanged }: { book: BookEntry[]; current: { base: string; quote: string }; onChanged: () => void }) {
  const w = useWallet();
  const dex = useDex();
  const toast = useToast();
  const [cancelling, setCancelling] = useState<Set<string>>(new Set());
  const mine = useQuery(w.status === "connected" && w.address ? `offers:${w.address}` : null, () => api.offersByMaker(w.address!), { interval: 10_000 });

  const rows = useMemo(() => {
    const byId = new Map<string, BookEntry>();
    for (const e of mine.data ?? []) if (!e.status || e.status === "open") byId.set(e.id, e);
    if (w.address) {
      const onBook = new Set(book.map((e) => e.offer.tx));
      for (const o of loadMyOffers(w.address)) {
        if (!onBook.has(o.tx)) continue;
        try {
          const e = parseBookEntry(o);
          if (!byId.has(e.id)) byId.set(e.id, e);
        } catch {
          /* ignore */
        }
      }
    }
    return [...byId.values()].sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
  }, [mine.data, book, w.address]);

  async function cancel(e: BookEntry) {
    if (!w.client) return;
    setCancelling((s) => new Set(s).add(e.id));
    try {
      const { txid } = await w.client.cancelSwapOffer(e.txid, e.vout);
      if (w.address) forgetOffer(w.address, e.offer.tx);
      toast.push({ kind: "success", title: "Order cancelled", detail: "The offered coins were sent back to your wallet.", txid });
      void mine.refetch();
      onChanged();
      void w.refreshBalances();
    } catch (err) {
      toast.error(err, "Cancel failed");
    } finally {
      setCancelling((s) => {
        const n = new Set(s);
        n.delete(e.id);
        return n;
      });
    }
  }

  if (w.status !== "connected")
    return (
      <StateBox
        title="Connect your wallet to see your orders"
        action={w.status === "disconnected" ? <button type="button" className="btn" onClick={() => void w.connect()}>Connect wallet</button> : undefined}
      />
    );
  if (mine.loading) return <Skeleton h={18} />;
  if (rows.length === 0)
    return <StateBox title="No open orders" detail={mine.error ? "Couldn't load orders from the server." : "Limit orders you place show up here."} />;

  return (
    <div className="tbl-wrap">
      <table>
        <thead>
          <tr>
            <th>Side</th>
            <th>Price</th>
            <th>Amount</th>
            <th>Filled</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {rows.map((e) => {
            const known = dex.markets?.find((m) => (m.base === e.giveAsset && m.quote === e.wantAsset) || (m.base === e.wantAsset && m.quote === e.giveAsset));
            const { base, quote } = known ?? orientPair(e.giveAsset, e.wantAsset, dex.policyAsset);
            const b = dex.info(base);
            const q = dex.info(quote);
            const sell = e.giveAsset === base;
            const p = displayPrice(entryQuoteAmount(e, base), entryBaseAmount(e, base), b.precision, q.precision);
            const here = base === current.base && quote === current.quote;
            return (
              <tr key={e.id}>
                <td className={sell ? "dn" : "up"}>{sell ? "Sell" : "Buy"}</td>
                <td className="mono">
                  {formatPrice(p)}
                  {!here && <span className="muted"> {q.ticker}</span>}
                </td>
                <td className="mono">
                  {formatUnits(entryBaseAmount(e, base), b.precision)} {b.ticker}
                </td>
                <td>0%</td>
                <td className="r">
                  <button type="button" className="linkish" style={{ fontWeight: 500 }} disabled={cancelling.has(e.id)} onClick={() => void cancel(e)}>
                    {cancelling.has(e.id) ? "Cancelling…" : "Cancel"}
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function RecentTrades({ trades, b, q, loading }: { trades: Trade[] | undefined; b: AssetInfo; q: AssetInfo; loading: boolean }) {
  if (loading) return <Skeleton h={18} />;
  if (!trades?.length) return <StateBox title="No trades yet" />;
  const rows = trades.slice(0, 10);
  return (
    <div className="tbl-wrap">
      <table>
        <thead>
          <tr>
            <th>Price ({q.ticker})</th>
            <th className="r">Amount ({b.ticker})</th>
            <th className="r">Time</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((t, i) => {
            const p = displayPrice(t.quote_amount, t.base_amount, b.precision, q.precision);
            const prev = rows[i + 1];
            // Colour by taker side when the server reports it, else by tick direction.
            const dir = t.side ? (t.side === "buy" ? 1 : -1) : prev ? cmpRatio(p, displayPrice(prev.quote_amount, prev.base_amount, b.precision, q.precision)) : 0;
            return (
              <tr key={`${t.txid}-${i}`}>
                <td className={`mono ${dir > 0 ? "up" : dir < 0 ? "dn" : ""}`}>{formatPrice(p)}</td>
                <td className="mono r">{formatUnits(t.base_amount, b.precision, { maxDecimals: 4 })}</td>
                <td className="muted r" title={new Date(t.time * 1000).toLocaleString()}>{timeAgo(t.time)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------- page

const INTERVALS = ["1h", "4h", "1d"] as const;

export function MarketsPage() {
  const params = useParams();
  const nav = useNavigate();
  const dex = useDex();
  const [picker, setPicker] = useState(false);
  const [interval, setInterval_] = useState<(typeof INTERVALS)[number]>("1h");
  const [prefill, setPrefill] = useState<{ price: Ratio; side: "buy" | "sell"; n: number } | null>(null);

  const base = params.base?.toLowerCase() ?? null;
  const quote = params.quote?.toLowerCase() ?? (base ? dex.policyAsset : null);

  // Default to the most active market.
  useEffect(() => {
    if (base || !dex.markets?.length) return;
    const top = [...dex.markets].sort((a, b) => (b.volume_24h > a.volume_24h ? 1 : b.volume_24h < a.volume_24h ? -1 : 0))[0]!;
    nav(`/markets/${top.base}/${top.quote}`, { replace: true });
  }, [base, dex.markets, nav]);

  const pair = base && quote ? { base, quote } : null;
  const market: Market | undefined = pair ? dex.markets?.find((m) => m.base === pair.base && m.quote === pair.quote) : undefined;
  const key = pair ? `${pair.base}/${pair.quote}` : null;
  const book = useQuery(key && `book:${key}`, () => api.book(pair!.base, pair!.quote), { interval: 6000 });
  const trades = useQuery(key && `trades:${key}`, () => api.trades(pair!.base, pair!.quote), { interval: 10_000 });
  const candles = useQuery(key && `candles:${key}:${interval}`, () => api.candles(pair!.base, pair!.quote, interval), { interval: 30_000 });

  const b = pair ? dex.info(pair.base) : null;
  const q = pair ? dex.info(pair.quote) : null;
  const oriented = useMemo(() => (book.data && pair ? orientBook(book.data, pair.base, pair.quote) : { asks: [], bids: [] }), [book.data, pair?.base, pair?.quote]);
  const entries = useMemo(() => [...oriented.asks, ...oriented.bids], [oriented]);
  const points = useMemo(() => (candles.data && b && q ? toChartPoints(candles.data, b.precision, q.precision) : []), [candles.data, b?.precision, q?.precision]);

  const last = market && b && q ? displayFromAtomicString(market.last_price, b.precision, q.precision) : null;

  const refreshAll = () => {
    void book.refetch();
    void trades.refetch();
    void dex.refetchMarkets();
  };

  const newMarketPicker = picker && (
    <TokenPicker
      selected={base}
      exclude={dex.policyAsset}
      onSelect={(id) => nav(`/markets/${id}/${dex.policyAsset ?? ""}`)}
      onClose={() => setPicker(false)}
    />
  );

  if (!pair || !b || !q) {
    return (
      <div className="mgrid">
        <MarketList current={null} onNew={() => setPicker(true)} />
        <section className="col empty-main">
          {dex.marketsLoading ? (
            <StateBox loading title="Loading markets…" />
          ) : dex.serverDown ? (
            <StateBox title="DEX server unreachable" detail="Markets will load when the server is back." />
          ) : (
            <StateBox
              title="No markets yet"
              detail="Launch a token, or pick any asset to open its market with the first order."
              action={
                <div style={{ display: "flex", gap: 8 }}>
                  <button type="button" className="btn" onClick={() => setPicker(true)}>New market</button>
                  <Link className="btn secondary" style={{ display: "grid", placeItems: "center", textDecoration: "none", marginTop: 10, height: 38 }} to="/launch">Launch a token</Link>
                </div>
              }
            />
          )}
        </section>
        {newMarketPicker}
      </div>
    );
  }

  const changeStr = market?.change_24h ?? null;

  return (
    <div className="mgrid">
      <MarketList current={pair} onNew={() => setPicker(true)} />
      <section className="col center-top">
        <div className="stats">
          <h1 style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <TokenIcon info={b} size={26} />
            {b.ticker} / {q.ticker}
            {!b.verified && <span className="tag">UNVERIFIED</span>}
          </h1>
          <div>
            <div className="muted">Last</div>
            <strong className="mono" style={{ fontSize: 16 }}>{formatPrice(last)}</strong>
          </div>
          <div>
            <div className="muted">24h</div>
            <strong className={changeClass(changeStr)}>{formatChange(changeStr)}</strong>
          </div>
          <div>
            <div className="muted">24h volume</div>
            <strong>
              {market ? formatUnits(market.volume_24h, q.precision, { maxDecimals: 2 }) : "0"} {q.ticker}
            </strong>
          </div>
          <div>
            <div className="muted">Asset ID</div>
            <CopyText text={b.id}>{shortId(b.id)}</CopyText>
          </div>
        </div>
        <div className="chart-box">
          <div className="chart-tabs" role="tablist" aria-label="Candle interval">
            {INTERVALS.map((i) => (
              <button key={i} type="button" role="tab" aria-selected={i === interval} className={i === interval ? "on" : undefined} onClick={() => setInterval_(i)}>
                {i}
              </button>
            ))}
          </div>
          <PriceChart points={points} label={`${b.ticker}/${q.ticker} price, ${interval} candles`} />
          {!candles.loading && points.length === 0 && (
            <div className="chart-empty">{candles.error ? "Couldn't load price history" : "No trades yet"}</div>
          )}
        </div>
      </section>
      <section className="col center-bottom">
        <div className="h">Your open orders</div>
        <OpenOrders book={entries} current={pair} onChanged={refreshAll} />
        <div className="h" style={{ marginTop: 8 }}>Recent trades</div>
        <RecentTrades trades={trades.data} b={b} q={q} loading={trades.loading} />
      </section>
      <aside className="col book-col">
        <div className="h">Order book</div>
        {book.error != null && !book.data ? (
          <StateBox title="Couldn't load the order book" detail={book.error instanceof ApiUnavailableError ? "DEX server unreachable." : (book.error as Error).message} />
        ) : (
          <OrderBook asks={oriented.asks} bids={oriented.bids} b={b} q={q} last={last} loading={book.loading} onPick={(price, side) => setPrefill({ price, side, n: Date.now() })} />
        )}
        <OrderForm b={b} q={q} asks={oriented.asks} bids={oriented.bids} prefill={prefill} onDone={refreshAll} />
      </aside>
      {newMarketPicker}
    </div>
  );
}
