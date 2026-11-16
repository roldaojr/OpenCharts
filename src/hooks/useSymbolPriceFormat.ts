import { useMemo } from "react";
import { useSymbols } from "../services/queries.ts";
import { priceFormatterFor } from "../pages/trading/utils.ts";

/**
 * `(symbolName, price) => string` with each symbol's tick decimals
 * (ES 5000.25 → "5,000.25"). Unknown symbols fall back to the name heuristic.
 */
export function useSymbolPriceFormat(): (symbolName: string, price: number) => string {
  const { data: symbols } = useSymbols();
  return useMemo(() => priceFormatterFor(symbols ?? []), [symbols]);
}
