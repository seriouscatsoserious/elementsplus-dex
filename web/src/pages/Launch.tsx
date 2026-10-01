import { useEffect, useMemo, useState, type FormEvent } from "react";
import { validateLaunch, type LaunchFields } from "../lib/launch";
import { Link } from "react-router";
import { CopyText, Icon } from "../components/ui";
import { formatUnits, isDecimalInput, quoteForBase, tryParseDecimalRatio, tryParseUnits } from "../lib/amount";
import { WALLET_INSTALL_URL } from "../lib/config";
import { rememberOffer } from "../lib/myOffers";
import { estimateIssuanceFee, estimateSplitFee } from "../lib/route";
import type { IssueResult, Offer } from "../lib/types";
import { WalletError, WalletErrorCode, shortId } from "../lib/wallet";
import { api } from "../state/api";
import { useDex } from "../state/dex";
import { useToast } from "../state/toast";
import { useWallet } from "../state/wallet";

type StepStatus = "idle" | "active" | "done" | "error" | "skipped";
interface Progress {
  issue: StepStatus;
  register: StepStatus;
  list: StepStatus;
  note?: string;
}
const IDLE: Progress = { issue: "idle", register: "idle", list: "idle" };

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

function StepDot({ n, s }: { n: number; s: StepStatus }) {
  return (
    <span className={`step-dot ${s}`} aria-label={s}>
      {s === "done" ? <Icon.check /> : s === "active" ? <span className="spin" style={{ width: 11, height: 11 }} /> : s === "error" ? "!" : n}
    </span>
  );
}

