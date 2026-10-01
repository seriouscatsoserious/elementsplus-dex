import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";
import { ApiError, ApiUnavailableError } from "../lib/api";
import { txUrl } from "../lib/config";
import { WalletError, describeWalletError } from "../lib/wallet";
import { shortId } from "../lib/wallet";

export interface Toast {
  id: number;
  kind: "success" | "error" | "info";
  title: string;
  detail?: string;
  txid?: string;
  action?: { label: string; onClick: () => void };
}

interface ToastApi {
  push(t: Omit<Toast, "id">): void;
  /** Present any thrown error (wallet / API / other) appropriately. */
  error(e: unknown, context?: string): void;
}

const Ctx = createContext<ToastApi | null>(null);

export function useToast(): ToastApi {
  const c = useContext(Ctx);
  if (!c) throw new Error("ToastProvider missing");
  return c;
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const seq = useRef(0);
  const dismiss = useCallback((id: number) => setToasts((ts) => ts.filter((t) => t.id !== id)), []);

  const push = useCallback(
    (t: Omit<Toast, "id">) => {
      const id = ++seq.current;
      setToasts((ts) => [...ts.slice(-3), { ...t, id }]);
      setTimeout(() => dismiss(id), t.kind === "error" ? 10000 : t.txid ? 9000 : 5000);
    },
    [dismiss],
  );

  const error = useCallback(
    (e: unknown, context?: string) => {
      if (e instanceof WalletError) {
        const p = describeWalletError(e);
        push({ kind: p.quiet ? "info" : "error", title: p.title, detail: p.detail });
        return;
      }
      if (e instanceof ApiUnavailableError) {
        push({ kind: "error", title: "DEX server unreachable", detail: context });
        return;
      }
      if (e instanceof ApiError) {
        push({ kind: "error", title: context ?? "Server rejected the request", detail: e.message });
        return;
      }
      push({ kind: "error", title: context ?? "Something went wrong", detail: e instanceof Error ? e.message : String(e) });
    },
    [push],
  );

  const value = useMemo(() => ({ push, error }), [push, error]);
  return (
    <Ctx.Provider value={value}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((t) => {
          const link = t.txid ? txUrl(t.txid) : undefined;
          return (
            <div key={t.id} className={`toast toast-${t.kind}`}>
              <div className="toast-body">
                <strong>{t.title}</strong>
                {t.detail && <div className="muted">{t.detail}</div>}
                {t.txid && (
                  <div className="mono muted toast-tx">
                    {link ? (
                      <a href={link} target="_blank" rel="noreferrer">
                        tx {shortId(t.txid)}
                      </a>
                    ) : (
                      <button type="button" className="linkish" onClick={() => void navigator.clipboard?.writeText(t.txid!)} title="Copy txid">
                        tx {shortId(t.txid)} · copy
                      </button>
                    )}
                  </div>
                )}
                {t.action && (
                  <button
                    type="button"
                    className="linkish"
                    onClick={() => {
                      dismiss(t.id);
                      t.action!.onClick();
                    }}
                  >
                    {t.action.label}
                  </button>
                )}
              </div>
              <button type="button" className="toast-x" aria-label="Dismiss" onClick={() => dismiss(t.id)}>
                ×
              </button>
            </div>
          );
        })}
      </div>
    </Ctx.Provider>
  );
}
