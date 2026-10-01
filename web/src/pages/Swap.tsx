import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router";
import { TokenPicker } from "../components/TokenPicker";
import { Icon, TokenIcon } from "../components/ui";
import {
  atomicToDisplayPrice,
  formatPercent,
  formatPrice,
  formatUnits,
  isDecimalInput,
  mulDiv,
  ratio,
  toInputString,
  tryParseUnits,
  type Ratio,
} from "../lib/amount";
import { ApiUnavailableError } from "../lib/api";
import { NETWORK_LABEL, WALLET_INSTALL_URL } from "../lib/config";
import { useDebounced, useQuery, useStoredState } from "../lib/hooks";
import { estimateTakeFee, type RouteMode } from "../lib/route";
import type { Market } from "../lib/types";
import { api } from "../state/api";
import { useDex, type AssetInfo } from "../state/dex";
import { useToast } from "../state/toast";
import { useWallet } from "../state/wallet";

const SLIPPAGE_OPTIONS = [10, 50, 100]; // basis points

function findMarket(markets: Market[] | undefined, a: string | null, b: string | null): Market | undefined {
  if (!a || !b || !markets) return undefined;
  return markets.find((m) => (m.base === a && m.quote === b) || (m.base === b && m.quote === a));
}

function TokenButton({ info, onClick, label }: { info: AssetInfo | null; onClick: () => void; label: string }) {
  if (!info)
    return (
      <button className="tsel empty" type="button" onClick={onClick} aria-label={label}>
        Select token
        <Icon.chevron />
      </button>
    );
  return (
    <button className="tsel" type="button" onClick={onClick} aria-label={`${label}: ${info.ticker}`}>
      <TokenIcon info={info} />
      {info.ticker}
      <Icon.chevron />
    </button>
  );
}

