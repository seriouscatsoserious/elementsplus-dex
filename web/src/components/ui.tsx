import { useEffect, useRef, type ReactNode } from "react";
import type { AssetInfo } from "../state/dex";

export const Icon = {
  chevron: (p: { size?: number }) => (
    <svg className="i" viewBox="0 0 24 24" style={{ width: p.size ?? 14, height: p.size ?? 14 }} aria-hidden="true">
      <path d="m6 9 6 6 6-6" />
    </svg>
  ),
  arrowDown: () => (
    <svg className="i" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 5v14M6 13l6 6 6-6" />
    </svg>
  ),
  gear: () => (
    <svg className="i" viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="3" />
      <path d="M12 2v3M12 19v3M4.9 4.9 7 7M17 17l2.1 2.1M2 12h3M19 12h3M4.9 19.1 7 17M17 7l2.1-2.1" />
    </svg>
  ),
  check: () => (
    <svg className="i" viewBox="0 0 24 24" style={{ width: 13, height: 13, strokeWidth: 3 }} aria-hidden="true">
      <path d="m5 12 5 5 9-10" />
    </svg>
  ),
  copy: () => (
    <svg className="i" viewBox="0 0 24 24" style={{ width: 14, height: 14 }} aria-hidden="true">
      <rect x="9" y="9" width="11" height="11" rx="2" />
      <path d="M5 15V5a2 2 0 0 1 2-2h10" />
    </svg>
  ),
  alert: () => (
    <svg className="i" viewBox="0 0 24 24" style={{ width: 16, height: 16 }} aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 8v5M12 16.5v.01" />
    </svg>
  ),
};

export function TokenIcon({ info, size = 28 }: { info: AssetInfo; size?: number }) {
  const label = info.verified ? info.ticker.slice(0, info.ticker.length <= 3 ? 3 : 2) : "?";
  return (
    <span className="tk" style={{ background: info.color, width: size, height: size, fontSize: size >= 40 ? 13 : 10 }} aria-hidden="true">
      {info.iconUrl ? <img src={info.iconUrl} alt="" /> : label}
    </span>
  );
}

export function StateBox({ title, detail, action, loading }: { title: string; detail?: ReactNode; action?: ReactNode; loading?: boolean }) {
  return (
    <div className="state">
      {loading && <span className="spin" aria-hidden="true" />}
      <strong>{title}</strong>
      {detail && <div>{detail}</div>}
      {action}
    </div>
  );
}

export function Skeleton({ w = "100%", h = 14 }: { w?: number | string; h?: number }) {
  return <span className="skel" style={{ display: "block", width: w, height: h }} />;
}

export function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    ref.current?.querySelector<HTMLElement>("input,button")?.focus();
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={title} ref={ref}>
        <div className="modal-h">
          <h2>{title}</h2>
          <button type="button" className="icon-btn" aria-label="Close" onClick={onClose}>
            ×
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function CopyText({ text, children }: { text: string; children: ReactNode }) {
  return (
    <button type="button" className="copy mono" title="Copy" onClick={() => void navigator.clipboard?.writeText(text)}>
      {children}
    </button>
  );
}
