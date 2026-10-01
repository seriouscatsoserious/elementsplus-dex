// Exact amount & price math. Amounts are atomic BigInts; prices are BigInt
// rationals. Floats are never used for amounts (only for chart rendering).

export class AmountError extends Error {}

const DECIMAL_RE = /^(\d*)(?:\.(\d*))?$/;

/** Strip grouping separators / whitespace a user may type ("1,234.5 "). */
export function normalizeDecimalInput(s: string): string {
  return s.replace(/[\s,_]/g, "");
}

export function pow10(n: number): bigint {
  if (!Number.isInteger(n) || n < 0) throw new AmountError(`bad exponent ${n}`);
  return 10n ** BigInt(n);
}

/** Decimal string → atomic units. Throws on malformed / negative / too precise input. */
export function parseUnits(input: string, precision: number): bigint {
  const s = normalizeDecimalInput(input);
  const m = DECIMAL_RE.exec(s);
  if (!m || s === "" || s === ".") throw new AmountError("Enter a number");
  const int = m[1] ?? "";
  const frac = (m[2] ?? "").replace(/0+$/, "");
  if (frac.length > precision) {
    throw new AmountError(
      precision === 0 ? "This asset has no decimals" : `At most ${precision} decimal places`,
    );
  }
  return BigInt(int || "0") * pow10(precision) + BigInt((frac.padEnd(precision, "0")) || "0");
}

export function tryParseUnits(input: string, precision: number): bigint | null {
  try {
    return parseUnits(input, precision);
  } catch {
    return null;
  }
}

/** True if the string is a syntactically acceptable partial decimal while typing. */
export function isDecimalInput(s: string, precision: number): boolean {
  const n = normalizeDecimalInput(s);
  if (n === "") return true;
  const m = DECIMAL_RE.exec(n);
  if (!m) return false;
  if (precision === 0 && n.includes(".")) return false;
  return (m[2] ?? "").length <= precision;
}

