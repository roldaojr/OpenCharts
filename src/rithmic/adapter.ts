import { safeStorage } from "../lib/safe-storage.ts";
import type { OpenChartsAdapter, StorageDriver } from "../adapter/types.ts";
import { createRithmicMarketData, type RithmicMarketData } from "./marketData.ts";
import type { RithmicSession } from "./session.ts";
import { RithmicSymbolRegistry } from "./symbols.ts";
import { createRithmicTrading, type RithmicTradingGateway } from "./trading.ts";
import type { RithmicProduct } from "./config.ts";

export const RITHMIC_ADAPTER_NAME = "rithmic";

export interface RithmicAdapterOptions {
  /** A session that is (or is about to be) logged in. */
  session: RithmicSession;
  /** Products resolved to front-month contracts for the symbol list. */
  products: readonly RithmicProduct[];
  /** Where chart state goes; defaults to localStorage namespaced by user. */
  storage?: StorageDriver;
}

export interface RithmicAdapter extends OpenChartsAdapter {
  name: typeof RITHMIC_ADAPTER_NAME;
  marketData: RithmicMarketData;
  trading: RithmicTradingGateway;
  registry: RithmicSymbolRegistry;
  session: RithmicSession;
  /** Stop streams and log out of every plant. */
  dispose(): void;
}

/** Drawings, templates and journal entries follow the Rithmic user. */
export function createUserStorage(user: string, store: Pick<Storage, "getItem" | "setItem" | "removeItem"> = safeStorage): StorageDriver {
  const k = (key: string) => `rithmic:${user.toLowerCase()}:${key}`;
  return {
    get: (key) => store.getItem(k(key)),
    set: (key, value) => {
      store.setItem(k(key), value);
    },
    remove: (key) => {
      store.removeItem(k(key));
    },
  };
}

/**
 * The Rithmic broker as an OpenCharts adapter: market data from the ticker and
 * history plants, orders and positions from the order and PnL plants.
 *
 * ```ts
 * const session = new RithmicSession({ config, credentials });
 * await session.connect();
 * const adapter = createRithmicAdapter({ session, products: config.products });
 * <OpenChartsProvider adapter={adapter}><Terminal /></OpenChartsProvider>
 * ```
 *
 * `marketData.disconnect()` only stops streaming (the provider calls it on
 * every unmount, including React StrictMode's rehearsal); `dispose()` is what
 * logs out.
 */
export function createRithmicAdapter(opts: RithmicAdapterOptions): RithmicAdapter {
  const { session } = opts;
  const registry = new RithmicSymbolRegistry(session.ticker, opts.products);
  const marketData = createRithmicMarketData({ ticker: session.ticker, history: session.history, registry });
  const trading = createRithmicTrading({
    order: session.order,
    pnl: session.pnl,
    registry,
    marketData,
    user: session.user,
  });
  return {
    name: RITHMIC_ADAPTER_NAME,
    marketData,
    trading,
    storage: opts.storage ?? createUserStorage(session.user),
    registry,
    session,
    dispose() {
      marketData.disconnect?.();
      trading.dispose();
      session.dispose();
    },
  };
}
