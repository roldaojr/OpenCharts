import { quantityRules, quantityUnit, type InstrumentType } from "../lib/quantity.ts";
import { useTradingStore } from "../services/store.tsx";

/**
 * Returns display labels, formatters and quantity rules that adapt to the
 * current account's instrument type. Futures accounts show "contracts" instead
 * of "lots", and quantities are whole numbers.
 *
 * Subscribes only to the active account's instrumentType — NOT the entire
 * accounts array — so it does not re-render on every equity/balance tick.
 */
export function useInstrumentLabels() {
  // Derive instrumentType with a narrow selector to avoid re-renders on tick updates.
  // The full accounts array is replaced on every WebSocket equity event; subscribing
  // to it directly would cause all callers to re-render on every price tick.
  const instrumentType = useTradingStore((s): InstrumentType => {
    const active = s.accounts.find((a) => a.id === s.activeAccountId);
    return (active?.template?.instrumentType as InstrumentType) ?? "FOREX";
  });
  const isFutures = instrumentType === "FUTURES";
  const qty = quantityRules(instrumentType);
  const unitLabel = quantityUnit(instrumentType);

  return {
    instrumentType,
    isFutures,
    /** Step, minimum, quick sizes and validation for quantity inputs. */
    qty,
    /** "lots" for forex/crypto, "contracts" for futures, "shares" for equities */
    unitLabel,
    /** Capitalised version for use at sentence start */
    unitLabelCap: unitLabel.charAt(0).toUpperCase() + unitLabel.slice(1),
    /** Format a quantity with its unit label: "2 contracts", "0.10 lots". */
    formatQty: (n: number) => `${qty.format(n)} ${unitLabel}`,
  };
}
