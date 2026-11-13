/**
 * Quantity rules per instrument type.
 *
 * Futures trade in whole contracts and equities in whole shares; forex and
 * crypto in fractional lots. Every quantity input and label goes through these
 * rules so a futures account never offers 0.01 or shows "2.00".
 */

export type InstrumentType = "FOREX" | "FUTURES" | "CRYPTO" | "EQUITIES";

export interface QuantityRules {
  /** True when quantities are whole numbers. */
  whole: boolean;
  step: number;
  min: number;
  defaultQty: number;
  /** Quick-size buttons. */
  quick: readonly number[];
  /** Snap to the step and clamp to the minimum. Non-finite input gives the default. */
  normalize(n: number): number;
  /** Whole and at least 1 for whole-unit instruments; any positive size otherwise. */
  isValid(n: number): boolean;
  /** The number alone, without a unit: "2" for futures, "0.10" for forex. */
  format(n: number): string;
}

const WHOLE: QuantityRules = {
  whole: true,
  step: 1,
  min: 1,
  defaultQty: 1,
  quick: [1, 2, 3, 5, 10],
  normalize: (n) => (Number.isFinite(n) ? Math.max(1, Math.round(n)) : 1),
  isValid: (n) => Number.isInteger(n) && n >= 1,
  format: (n) => String(Math.round(n)),
};

const LOTS: QuantityRules = {
  whole: false,
  step: 0.01,
  min: 0.01,
  defaultQty: 0.1,
  quick: [0.01, 0.05, 0.1, 0.5, 1],
  normalize: (n) => (Number.isFinite(n) ? Math.max(0.01, Math.round(n * 100) / 100) : 0.1),
  // Any positive size: venues such as Hyperliquid trade far below 0.01 and
  // enforce their own size decimals.
  isValid: (n) => Number.isFinite(n) && n > 0,
  format: (n) => n.toFixed(2),
};

export function quantityRules(instrumentType: InstrumentType | undefined | null): QuantityRules {
  return instrumentType === "FUTURES" || instrumentType === "EQUITIES" ? WHOLE : LOTS;
}

/** "contracts", "shares" or "lots". */
export function quantityUnit(instrumentType: InstrumentType | undefined | null): string {
  return instrumentType === "FUTURES" ? "contracts" : instrumentType === "EQUITIES" ? "shares" : "lots";
}
