import { describe, expect, it } from "vitest";
import {
  AmountError,
  atomicToDisplayPrice,
  cmpRatio,
  displayPrice,
  formatCompact,
  formatPercent,
  formatPrice,
  formatUnits,
  isDecimalInput,
  mulDiv,
  parseDecimalRatio,
  parseUnits,
  quoteForBase,
  ratio,
  ratioToDecimal,
  tryParseUnits,
} from "./amount";

describe("parseUnits", () => {
  it("parses decimals exactly", () => {
    expect(parseUnits("1", 8)).toBe(100_000_000n);
    expect(parseUnits("0.00000001", 8)).toBe(1n);
    expect(parseUnits("1,284.50", 8)).toBe(128_450_000_000n);
    expect(parseUnits(".5", 2)).toBe(50n);
    expect(parseUnits("5.", 2)).toBe(500n);
    expect(parseUnits("21000000", 8)).toBe(2_100_000_000_000_000n);
    expect(parseUnits("1.10", 1)).toBe(11n); // trailing zeros beyond precision are fine
  });
  it("is exact where floats are not", () => {
    expect(parseUnits("0.1", 8) + parseUnits("0.2", 8)).toBe(parseUnits("0.3", 8));
    expect(parseUnits("9007199254740993", 0)).toBe(9007199254740993n);
  });
  it("rejects bad input", () => {
    expect(() => parseUnits("", 8)).toThrow(AmountError);
    expect(() => parseUnits(".", 8)).toThrow(AmountError);
    expect(() => parseUnits("-1", 8)).toThrow(AmountError);
    expect(() => parseUnits("1e5", 8)).toThrow(AmountError);
    expect(() => parseUnits("0.001", 2)).toThrow(/2 decimal/);
    expect(() => parseUnits("1.5", 0)).toThrow(/no decimals/);
    expect(tryParseUnits("abc", 2)).toBeNull();
  });
  it("validates partial typing", () => {
    expect(isDecimalInput("", 2)).toBe(true);
    expect(isDecimalInput("1.", 2)).toBe(true);
    expect(isDecimalInput("1.234", 2)).toBe(false);
    expect(isDecimalInput("1.", 0)).toBe(false);
    expect(isDecimalInput("1a", 8)).toBe(false);
  });
});

describe("formatUnits", () => {
  it("round-trips", () => {
    for (const s of ["0", "1", "0.00000001", "123456.789", "21000000"]) {
      expect(formatUnits(parseUnits(s, 8), 8, { group: false })).toBe(s);
    }
  });
  it("groups and truncates", () => {
    expect(formatUnits(128_450_000_000n, 8)).toBe("1,284.5");
    expect(formatUnits(123_456_789n, 8, { maxDecimals: 2 })).toBe("1.23");
    expect(formatUnits(100n, 2, { minDecimals: 2 })).toBe("1.00");
    expect(formatUnits(-150n, 2)).toBe("-1.5");
    expect(formatUnits(5n, 0)).toBe("5");
  });
  it("formats compactly", () => {
    expect(formatCompact(123_456n, 2)).toBe("1,234.56");
    expect(formatCompact(25_000_000n, 2)).toBe("250.00K");
    expect(formatCompact(1_250_000_00n, 2)).toBe("1.25M");
  });
});

describe("rationals & prices", () => {
  it("reduces and compares", () => {
    expect(ratio(10n, 20n)).toEqual({ num: 1n, den: 2n });
    expect(ratio(1n, -2n)).toEqual({ num: -1n, den: 2n });
    expect(cmpRatio(ratio(1n, 3n), ratio(2n, 6n))).toBe(0);
    expect(cmpRatio(ratio(1n, 3n), ratio(1n, 2n))).toBe(-1);
    expect(() => ratio(1n, 0n)).toThrow();
  });
  it("mulDiv rounds as requested", () => {
    expect(mulDiv(10n, 1n, 3n, "floor")).toBe(3n);
    expect(mulDiv(10n, 1n, 3n, "ceil")).toBe(4n);
    expect(mulDiv(5n, 1n, 2n, "round")).toBe(3n);
    expect(mulDiv(9n, 1n, 3n, "ceil")).toBe(3n);
  });
  it("display price scales by precision", () => {
    // 100 ALPHA (p=2 → 10000 atomic) for 2 ECX (p=8 → 2e8 atomic) = 0.02 ECX/ALPHA
    const p = displayPrice(200_000_000n, 10_000n, 2, 8);
    expect(ratioToDecimal(p, 4)).toBe("0.0200");
    expect(atomicToDisplayPrice(ratio(20_000n, 1n), 2, 8)).toEqual(ratio(2n, 100n));
  });
  it("quoteForBase computes totals with rounding in the user's favour", () => {
    const price = parseDecimalRatio("0.0198"); // ECX per ALPHA
    expect(quoteForBase(parseUnits("2500", 2), price, 2, 8, "floor")).toBe(parseUnits("49.5", 8));
    const third = parseDecimalRatio("0.33333333");
    expect(quoteForBase(1n, third, 0, 8, "ceil")).toBe(33_333_333n);
    expect(quoteForBase(1n, ratio(1n, 3n), 0, 8, "floor")).toBe(33_333_333n);
    expect(quoteForBase(1n, ratio(1n, 3n), 0, 8, "ceil")).toBe(33_333_334n);
  });
  it("formats prices and percents", () => {
    expect(formatPrice(ratio(2n, 100n))).toBe("0.0200");
    expect(formatPrice(ratio(114n, 100n))).toBe("1.1400");
    expect(formatPrice(ratio(31n, 10_000n))).toBe("0.00310");
    expect(formatPrice(ratio(123456n, 10n))).toBe("12,345.60");
    expect(formatPrice(null)).toBe("—");
    expect(formatPercent(ratio(4n, 1000n))).toBe("0.40%");
  });
});
