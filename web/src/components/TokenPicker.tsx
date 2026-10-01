import { useMemo, useState } from "react";
import { formatUnits } from "../lib/amount";
import { shortId } from "../lib/wallet";
import { useDex } from "../state/dex";
import { useWallet } from "../state/wallet";
import { Modal, TokenIcon } from "./ui";

/** All asset ids the UI knows about: policy, markets, registry, wallet balances. */
export function useKnownAssets(): string[] {
  const dex = useDex();
  const w = useWallet();
  return useMemo(() => {
    const ids = new Set<string>();
    if (dex.policyAsset) ids.add(dex.policyAsset);
    for (const m of dex.markets ?? []) {
      ids.add(m.base);
      ids.add(m.quote);
    }
    for (const a of dex.assets ?? []) ids.add(a.asset_id);
    for (const [id, v] of w.balances) if (v > 0n) ids.add(id);
    return [...ids];
  }, [dex.policyAsset, dex.markets, dex.assets, w.balances]);
}

export function TokenPicker({ selected, exclude, onSelect, onClose }: { selected: string | null; exclude?: string | null; onSelect: (id: string) => void; onClose: () => void }) {
  const dex = useDex();
  const w = useWallet();
  const known = useKnownAssets();
  const [q, setQ] = useState("");

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const tradable = new Set((dex.markets ?? []).flatMap((m) => [m.base, m.quote]));
    return known
      .map((id) => ({ id, info: dex.info(id), bal: w.balanceOf(id), tradable: tradable.has(id) }))
      .filter((r) => !needle || r.info.ticker.toLowerCase().includes(needle) || r.info.name.toLowerCase().includes(needle) || r.id.startsWith(needle))
      .sort((a, b) => Number(b.info.isPolicy) - Number(a.info.isPolicy) || Number(b.tradable) - Number(a.tradable) || Number(b.bal > 0n) - Number(a.bal > 0n) || a.info.ticker.localeCompare(b.info.ticker));
  }, [known, q, dex, w]);

  return (
    <Modal title="Select a token" onClose={onClose}>
      <div style={{ padding: "4px 16px 8px" }}>
        <label>
          <span className="sr-only">Search tokens</span>
          <input className="search" placeholder="Search name, ticker or asset ID" value={q} onChange={(e) => setQ(e.target.value)} autoFocus />
        </label>
      </div>
      <div className="tok-list">
        {rows.length === 0 && <div className="state">No matching tokens</div>}
        {rows.map((r) => (
          <button
            key={r.id}
            type="button"
            className={`tok-row${r.id === selected ? " on" : ""}`}
            disabled={r.id === exclude}
            onClick={() => {
              onSelect(r.id);
              onClose();
            }}
          >
            <TokenIcon info={r.info} size={34} />
            <span style={{ flex: 1, minWidth: 0 }}>
              <strong>{r.info.ticker}</strong> {!r.info.verified && <span className="tag">UNVERIFIED</span>}
              <div className="muted mono" style={{ fontSize: 12 }}>
                {r.info.verified ? r.info.name + " · " : ""}
                {shortId(r.id)}
              </div>
            </span>
            {r.bal > 0n && <span className="mono">{formatUnits(r.bal, r.info.precision, { maxDecimals: 6 })}</span>}
            {!r.tradable && !r.info.isPolicy && <span className="muted" style={{ fontSize: 12 }}>no market</span>}
          </button>
        ))}
      </div>
    </Modal>
  );
}
