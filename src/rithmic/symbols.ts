import type { Symbol as OcSymbol } from "../adapter/types.ts";
import { isNoData } from "./codec.ts";
import type { RithmicProduct } from "./config.ts";
import type { RithmicPlantConnection } from "./connection.ts";
import { rti } from "./generated/rti.js";
import { T } from "./templates.ts";

/** A tradable Rithmic contract and the reference data orders need. */
export interface RithmicInstrument {
  /** Contract symbol, e.g. "ESZ6". Also the OpenCharts symbol name. */
  symbol: string;
  exchange: string;
  product: string;
  description: string | null;
  tickSize: number;
  /** Currency value of a 1.0 price move for one contract. */
  pointValue: number;
  currency: string;
}

const CATEGORY_BY_PRODUCT: Readonly<Record<string, string>> = {
  ES: "Indices", MES: "Indices", NQ: "Indices", MNQ: "Indices", YM: "Indices", MYM: "Indices",
  RTY: "Indices", M2K: "Indices", EMD: "Indices", NKD: "Indices",
  CL: "Energy", MCL: "Energy", QM: "Energy", NG: "Energy", QG: "Energy", RB: "Energy", HO: "Energy",
  GC: "Metals", MGC: "Metals", SI: "Metals", SIL: "Metals", HG: "Metals", PL: "Metals", PA: "Metals",
  "6A": "Currencies", "6B": "Currencies", "6C": "Currencies", "6E": "Currencies", M6E: "Currencies",
  "6J": "Currencies", "6M": "Currencies", "6N": "Currencies", "6S": "Currencies",
  ZT: "Rates", ZF: "Rates", ZN: "Rates", TN: "Rates", ZB: "Rates", UB: "Rates", SR3: "Rates",
  ZC: "Grains", ZS: "Grains", ZW: "Grains", ZM: "Grains", ZL: "Grains", KE: "Grains",
  LE: "Livestock", HE: "Livestock", GF: "Livestock",
};

export function categoryOf(product: string): string {
  return CATEGORY_BY_PRODUCT[product.toUpperCase()] ?? "Futures";
}

export function instrumentToSymbol(i: RithmicInstrument): OcSymbol {
  return {
    id: i.symbol,
    name: i.symbol,
    displayName: i.description,
    category: categoryOf(i.product),
    contractSize: i.pointValue,
    tickSize: i.tickSize,
    tickValue: i.tickSize * i.pointValue,
    marginPercent: 0,
    maxLeverage: 1,
    commission: 0,
    swapLong: 0,
    swapShort: 0,
    tradingHoursStart: null,
    tradingHoursEnd: null,
    isActive: true,
  };
}

/** Exchange-symbol key used for every per-instrument map. */
export function instrumentKey(symbol: string, exchange: string): string {
  return `${exchange}:${symbol}`;
}

/**
 * Resolves the configured products to contracts and remembers each contract's
 * exchange, which every Rithmic request needs alongside the symbol.
 *
 * Products with a manual `contract` (see config.ts) skip the front-month
 * lookup; the others ask the ticker plant (`RequestFrontMonthContract` 113).
 * Either way `RequestReferenceData` (14) supplies tick size and point value,
 * with the manual specs as the fallback when it has nothing.
 */
export class RithmicSymbolRegistry {
  private readonly bySymbol = new Map<string, RithmicInstrument>();
  private loading: Promise<RithmicInstrument[]> | null = null;
  private loaded: RithmicInstrument[] | null = null;

  constructor(
    private readonly ticker: RithmicPlantConnection,
    private readonly products: readonly RithmicProduct[],
  ) {}

  /** Resolved instruments, in configured order. Products that fail to resolve are skipped. */
  load(): Promise<RithmicInstrument[]> {
    if (this.loaded) return Promise.resolve(this.loaded);
    if (!this.loading) {
      this.loading = this.resolveAll()
        .then((list) => {
          this.loaded = list;
          return list;
        })
        .finally(() => {
          this.loading = null;
        });
    }
    return this.loading;
  }

  /** Drop the cache, e.g. after a contract roll. */
  invalidate(): void {
    this.loaded = null;
  }

  get(symbol: string): RithmicInstrument | undefined {
    return this.bySymbol.get(symbol.toUpperCase()) ?? this.bySymbol.get(symbol);
  }

