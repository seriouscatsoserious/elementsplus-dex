import { useEffect, useRef, useState } from "react";
import { NavLink } from "react-router";
import { LLMS_TXT_URL, OPENAPI_URL, WALLET_INSTALL_URL, networkLabel } from "../lib/config";
import { shortAddress } from "../lib/wallet";
import { useDex } from "../state/dex";
import { useWallet } from "../state/wallet";
import { Icon } from "./ui";

const LINKS = [
  { to: "/swap", label: "Swap" },
  { to: "/markets", label: "Markets" },
  { to: "/launch", label: "Launch" },
];

function Links({ className }: { className: string }) {
  return (
    <div className={className}>
      {LINKS.map((l) => (
        <NavLink key={l.to} to={l.to} className={({ isActive }) => (isActive ? "on" : undefined)}>
          {l.label}
        </NavLink>
      ))}
    </div>
  );
}

function WalletButton() {
  const w = useWallet();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  switch (w.status) {
    case "detecting":
      return <span className="wal ghost" aria-busy="true"><span className="spin" /></span>;
    case "missing":
      return (
        <a className="wal cta" href={WALLET_INSTALL_URL} target="_blank" rel="noreferrer" style={{ alignItems: "center" }}>
          Install wallet
        </a>
      );
    case "disconnected":
    case "connecting":
      return (
        <button className="wal cta" type="button" onClick={() => void w.connect()} disabled={w.status === "connecting"}>
          {w.status === "connecting" ? "Check wallet…" : w.locked ? "Unlock wallet" : "Connect wallet"}
        </button>
      );
    case "connected": {
      const addr = w.address ?? "";
      return (
        <div ref={ref} style={{ position: "relative" }}>
          <button className="wal" type="button" onClick={() => setOpen((o) => !o)} aria-haspopup="menu" aria-expanded={open}>
            <span className="av">A</span>
            <span className="mono">{shortAddress(addr)}</span>
            {w.locked && <span className="tag">LOCKED</span>}
          </button>
          {open && (
            <div className="menu" role="menu">
              <div className="menu-item muted mono" style={{ fontSize: 12, wordBreak: "break-all", whiteSpace: "normal" }}>
                {addr}
              </div>
              <button type="button" role="menuitem" onClick={() => { void navigator.clipboard?.writeText(addr); setOpen(false); }}>
                <Icon.copy /> Copy address
              </button>
              <button type="button" role="menuitem" onClick={() => { setOpen(false); void w.disconnect(); }}>
                Disconnect
              </button>
            </div>
          )}
        </div>
      );
    }
  }
}

export function Header() {
  const dex = useDex();
  const w = useWallet();
  // The server reports the network profile id; a connected wallet reports its own display name.
  const name = w.network?.name || networkLabel(dex.health?.network);
  return (
    <>
      <nav className="nav">
        <NavLink className="logo" to="/swap">
          <span className="lm">E+</span>Swap
        </NavLink>
        <Links className="links" />
        <span className="sp" />
        <span className="net" title={dex.serverDown ? "DEX server unreachable" : dex.health?.tip != null ? `Tip ${dex.health.tip}` : undefined}>
          <span className={`dot${dex.serverDown ? " off" : ""}`} />
          {name}
        </span>
        <WalletButton />
      </nav>
      <Links className="mobile-links" />
      {dex.serverDown && (
        <div className="banner" role="alert">
          <Icon.alert /> DEX server unreachable — showing cached data. Retrying…
        </div>
      )}
    </>
  );
}

export function Footer() {
  return (
    <footer className="foot">
      <span>Non-custodial · offers settle as atomic swaps</span>
      <span className="sp" />
      <span>
        API: <a href={OPENAPI_URL} target="_blank" rel="noreferrer">OpenAPI</a> · <a href={LLMS_TXT_URL} target="_blank" rel="noreferrer">llms.txt</a>
      </span>
    </footer>
  );
}