export function LaunchPage() {
  const w = useWallet();
  const dex = useDex();
  const toast = useToast();
  const [f, setF] = useState<LaunchFields>({ name: "", ticker: "", supply: "", decimals: "8", website: "", list: true, listAmount: "", listPrice: "" });
  const [description, setDescription] = useState("");
  const [mintable, setMintable] = useState(false);
  const [icon, setIcon] = useState<string | null>(null);
  const [touched, setTouched] = useState<Set<string>>(new Set());
  const [submitted, setSubmitted] = useState(false);
  const [progress, setProgress] = useState<Progress>(IDLE);
  const [result, setResult] = useState<IssueResult | null>(null);
  const [pendingOffer, setPendingOffer] = useState<Offer | null>(null);
  const busy = progress.issue === "active" || progress.register === "active" || progress.list === "active";

  useEffect(() => () => void (icon && URL.revokeObjectURL(icon)), [icon]);

  const errors = useMemo(() => validateLaunch(f), [f]);
  const show = (k: keyof LaunchFields) => (submitted || touched.has(k) ? errors[k] : undefined);
  const set = <K extends keyof LaunchFields>(k: K, v: LaunchFields[K]) => setF((s) => ({ ...s, [k]: v }));
  const touch = (k: string) => setTouched((t) => new Set(t).add(k));

  const dec = /^\d$/.test(f.decimals) ? Math.min(8, Number(f.decimals)) : 8;
  const supplyAtomic = tryParseUnits(f.supply || "0", dec);
  const tickerShown = f.ticker.toUpperCase() || "TICKER";
  const fee = estimateIssuanceFee(mintable) + (f.list ? estimateSplitFee() : 0n);
  const policy = dex.policyAsset;
  const ecxBal = w.balanceOf(policy);
  const listWant = (() => {
    const la = tryParseUnits(f.listAmount || "0", dec);
    const p = tryParseDecimalRatio(f.listPrice);
    return la && p && p.num > 0n ? quoteForBase(la, p, dec, 8, "ceil") : null;
  })();

  async function listOffer(r: IssueResult) {
    if (!w.client || !policy) return;
    const la = tryParseUnits(f.listAmount, dec)!;
    setProgress((p) => ({ ...p, list: "active", note: undefined }));
    try {
      const offer = pendingOffer ?? (await w.client.makeSwapOffer({ giveAsset: r.assetId, giveAmount: la, wantAsset: policy, wantAmount: listWant! })).offer;
      setPendingOffer(offer);
      if (w.address) rememberOffer(w.address, offer);
      await api.postOffer(offer);
      setPendingOffer(null);
      setProgress((p) => ({ ...p, list: "done" }));
      void dex.refetchMarkets();
    } catch (e) {
      setProgress((p) => ({ ...p, list: "error", note: e instanceof Error ? e.message : String(e) }));
      toast.error(e, "Listing failed");
    }
  }

  async function submit(ev: FormEvent) {
    ev.preventDefault();
    setSubmitted(true);
    if (Object.keys(errors).length || !w.client || w.status !== "connected" || supplyAtomic === null) return;
    if (f.list && !policy) {
      toast.push({ kind: "error", title: "Unknown policy asset", detail: "Can't price the listing in ECX yet." });
      return;
    }
    setResult(null);
    setPendingOffer(null);
    setProgress({ issue: "active", register: "idle", list: f.list ? "idle" : "skipped" });
    let r: IssueResult;
    try {
      r = await w.client.issueAsset({ name: f.name.trim(), ticker: f.ticker, precision: dec, amount: supplyAtomic, tokenAmount: mintable ? 1n : 0n });
    } catch (e) {
      const rejected = e instanceof WalletError && e.code === WalletErrorCode.USER_REJECTED;
      setProgress(rejected ? IDLE : { ...IDLE, issue: "error", note: e instanceof Error ? e.message : String(e) });
      toast.error(e, "Issuance failed");
      return;
    }
    setResult(r);
    setProgress((p) => ({ ...p, issue: "done", register: "active" }));
    void w.refreshBalances();

    // Register (server fetches + verifies the issuance tx; retry briefly while it propagates).
    let registered = false;
    let lastErr: unknown;
    for (let attempt = 0; attempt < 4 && !registered; attempt++) {
      try {
        await api.registerAsset({ issuance_txid: r.txid, vin: r.vin, contract: r.contract, description: description.trim() || undefined, website: f.website.trim() || undefined });
        registered = true;
      } catch (e) {
        lastErr = e;
        await wait(1500 * (attempt + 1));
      }
    }
    if (registered) {
      setProgress((p) => ({ ...p, register: "done" }));
      void dex.refetchAssets();
    } else {
      setProgress((p) => ({ ...p, register: "error", note: `Issued, but registry update failed: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}` }));
    }
    if (f.list) await listOffer(r);
    toast.push({ kind: "success", title: `${f.ticker} issued`, txid: r.txid });
  }

  const ctaLabel =
    w.status === "missing" ? "Install wallet" : w.status !== "connected" ? (w.status === "connecting" ? "Check your wallet…" : "Connect wallet") : busy ? "Confirm in wallet…" : "Create token";

  return (
    <div className="wrap">
      <form style={{ display: "flex", flexDirection: "column", gap: 16 }} onSubmit={(e) => void submit(e)} noValidate>
        <h1 style={{ margin: "0 0 4px", fontSize: 24, fontWeight: 600 }}>Launch a token</h1>
        <div className="two">
          <label className="f">
            <span>Name</span>
            <input className={`in${show("name") ? " bad" : ""}`} value={f.name} maxLength={255} placeholder="Nova" onChange={(e) => set("name", e.target.value)} onBlur={() => touch("name")} disabled={busy} />
            {show("name") && <small className="err-text">{show("name")}</small>}
          </label>
          <label className="f">
            <span>Ticker</span>
            <input className={`in${show("ticker") ? " bad" : ""}`} value={f.ticker} maxLength={24} placeholder="NOVA" onChange={(e) => set("ticker", e.target.value.replace(/\s/g, ""))} onBlur={() => touch("ticker")} disabled={busy} autoCapitalize="characters" />
            {show("ticker") && <small className="err-text">{show("ticker")}</small>}
          </label>
        </div>
        <div className="two keep">
          <label className="f">
            <span>Total supply</span>
            <input className={`in mono${show("supply") ? " bad" : ""}`} value={f.supply} inputMode="decimal" placeholder="21,000,000" onChange={(e) => isDecimalInput(e.target.value, dec) && set("supply", e.target.value)} onBlur={() => touch("supply")} disabled={busy} />
            {show("supply") && <small className="err-text">{show("supply")}</small>}
          </label>
          <label className="f">
            <span>Decimals</span>
            <input className={`in mono${show("decimals") ? " bad" : ""}`} value={f.decimals} inputMode="numeric" maxLength={1} onChange={(e) => /^\d?$/.test(e.target.value) && set("decimals", e.target.value)} onBlur={() => touch("decimals")} disabled={busy} />
            {show("decimals") && <small className="err-text">{show("decimals")}</small>}
          </label>
        </div>
        <label className="f">
          <span>Description</span>
          <textarea className="in" style={{ height: 76, padding: "10px 12px", resize: "none" }} value={description} maxLength={1000} placeholder="A community token on ECX Alpha." onChange={(e) => setDescription(e.target.value)} disabled={busy} />
        </label>
        <div className="two">
          <label className="f">
            <span>Website (optional)</span>
            <input className={`in${show("website") ? " bad" : ""}`} value={f.website} placeholder="https://" inputMode="url" onChange={(e) => set("website", e.target.value.trim())} onBlur={() => touch("website")} disabled={busy} />
            {show("website") && <small className="err-text">{show("website")}</small>}
          </label>
          <label className="f">
            <span>Icon (preview only)</span>
            <input
              className="in"
              type="file"
              accept="image/png,image/jpeg,image/svg+xml,image/webp"
              style={{ padding: "10px 12px" }}
              disabled={busy}
              onChange={(e) => {
                const file = e.target.files?.[0];
                setIcon(file ? URL.createObjectURL(file) : null);
              }}
            />
          </label>
        </div>
        <div className="card" style={{ padding: "4px 18px" }}>
          <label className="sw" style={{ borderTop: 0 }}>
            <span>
              <strong>Allow minting more later</strong>
              <br />
              <small className="muted">Keeps a reissuance token in your wallet</small>
            </span>
            <input type="checkbox" checked={mintable} onChange={(e) => setMintable(e.target.checked)} disabled={busy} />
          </label>
          <label className="sw">
            <span>
              <strong>List on the DEX after issuing</strong>
              <br />
              <small className="muted">Places a sell order for part of the supply</small>
            </span>
            <input type="checkbox" checked={f.list} onChange={(e) => set("list", e.target.checked)} disabled={busy} />
          </label>
          {f.list && (
            <div className="two" style={{ paddingBottom: 14 }}>
              <label className="f">
                <span>Amount to list</span>
                <span className="in-unit">
                  <input className={`in mono${show("listAmount") ? " bad" : ""}`} value={f.listAmount} inputMode="decimal" placeholder="2,100,000" onChange={(e) => isDecimalInput(e.target.value, dec) && set("listAmount", e.target.value)} onBlur={() => touch("listAmount")} disabled={busy} />
                  <em>{tickerShown}</em>
                </span>
                {show("listAmount") && <small className="err-text">{show("listAmount")}</small>}
              </label>
              <label className="f">
                <span>Price per token</span>
                <span className="in-unit">
                  <input className={`in mono${show("listPrice") ? " bad" : ""}`} value={f.listPrice} inputMode="decimal" placeholder="0.003" onChange={(e) => isDecimalInput(e.target.value, 18) && set("listPrice", e.target.value)} onBlur={() => touch("listPrice")} disabled={busy} />
                  <em>ECX</em>
                </span>
                {show("listPrice") && <small className="err-text">{show("listPrice")}</small>}
              </label>
              {listWant !== null && (
                <small className="muted" style={{ gridColumn: "1 / -1", marginTop: -4 }}>
                  Sell order asks {formatUnits(listWant, 8)} ECX in total. It fills whole — one buyer takes all of it.
                </small>
              )}
            </div>
          )}
        </div>
        {w.status === "missing" ? (
          <a className="btn lg" href={WALLET_INSTALL_URL} target="_blank" rel="noreferrer" style={{ display: "grid", placeItems: "center", textDecoration: "none", height: 52 }}>
            Install wallet
          </a>
        ) : (
          <button
            type={w.status === "connected" ? "submit" : "button"}
            className="btn lg"
            style={{ height: 52 }}
            disabled={busy || w.status === "detecting" || w.status === "connecting"}
            onClick={w.status === "connected" ? undefined : () => void w.connect()}
          >
            {busy && <span className="spin" style={{ marginRight: 8 }} />}
            {ctaLabel}
          </button>
        )}
        {submitted && Object.keys(errors).length > 0 && <div className="err-text">Fix the highlighted fields.</div>}
        {w.status === "connected" && policy && w.balancesLoaded && ecxBal < fee && <div className="note warn">You need about {formatUnits(fee, 8)} ECX for network fees.</div>}
      </form>

      <aside style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        <div className="card" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <div className="h">Preview</div>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <span className="tk" style={{ width: 44, height: 44, background: icon ? "var(--surface-2)" : "#E58FD0", fontSize: 13 }}>
              {icon ? <img src={icon} alt="" /> : tickerShown.slice(0, 2)}
            </span>
            <div style={{ minWidth: 0 }}>
              <strong style={{ fontSize: 16, overflowWrap: "anywhere" }}>{f.name.trim() || "Token name"}</strong>
              <div className="muted">
                {tickerShown} · {supplyAtomic && supplyAtomic > 0n ? formatUnits(supplyAtomic, dec) : "0"} supply
              </div>
            </div>
          </div>
          <div className="muted" style={{ fontSize: 12 }}>
            {mintable ? "Reissuable: you can mint more with the reissuance token." : "Fixed supply."} Asset ID is assigned when the issuance confirms.
          </div>
        </div>
        <div className="card">
          <div className="h" style={{ marginBottom: 12 }}>
            {progress.issue === "idle" ? "What happens" : "Progress"}
          </div>
          <ol className="steps">
            <li>
              <StepDot n={1} s={progress.issue} />
              <span>Your wallet asks you to approve one issuance transaction.</span>
            </li>
            <li>
              <StepDot n={2} s={progress.register} />
              <span>The full supply lands in your wallet{progress.issue !== "idle" ? " and the token is registered on the DEX" : ""}.</span>
            </li>
            <li>
              <StepDot n={3} s={f.list || progress.list !== "idle" ? progress.list : "skipped"} />
              <span className={!f.list && progress.list === "idle" ? "muted" : undefined}>If listing is on, you approve a second signature for the sell order.</span>
            </li>
          </ol>
          {progress.note && <div className="note warn" style={{ marginTop: 12 }}>{progress.note}</div>}
          {progress.list === "error" && result && (
            <button type="button" className="btn secondary" style={{ marginTop: 12, height: 38, width: "100%" }} onClick={() => void listOffer(result)}>
              Retry listing
            </button>
          )}
          <div className="muted" style={{ marginTop: 12, fontSize: 12 }}>
            Network fee ≈ {formatUnits(fee, 8)} ECX
          </div>
        </div>
        {result && progress.issue === "done" && !busy && (
          <div className="card" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <div className="h">Issued</div>
            <div className="kv" style={{ padding: 0 }}>
              <span>Asset ID</span>
              <CopyText text={result.assetId}>{shortId(result.assetId)}</CopyText>
            </div>
            <div className="kv" style={{ padding: 0 }}>
              <span>Issuance tx</span>
              <CopyText text={result.txid}>{shortId(result.txid)}</CopyText>
            </div>
            {result.tokenId && (
              <div className="kv" style={{ padding: 0 }}>
                <span>Reissuance token</span>
                <CopyText text={result.tokenId}>{shortId(result.tokenId)}</CopyText>
              </div>
            )}
            {policy && (
              <Link className="btn" style={{ display: "grid", placeItems: "center", textDecoration: "none" }} to={`/markets/${result.assetId}/${policy}`}>
                View market
              </Link>
            )}
          </div>
        )}
      </aside>
    </div>
  );
}