  /** The instrument for `symbol`, loading the registry first if needed. */
  async require(symbol: string): Promise<RithmicInstrument> {
    const known = this.get(symbol);
    if (known) return known;
    await this.load();
    const found = this.get(symbol);
    if (!found) throw new Error(`Unknown Rithmic symbol "${symbol}"`);
    return found;
  }

  /** Register an instrument seen elsewhere (e.g. a position in a contract not in the list). */
  async learn(symbol: string, exchange: string): Promise<RithmicInstrument | undefined> {
    const known = this.get(symbol);
    if (known) return known;
    try {
      const inst = await this.referenceData(symbol, exchange, symbol.replace(/[FGHJKMNQUVXZ]\d{1,2}$/, ""));
      this.bySymbol.set(inst.symbol, inst);
      return inst;
    } catch {
      return undefined;
    }
  }

  private async resolveAll(): Promise<RithmicInstrument[]> {
    const results = await Promise.allSettled(this.products.map((p) => this.resolveProduct(p)));
    const out: RithmicInstrument[] = [];
    results.forEach((r, i) => {
      if (r.status === "fulfilled") {
        out.push(r.value);
        this.bySymbol.set(r.value.symbol, r.value);
      } else {
        const p = this.products[i];
        console.warn(`[rithmic] could not resolve ${p?.product}:${p?.exchange}`, r.reason);
      }
    });
    if (out.length === 0 && this.products.length > 0) {
      const first = results.find((r): r is PromiseRejectedResult => r.status === "rejected");
      throw new Error(
        `None of the configured Rithmic products could be resolved${first ? `: ${String(first.reason?.message ?? first.reason)}` : ""}`,
      );
    }
    return out;
  }

  private async resolveProduct(p: RithmicProduct): Promise<RithmicInstrument> {
    if (p.contract) {
      try {
        return await this.referenceData(p.contract, p.exchange, p.product, p.description ?? null, p);
      } catch (err) {
        // The manual specs are enough to chart and trade; don't drop the product.
        console.warn(`[rithmic] reference data for ${p.contract} unavailable, using the manual specs`, err);
        return {
          symbol: p.contract,
          exchange: p.exchange,
          product: p.product,
          description: p.description ?? null,
          tickSize: p.tickSize ?? 0.01,
          pointValue: p.pointValue ?? 1,
          currency: "USD",
        };
      }
    }
    const reply = await this.ticker.request<rti.IRequestFrontMonthContract & { templateId: number }, rti.IResponseFrontMonthContract>(
      rti.RequestFrontMonthContract,
      { templateId: T.RequestFrontMonthContract, symbol: p.product, exchange: p.exchange, needUpdates: false },
    );
    const fm = reply.rows[0] ?? reply.last;
    const symbol = fm.tradingSymbol || fm.symbol;
    const exchange = fm.tradingExchange || fm.exchange || p.exchange;
    if (!symbol || symbol === p.product) {
      throw new Error(`No front-month contract for ${p.product} on ${p.exchange}`);
    }
    return this.referenceData(symbol, exchange, p.product, fm.symbolName ?? null);
  }

  private async referenceData(
    symbol: string,
    exchange: string,
    product: string,
    fallbackName: string | null = null,
    fallback: Pick<RithmicProduct, "tickSize" | "pointValue"> = {},
  ): Promise<RithmicInstrument> {
    let ref: rti.IResponseReferenceData | undefined;
    try {
      const reply = await this.ticker.request<rti.IRequestReferenceData & { templateId: number }, rti.IResponseReferenceData>(
        rti.RequestReferenceData,
        { templateId: T.RequestReferenceData, symbol, exchange },
      );
      ref = reply.rows[0] ?? reply.last;
    } catch (err) {
      if (!isNoData(err)) throw err;
    }
    const tickSize = ref?.minQpriceChange && ref.minQpriceChange > 0 ? ref.minQpriceChange : (fallback.tickSize ?? 0.01);
    const pointValue = ref?.singlePointValue && ref.singlePointValue > 0 ? ref.singlePointValue : (fallback.pointValue ?? 1);
    return {
      symbol,
      exchange,
      product: ref?.productCode || product,
      description: ref?.symbolName || fallbackName,
      tickSize,
      pointValue,
      currency: ref?.currency || "USD",
    };
  }
}
