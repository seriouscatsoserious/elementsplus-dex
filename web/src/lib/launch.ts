import { formatUnits, quoteForBase, tryParseDecimalRatio, tryParseUnits } from "./amount";

/** Elements MAX_MONEY in atomic units. */
export const MAX_ISSUANCE = 2_100_000_000_000_000n;

export interface LaunchFields {
  name: string;
  ticker: string;
  supply: string;
  decimals: string;
  website: string;
  list: boolean;
  listAmount: string;
  listPrice: string;
}

export type LaunchErrors = Partial<Record<keyof LaunchFields, string>>;

/** Mirrors the server's registry rules (name 1-255, ticker 3-24 [A-Za-z0-9.-], precision 0-8). */
export function validateLaunch(f: LaunchFields): LaunchErrors {
  const e: LaunchErrors = {};
  const name = f.name.trim();
  const nameBytes = new TextEncoder().encode(name).length;
  if (nameBytes < 1) e.name = "Required";
  else if (nameBytes > 255) e.name = "At most 255 bytes";
  if (!f.ticker) e.ticker = "Required";
  else if (!/^[A-Za-z0-9.-]{3,24}$/.test(f.ticker)) e.ticker = "3–24 letters, digits, . or -";
  const dec = /^\d$/.test(f.decimals) ? Number(f.decimals) : NaN;
  if (!(dec >= 0 && dec <= 8)) e.decimals = "0 to 8";
  const supply = Number.isNaN(dec) ? null : tryParseUnits(f.supply || "0", dec);
  if (!f.supply) e.supply = "Required";
  else if (supply === null) e.supply = Number.isNaN(dec) ? "Set decimals first" : `At most ${dec} decimals`;
  else if (supply <= 0n) e.supply = "Must be more than 0";
  else if (supply > MAX_ISSUANCE) e.supply = `Max ${formatUnits(MAX_ISSUANCE, dec)}`;
  if (f.website && !/^https?:\/\/[^\s/$.?#].[^\s]*$/i.test(f.website)) e.website = "Enter an http(s) URL";
  if (f.list) {
    const la = Number.isNaN(dec) ? null : tryParseUnits(f.listAmount || "0", dec);
    if (!f.listAmount) e.listAmount = "Required";
    else if (la === null) e.listAmount = `At most ${dec} decimals`;
    else if (la <= 0n) e.listAmount = "Must be more than 0";
    else if (supply !== null && la > supply) e.listAmount = "More than the supply";
    const p = tryParseDecimalRatio(f.listPrice);
    if (!f.listPrice) e.listPrice = "Required";
    else if (!p || p.num <= 0n) e.listPrice = "Must be more than 0";
    else if (la && la > 0n && quoteForBase(la, p, dec, 8, "ceil") <= 0n) e.listPrice = "Too low";
  }
  return e;
}