export function SwapPage() {
  const dex = useDex();
  const w = useWallet();
  const toast = useToast();
  const [pay, setPay] = useState<string | null>(null);
  const [receive, setReceive] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [side, setSide] = useState<RouteMode>("pay");
  const [picker, setPicker] = useState<RouteMode | null>(null);
  const [slipBps, setSlipBps] = useStoredState("dex.slippageBps", 50);
  const [slipOpen, setSlipOpen] = useState(false);
  const [busy, setBusy] = useState<null | "quote" | "wallet">(null);

  // Default pair: most active market, paying the quote asset.
  useEffect(() => {
    if (pay || receive || !dex.markets?.length) return;
    const top = [...dex.markets].sort((a, b) => (b.volume_24h > a.volume_24h ? 1 : b.volume_24h < a.volume_24h ? -1 : 0))[0]!;
    setPay(top.quote);
    setReceive(top.base);
  }, [dex.markets, pay, receive]);

  const payInfo = pay ? dex.info(pay) : null;
  const recvInfo = receive ? dex.info(receive) : null;
  const market = findMarket(dex.markets, pay, receive);

  const typedInfo = side === "pay" ? payInfo : recvInfo;
  const amount = typedInfo ? tryParseUnits(text || "0", typedInfo.precision) : null;
  const debouncedText = useDebounced(text, 250);
  const settled = debouncedText === text;
  // Routing happens server-side (GET /api/quote); mock mode serves the same
  // whole-offer greedy routing from src/lib/route.ts.
  const quoteKey = market && pay && receive && amount !== null && amount > 0n && settled ? `quote:${pay}:${receive}:${side}:${amount}` : null;
  const quote = useQuery(quoteKey, () => api.quote({ sell: pay!, buy: receive!, amount: amount!, side: side === "pay" ? "exact_in" : "exact_out" }), { interval: 10_000 });
  const q = quote.data;
  const filled = !!q && q.offers.length > 0;

  const fee = estimateTakeFee(Math.max(q?.offers.length ?? 1, 1), pay === dex.policyAsset);
  const policyInfo = dex.policyAsset ? dex.info(dex.policyAsset) : null;
  const payBal = w.balanceOf(pay);
  const recvBal = w.balanceOf(receive);
  const minReceived = q ? mulDiv(q.buyAmount, BigInt(10_000 - slipBps), 10_000n, "floor") : 0n;
  const maxSold = q ? (side === "pay" ? (amount ?? 0n) : mulDiv(q.sellAmount, BigInt(10_000 + slipBps), 10_000n, "ceil")) : 0n;

  // Display price as 1 BASE = x QUOTE.
  const rate: Ratio | null = useMemo(() => {
    if (!q || !filled || !market || !payInfo || !recvInfo) return null;
    const avg = ratio(q.sellAmount, q.buyAmount); // pay atomic per receive atomic
    const atomicQB = receive === market.base ? avg : ratio(avg.den, avg.num);
    const [bp, qp] = receive === market.base ? [recvInfo.precision, payInfo.precision] : [payInfo.precision, recvInfo.precision];
    return atomicToDisplayPrice(atomicQB, bp, qp);
  }, [q, filled, market, payInfo, recvInfo, receive]);
  const baseInfo = market ? dex.info(market.base) : null;
  const quoteInfo = market ? dex.info(market.quote) : null;
  const noLiquidity = market ? (receive === market.base ? market.best_ask == null : market.best_bid == null) : false;

  const onType = (which: RouteMode, v: string) => {
    const info = which === "pay" ? payInfo : recvInfo;
    if (!info || !isDecimalInput(v, info.precision)) return;
    setSide(which);
    setText(v);
  };
  const shown = (which: RouteMode): string => {
    if (which === side) return text;
    if (!filled || !settled) return "";
    const info = which === "pay" ? payInfo : recvInfo;
    return formatUnits(which === "pay" ? q.sellAmount : q.buyAmount, info?.precision ?? 0);
  };
  const choose = (which: RouteMode, id: string) => {
    const other = which === "pay" ? receive : pay;
    if (id === other) return flip();
    if (which === "pay") setPay(id);
    else setReceive(id);
    if (which === side) setText("");
  };
  const flip = () => {
    setPay(receive);
    setReceive(pay);
    setSide((s) => (s === "pay" ? "receive" : "pay"));
  };
  const useMax = () => {
    if (!payInfo) return;
    const max = pay === dex.policyAsset ? (payBal > fee ? payBal - fee : 0n) : payBal;
    setSide("pay");
    setText(toInputString(max, payInfo.precision));
  };

  async function submit() {
    if (!q || !filled || !pay || !receive || !w.client || amount === null) return;
    setBusy("quote");
    try {
      const fresh = await api.quote({ sell: pay, buy: receive, amount, side: side === "pay" ? "exact_in" : "exact_out" });
      const ok = fresh.offers.length > 0 && fresh.buyAmount >= minReceived && fresh.sellAmount <= maxSold;
      if (!ok) {
        await quote.refetch();
        toast.push({ kind: "info", title: "The order book changed", detail: "Review the updated quote and try again." });
        return;
      }
      setBusy("wallet");
      const { txid } = await w.client.takeSwapOffers(fresh.offers);
      toast.push({
        kind: "success",
        title: `Swapped ${formatUnits(fresh.sellAmount, payInfo!.precision)} ${payInfo!.ticker} for ${formatUnits(fresh.buyAmount, recvInfo!.precision)} ${recvInfo!.ticker}`,
        txid,
      });
      setText("");
      void w.refreshBalances();
      void dex.refetchMarkets();
    } catch (e) {
      toast.error(e, "Swap failed");
      void quote.refetch();
    } finally {
      setBusy(null);
    }
  }

  // ---------------------------------------------------------------- button state
  let cta: { label: string; onClick?: () => void; href?: string; disabled?: boolean } = { label: "Swap", onClick: () => void submit() };
  if (w.status === "missing") cta = { label: "Install wallet", href: WALLET_INSTALL_URL };
  else if (w.status === "detecting") cta = { label: "Detecting wallet…", disabled: true };
  else if (w.status !== "connected") cta = { label: w.status === "connecting" ? "Check your wallet…" : "Connect wallet", onClick: () => void w.connect(), disabled: w.status === "connecting" };
  else if (!pay || !receive) cta = { label: "Select a token", disabled: true };
  else if (!market) cta = { label: "No market for this pair", disabled: true };
  else if (amount === null) cta = { label: "Invalid amount", disabled: true };
  else if (amount === 0n) cta = { label: "Enter an amount", disabled: true };
  else if (!settled || quote.loading) cta = { label: "Fetching quote…", disabled: true };
  else if (quote.error) cta = { label: "Quote unavailable", disabled: true };
  else if (!filled) cta = { label: noLiquidity ? "No orders to fill" : "No whole orders fit this amount", disabled: true };
  else if (q.sellAmount + (pay === dex.policyAsset ? fee : 0n) > payBal) cta = { label: `Insufficient ${payInfo!.ticker} balance`, disabled: true };
  else if (pay !== dex.policyAsset && dex.policyAsset && w.balanceOf(dex.policyAsset) < fee) cta = { label: "Not enough ECX for network fee", disabled: true };
  if (busy) cta = { label: busy === "wallet" ? "Confirm in wallet…" : "Checking order book…", disabled: true };

  const impactPct = q ? q.priceImpactBps / 100 : 0;
  const unavailable = dex.serverDown || quote.error instanceof ApiUnavailableError;
  const reached = q ? (side === "pay" ? q.sellAmount : q.buyAmount) : 0n;

  return (
    <main className="swap-main">
      <div className="swap-head">
        <h1>Swap</h1>
        <button type="button" className="slip-btn" aria-label="Slippage settings" aria-expanded={slipOpen} onClick={() => setSlipOpen((o) => !o)}>
          {(slipBps / 100).toString()}% slippage
          <Icon.gear />
        </button>
        {slipOpen && (
          <div className="slip-pop">
            <strong>Max slippage</strong>
            <div className="muted" style={{ fontSize: 12, marginTop: 4, lineHeight: 1.4 }}>
              Orders fill at their exact signed price. Slippage only protects you if the book changes before you approve.
            </div>
            <div className="slip-opts">
              {SLIPPAGE_OPTIONS.map((b) => (
                <button key={b} type="button" className={b === slipBps ? "on" : undefined} onClick={() => { setSlipBps(b); setSlipOpen(false); }}>
                  {b / 100}%
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      <div className="box">
        <div className="box-top">
          <span>You pay</span>
          {w.status === "connected" && payInfo && (
            <span>
              Balance {formatUnits(payBal, payInfo.precision, { maxDecimals: 6 })} ·{" "}
              <button type="button" className="linkish" onClick={useMax} disabled={payBal === 0n}>
                Max
              </button>
            </span>
          )}
        </div>
        <div className="box-row">
          <label style={{ flexGrow: 1, minWidth: 0 }}>
            <span className="sr-only">Amount to pay</span>
            <input className={`amt${side !== "pay" ? " dim" : ""}`} value={shown("pay")} placeholder="0" inputMode="decimal" autoComplete="off" onChange={(e) => onType("pay", e.target.value)} />
          </label>
          <TokenButton info={payInfo} onClick={() => setPicker("pay")} label="Token to pay" />
        </div>
      </div>
      <div className="flip-wrap">
        <button type="button" className="flip" aria-label="Flip direction" onClick={flip}>
          <span>
            <Icon.arrowDown />
          </span>
        </button>
      </div>
      <div className="box">
        <div className="box-top">
          <span>You receive</span>
          {w.status === "connected" && recvInfo && <span>Balance {formatUnits(recvBal, recvInfo.precision, { maxDecimals: 6 })}</span>}
        </div>
        <div className="box-row">
          <label style={{ flexGrow: 1, minWidth: 0 }}>
            <span className="sr-only">Amount to receive</span>
            <input className={`amt${side !== "receive" ? " dim" : ""}`} value={shown("receive")} placeholder="0" inputMode="decimal" autoComplete="off" onChange={(e) => onType("receive", e.target.value)} />
          </label>
          <TokenButton info={recvInfo} onClick={() => setPicker("receive")} label="Token to receive" />
        </div>
      </div>

      <div className="details">
        {unavailable && <div className="note warn">Can't reach the DEX server. Quotes are unavailable until it's back.</div>}
        {!unavailable && !dex.marketsLoading && !dex.markets?.length && (
          <div className="note">
            No markets yet. <Link to="/launch">Launch a token</Link> or place the first order on <Link to="/markets">Markets</Link>.
          </div>
        )}
        {pay && receive && dex.markets && !market && !unavailable && (
          <div className="note">
            No market for {payInfo?.ticker}/{recvInfo?.ticker} yet. <Link to="/markets">Place a limit order</Link> to start one.
          </div>
        )}
        {market && noLiquidity && !unavailable && (
          <div className="note">No one is selling {recvInfo?.ticker} for {payInfo?.ticker} right now. Try the other direction or place a limit order.</div>
        )}
        {quote.error != null && !unavailable && <div className="note warn">Couldn't get a quote: {(quote.error as Error).message}</div>}
        {q && !filled && !noLiquidity && settled && typedInfo && (
          <div className="note">Orders fill whole, and none fit under {text} {typedInfo.ticker}. Try a larger amount.</div>
        )}
        {q && filled && q.unfilled > 0n && settled && typedInfo && (
          <div className="note">
            Orders fill whole, so this route {side === "pay" ? "spends" : "delivers"} {formatUnits(reached, typedInfo.precision)} {typedInfo.ticker}.{" "}
            <button type="button" className="linkish" onClick={() => setText(toInputString(reached, typedInfo.precision))}>
              Use exact amount
            </button>
          </div>
        )}
        {q && filled && settled && payInfo && recvInfo && baseInfo && quoteInfo && (
          <>
            <div className="kv">
              <span>Rate</span>
              <span>
                1 {baseInfo.ticker} = {formatPrice(rate)} {quoteInfo.ticker}
              </span>
            </div>
            <div className="kv">
              <span>Price impact</span>
              <span className={impactPct >= 5 ? "dn" : undefined}>{formatPercent(ratio(BigInt(Math.round(q.priceImpactBps)), 10_000n), q.priceImpactBps > 0 && q.priceImpactBps < 10 ? 2 : 1)}</span>
            </div>
            {side === "pay" ? (
              <div className="kv">
                <span>Minimum received</span>
                <span>
                  {formatUnits(minReceived, recvInfo.precision)} {recvInfo.ticker}
                </span>
              </div>
            ) : (
              <div className="kv">
                <span>Maximum sold</span>
                <span>
                  {formatUnits(maxSold, payInfo.precision)} {payInfo.ticker}
                </span>
              </div>
            )}
            <div className="kv">
              <span>Route</span>
              <span>
                Fills {q.offers.length} order{q.offers.length === 1 ? "" : "s"} · {baseInfo.ticker}/{quoteInfo.ticker}
              </span>
            </div>
            <div className="kv">
              <span>Network fee</span>
              <span>
                ≈ {formatUnits(fee, 8)} {policyInfo?.ticker ?? "ECX"}
              </span>
            </div>
          </>
        )}
      </div>

      {cta.href ? (
        <a className="btn lg" href={cta.href} target="_blank" rel="noreferrer" style={{ display: "grid", placeItems: "center", textDecoration: "none", marginTop: 8 }}>
          {cta.label}
        </a>
      ) : (
        <button type="button" className="btn lg" style={{ marginTop: 8 }} disabled={cta.disabled} onClick={cta.onClick}>
          {busy && <span className="spin" style={{ marginRight: 8 }} />}
          {cta.label}
        </button>
      )}
      <p className="muted fine">Settles as one atomic {NETWORK_LABEL} transaction. Your coins never leave your wallet until it confirms.</p>

      {picker && (
        <TokenPicker
          selected={picker === "pay" ? pay : receive}
          exclude={null}
          onSelect={(id) => choose(picker, id)}
          onClose={() => setPicker(null)}
        />
      )}
    </main>
  );
}

