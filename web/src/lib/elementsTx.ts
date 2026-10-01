// Minimal Elements transaction reader: just enough to read the first input's
// outpoint from an offer tx (SPEC §2) so the UI can cancel / identify offers.

const OUTPOINT_INDEX_MASK = 0x3fffffff; // strips issuance (1<<31) and peg-in (1<<30) flags

function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(hex)) throw new Error("invalid hex");
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function readVarInt(b: Uint8Array, o: number): [number, number] {
  const first = b[o];
  if (first === undefined) throw new Error("truncated");
  if (first < 0xfd) return [first, o + 1];
  if (first === 0xfd) return [(b[o + 1] ?? 0) | ((b[o + 2] ?? 0) << 8), o + 3];
  if (first === 0xfe)
    return [((b[o + 1] ?? 0) | ((b[o + 2] ?? 0) << 8) | ((b[o + 3] ?? 0) << 16) | ((b[o + 4] ?? 0) << 24)) >>> 0, o + 5];
  throw new Error("varint too large");
}

export interface Outpoint {
  txid: string;
  vout: number;
}

/** First input's prevout of an Elements tx (hex). Throws on malformed input. */
export function firstInputOutpoint(txHex: string): Outpoint {
  const b = hexToBytes(txHex);
  let o = 4; // version
  o += 1; // Elements witness flag byte
  const [count, next] = readVarInt(b, o);
  o = next;
  if (count < 1) throw new Error("no inputs");
  if (b.length < o + 36) throw new Error("truncated");
  const hash = b.slice(o, o + 32).reverse();
  const txid = Array.from(hash, (x) => x.toString(16).padStart(2, "0")).join("");
  const idx = ((b[o + 32] ?? 0) | ((b[o + 33] ?? 0) << 8) | ((b[o + 34] ?? 0) << 16) | ((b[o + 35] ?? 0) << 24)) >>> 0;
  return { txid, vout: idx === 0xffffffff ? idx : idx & OUTPOINT_INDEX_MASK };
}

/** Build a syntactically valid 1-in/1-out tx stub (mock mode + tests only). */
export function stubOfferTxHex(txid: string, vout: number): string {
  const le32 = (n: number) =>
    [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff].map((x) => x.toString(16).padStart(2, "0")).join("");
  const rev = txid.match(/../g)!.reverse().join("");
  // version 2, flag 0, 1 input, prevout, empty scriptSig, sequence, 0 outputs, locktime
  return "02000000" + "00" + "01" + rev + le32(vout) + "00" + "ffffffff" + "00" + "00000000";
}