function groupInt(s: string): string {
  return s.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

export interface FormatOptions {
  /** Insert thousands separators (default true). */
  group?: boolean;
  /** Cap displayed decimals (rounds down). Default: full precision. */
  maxDecimals?: number;
  /** Always show at least this many decimals (default 0, trailing zeros trimmed). */
  minDecimals?: number;
}

/** Atomic units → decimal string. Exact unless maxDecimals truncates. */
export function formatUnits(v: bigint, precision: number, opts: FormatOptions = {}): string {
  const { group = true, maxDecimals = precision, minDecimals = 0 } = opts;
  const neg = v < 0n;
  let a = neg ? -v : v;
  const base = pow10(precision);
  const int = a / base;
  a = a % base;
  let frac = precision > 0 ? a.toString().padStart(precision, "0") : "";
  if (frac.length > maxDecimals) frac = frac.slice(0, maxDecimals);
  frac = frac.replace(/0+$/, "");
  if (frac.length < minDecimals) frac = frac.padEnd(minDecimals, "0");
  const intStr = group ? groupInt(int.toString()) : int.toString();
  return `${neg ? "-" : ""}${intStr}${frac ? "." + frac : ""}`;
}

/** Plain (ungrouped, full precision) string suitable for an input value. */
export function toInputString(v: bigint, precision: number): string {
  return formatUnits(v, precision, { group: false });
}

// ---------------------------------------------------------------- rationals

export interface Ratio {
  num: bigint;
  den: bigint;
}

function gcd(a: bigint, b: bigint): bigint {
  a = a < 0n ? -a : a;
  b = b < 0n ? -b : b;
  while (b) [a, b] = [b, a % b];
  return a;
}

export function ratio(num: bigint, den: bigint): Ratio {
  if (den === 0n) throw new AmountError("division by zero");
  if (den < 0n) {
    num = -num;
    den = -den;
  }
  const g = gcd(num, den) || 1n;
  return { num: num / g, den: den / g };
}

export const cmpRatio = (a: Ratio, b: Ratio): number => {
  const l = a.num * b.den;
  const r = b.num * a.den;
  return l < r ? -1 : l > r ? 1 : 0;
};
export const mulRatio = (a: Ratio, b: Ratio): Ratio => ratio(a.num * b.num, a.den * b.den);
export const divRatio = (a: Ratio, b: Ratio): Ratio => ratio(a.num * b.den, a.den * b.num);
export const subRatio = (a: Ratio, b: Ratio): Ratio => ratio(a.num * b.den - b.num * a.den, a.den * b.den);

export type Rounding = "floor" | "ceil" | "round";

/** floor/ceil/round(a*b/c) for non-negative a, b and positive c. */
export function mulDiv(a: bigint, b: bigint, c: bigint, mode: Rounding = "floor"): bigint {
  if (c <= 0n) throw new AmountError("mulDiv by non-positive");
  const p = a * b;
  const q = p / c;
  const r = p % c;
  if (r === 0n) return q;
  if (mode === "ceil") return q + 1n;
  if (mode === "round") return 2n * r >= c ? q + 1n : q;
  return q;
}

/** "0.0198" → 198/10000 (exact). */
export function parseDecimalRatio(input: string): Ratio {
  const s = normalizeDecimalInput(input);
  const m = DECIMAL_RE.exec(s);
  if (!m || s === "" || s === ".") throw new AmountError("Enter a number");
  const frac = m[2] ?? "";
  return ratio(BigInt((m[1] ?? "") + frac || "0"), pow10(frac.length));
}

export function tryParseDecimalRatio(input: string): Ratio | null {
  try {
    return parseDecimalRatio(input);
  } catch {
    return null;
  }
}

/** Ratio → fixed decimal string with `decimals` places. */
export function ratioToDecimal(r: Ratio, decimals: number, mode: Rounding = "round", group = true): string {
  const neg = r.num < 0n;
  const n = neg ? -r.num : r.num;
  const scaled = mulDiv(n, pow10(decimals), r.den, mode);
  return (neg && scaled !== 0n ? "-" : "") + formatUnits(scaled, decimals, { group, minDecimals: decimals });
}

/**
 * Display price (quote display units per 1 base display unit) from atomic
 * amounts: (quote / 10^qp) / (base / 10^bp).
 */
export function displayPrice(quoteAtomic: bigint, baseAtomic: bigint, basePrecision: number, quotePrecision: number): Ratio {
  return ratio(quoteAtomic * pow10(basePrecision), baseAtomic * pow10(quotePrecision));
}

/** Atomic-unit price ratio (quote atomic per base atomic) → display ratio. */
export function atomicToDisplayPrice(p: Ratio, basePrecision: number, quotePrecision: number): Ratio {
  return ratio(p.num * pow10(basePrecision), p.den * pow10(quotePrecision));
}

/** Quote atomic amount for `baseAtomic` at display price `price`. */
export function quoteForBase(
  baseAtomic: bigint,
  price: Ratio,
  basePrecision: number,
  quotePrecision: number,
  mode: Rounding,
): bigint {
  return mulDiv(baseAtomic * price.num, pow10(quotePrecision), price.den * pow10(basePrecision), mode);
}

/** Adaptive price formatting: 4 decimals, more for small prices (≈3 significant digits). */
export function formatPrice(r: Ratio | null | undefined): string {
  if (!r) return "—";
  if (r.num === 0n) return "0";
  const n = r.num < 0n ? -r.num : r.num;
  if (n >= r.den * 1000n) return ratioToDecimal(r, 2);
  if (n >= r.den) return ratioToDecimal(r, 4);
  // count leading fractional zeros
  let lz = 0;
  let x = n * 10n;
  while (x < r.den && lz < 18) {
    lz++;
    x *= 10n;
  }
  return ratioToDecimal(r, Math.max(4, lz + 3));
}

/** Ratio as a percentage string, e.g. 0.004 → "0.40%". */
export function formatPercent(r: Ratio, decimals = 2): string {
  return ratioToDecimal(mulRatio(r, ratio(100n, 1n)), decimals) + "%";
}

/** Decimal string (possibly with exponent-free sign) → Ratio, or null. Accepts "-1.5". */
export function parseSignedDecimal(s: string): Ratio | null {
  const t = s.trim();
  const neg = t.startsWith("-");
  const r = tryParseDecimalRatio(neg || t.startsWith("+") ? t.slice(1) : t);
  if (!r) return null;
  return neg ? ratio(-r.num, r.den) : r;
}

/** Ratio → float, for charts only. */
export function ratioToNumber(r: Ratio): number {
  return Number(r.num) / Number(r.den);
}

/** Short display for tables: 1.25M / 120.5K / 1,234.56. Truncates (never rounds up). */
export function formatCompact(v: bigint, precision: number): string {
  const unit = pow10(precision);
  const int = v / unit;
  const tiers: [bigint, string][] = [
    [1_000_000_000n, "B"],
    [1_000_000n, "M"],
    [100_000n, "K"],
  ];
  for (const [t, sfx] of tiers) {
    const div = sfx === "K" ? 1_000n : t;
    if (int >= t) return formatUnits((v * 100n) / (div * unit), 2, { minDecimals: 2 }) + sfx;
  }
  return formatUnits(v, precision, { maxDecimals: 2 });
}
