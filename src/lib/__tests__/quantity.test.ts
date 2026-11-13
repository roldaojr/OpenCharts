import { describe, expect, it } from "vitest";
import { quantityRules, quantityUnit } from "../quantity.ts";

describe("quantityRules", () => {
  it("uses whole contracts for futures", () => {
    const r = quantityRules("FUTURES");
    expect(r).toMatchObject({ whole: true, step: 1, min: 1, defaultQty: 1 });
    expect(r.quick).toEqual([1, 2, 3, 5, 10]);
    expect(r.isValid(2)).toBe(true);
    expect(r.isValid(1.5)).toBe(false);
    expect(r.isValid(0)).toBe(false);
    expect(r.normalize(0.1)).toBe(1);
    expect(r.normalize(2.6)).toBe(3);
    expect(r.normalize(NaN)).toBe(1);
    expect(r.format(2)).toBe("2");
    expect(quantityUnit("FUTURES")).toBe("contracts");
  });

  it("keeps fractional lots for forex and crypto", () => {
    for (const t of ["FOREX", "CRYPTO", undefined] as const) {
      const r = quantityRules(t);
      expect(r).toMatchObject({ whole: false, step: 0.01, min: 0.01, defaultQty: 0.1 });
      expect(r.isValid(0.1)).toBe(true);
      // Venue-specific sizes below 0.01 stay valid (e.g. Hyperliquid BTC).
      expect(r.isValid(0.00016)).toBe(true);
      expect(r.isValid(0)).toBe(false);
      expect(r.normalize(0.123)).toBe(0.12);
      expect(r.normalize(0)).toBe(0.01);
      expect(r.format(0.1)).toBe("0.10");
    }
    expect(quantityUnit("FOREX")).toBe("lots");
  });

  it("treats equities as whole shares", () => {
    expect(quantityRules("EQUITIES").whole).toBe(true);
    expect(quantityUnit("EQUITIES")).toBe("shares");
  });
});
