import type {
  Account,
  ClosedPosition,
  MarketEvent,
  Order,
  OrderModification,
  Page,
  PlaceOrderInput,
  Position,
  PositionModification,
  Quote,
  TradingEvent,
  TradingGateway,
  Unsubscribe,
} from "../adapter/types.ts";
import { roundToTick, TradeError } from "./orders.ts";
import type { RithmicInstrument } from "./symbols.ts";

/**
 * A local paper-trading account that sits next to the real Rithmic accounts.
 *
 * Prices are the live Rithmic quotes; orders never leave the browser. Futures
 * rules: whole contracts, one netted position per symbol, P&L = price move x
 * contracts x point value, no commission and no margin. The whole state is kept
 * in localStorage (under the Rithmic user), so it survives a reload.
 *
 * Order and position ids start with `SIM:` so the combined gateway can route
 * id-only calls (cancel, modify, close) back here.
 */

export const SIM_ACCOUNT_ID = "SIM";
export const SIM_ID_PREFIX = "SIM:";
export const SIM_STARTING_BALANCE = 50_000;
const CLOSED_PAGE_SIZE = 50;
const LIVE_UPDATE_MS = 250;

type Side = "BUY" | "SELL";

interface SimPosition {
  symbol: string;
  /** Signed contracts: positive long, negative short. */
  qty: number;
  entry: number;
  openedAt: string;
  takeProfit: number | null;
  stopLoss: number | null;
}

interface SimOrder {
  id: string;
  symbol: string;
  side: Side;
  type: "LIMIT" | "STOP";
  quantity: number;
  /** Limit price, or the trigger price of a stop. */
  price: number;
  takeProfit: number | null;
  stopLoss: number | null;
  createdAt: string;
}

interface SimState {
  v: 1;
  balance: number;
  seq: number;
  positions: SimPosition[];
  orders: SimOrder[];
  /** Newest first. */
  closed: ClosedPosition[];
}

export interface SimulatorDeps {
  marketData: {
    peekQuote(symbol: string): Quote | null;
    getQuote?(symbol: string): Promise<Quote | null>;
    subscribe(handler: (event: MarketEvent) => void): Unsubscribe;
    /** Keep quotes flowing for symbols the simulator holds, even off screen. */
    setPinnedSymbols?(symbols: string[]): void;
  };
  registry: {
    get(symbol: string): RithmicInstrument | undefined;
    require(symbol: string): Promise<RithmicInstrument>;
  };
  /** Synchronous key/value store, localStorage in the app. */
  store: Pick<Storage, "getItem" | "setItem" | "removeItem">;
  /** Storage key for this user's simulator. */
  key: string;
  user: string;
  now?: () => number;
}

export interface SimulatorTrading extends TradingGateway {
  /** Back to the starting balance with no positions, orders or history. */
  reset(): void;
  dispose(): void;
}

export const isSimulatorId = (id: string | undefined): boolean => id === SIM_ACCOUNT_ID || !!id?.startsWith(SIM_ID_PREFIX);

const initialState = (): SimState => ({ v: 1, balance: SIM_STARTING_BALANCE, seq: 0, positions: [], orders: [], closed: [] });

const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const priceOrNull = (v: unknown): number | null => (num(v) && v > 0 ? v : null);

/** Parse a stored state; anything malformed starts over. */
export function parseSimState(raw: string | null): SimState {
  if (!raw) return initialState();
  try {
    const s = JSON.parse(raw) as Partial<SimState>;
    if (s.v !== 1 || !num(s.balance) || !num(s.seq) || !Array.isArray(s.positions) || !Array.isArray(s.orders) || !Array.isArray(s.closed)) {
      return initialState();
    }
    return {
      v: 1,
      balance: s.balance,
      seq: s.seq,
      positions: s.positions.filter((p) => p && typeof p.symbol === "string" && num(p.qty) && p.qty !== 0 && num(p.entry)),
      orders: s.orders.filter(
        (o) => o && typeof o.id === "string" && (o.side === "BUY" || o.side === "SELL") && (o.type === "LIMIT" || o.type === "STOP") && num(o.quantity) && num(o.price),
      ),
      closed: s.closed.filter((c) => c && typeof c.id === "string"),
    };
  } catch {
    return initialState();
  }
}

export function createSimulatorTrading(deps: SimulatorDeps): SimulatorTrading {
  const { marketData, registry, store, key, user } = deps;
  const now = deps.now ?? Date.now;
  const iso = () => new Date(now()).toISOString();
  const createdAt = iso();

  let state = parseSimState(store.getItem(key));
  const handlers = new Set<(e: TradingEvent) => void>();
  const lastLive = new Map<string, number>();

  const emit = (e: TradingEvent) => {
    for (const h of [...handlers]) {
      try {
        h(e);
      } catch (err) {
        console.error("[simulator] trading handler threw", err);
      }
    }
  };

  const persist = () => {
    try {
      store.setItem(key, JSON.stringify(state));
    } catch (err) {
      console.warn("[simulator] could not save state:", err);
    }
    pinSymbols();
  };

  const pointValue = (symbol: string) => registry.get(symbol)?.pointValue ?? 1;
  const positionId = (symbol: string) => `${SIM_ID_PREFIX}${symbol}`;
  const findPosition = (symbol: string) => state.positions.find((p) => p.symbol === symbol);

  /** Price the position would close at now: the bid for a long, the ask for a short. */
  function markOf(p: SimPosition, quote: Quote | null = marketData.peekQuote(p.symbol)): number | null {
    if (!quote) return null;
    return p.qty > 0 ? quote.bid : quote.ask;
  }

  function openPnl(p: SimPosition, quote?: Quote | null): number {
    const mark = markOf(p, quote);
    return mark === null ? 0 : (mark - p.entry) * p.qty * pointValue(p.symbol);
  }

  function toPosition(p: SimPosition, quote?: Quote | null): Position {
    const mark = markOf(p, quote);
    return {
      id: positionId(p.symbol),
      accountId: SIM_ACCOUNT_ID,
      symbolName: p.symbol,
      side: p.qty > 0 ? "LONG" : "SHORT",
      quantity: Math.abs(p.qty),
      entryPrice: p.entry,
      ...(mark !== null ? { currentPrice: mark } : {}),
      unrealizedPnl: openPnl(p, quote),
      margin: 0,
      contractSize: pointValue(p.symbol),
      openedAt: p.openedAt,
      takeProfit: p.takeProfit,
      stopLoss: p.stopLoss,
    };
  }

  function toOrder(o: SimOrder, status = "PENDING", fill?: { qty: number; price: number }): Order {
    return {
      id: o.id,
      accountId: SIM_ACCOUNT_ID,
      symbolName: o.symbol,
      side: o.side,
      type: o.type,
      quantity: o.quantity,
      price: o.type === "LIMIT" ? o.price : null,
      stopPrice: o.type === "STOP" ? o.price : null,
      takeProfit: o.takeProfit,
      stopLoss: o.stopLoss,
      status,
      filledQuantity: fill?.qty ?? 0,
      avgFillPrice: fill?.price ?? null,
      comment: null,
      createdAt: o.createdAt,
      updatedAt: iso(),
    };
  }

  function account(): Account {
    const open = state.positions.reduce((sum, p) => sum + openPnl(p), 0);
    const equity = state.balance + open;
    return {
      id: SIM_ACCOUNT_ID,
      userId: user,
      templateId: "simulator",
      label: "Simulator",
      status: "ACTIVE",
      balance: state.balance,
      equity,
      margin: 0,
      freeMargin: equity,
      phase: "SIMULATOR",
      startDate: createdAt,
      createdAt,
      updatedAt: iso(),
      isHftMode: false,
      template: { name: "Simulator", startingBalance: SIM_STARTING_BALANCE, instrumentType: "FUTURES" },
    };
  }

  function emitAccount(): void {
    const a = account();
    emit({ type: "account.updated", accountId: SIM_ACCOUNT_ID, equity: a.equity, balance: a.balance, freeMargin: a.freeMargin, marginUsed: 0 });
  }

  /**
   * Apply a fill to the symbol's netted position. Protection (TP/SL) given with
   * the fill is set on whatever position is left open in the fill's direction.
   */
  function applyFill(symbol: string, side: Side, quantity: number, price: number, protection?: { takeProfit: number | null; stopLoss: number | null }): void {
    const signed = side === "BUY" ? quantity : -quantity;
    const pos = findPosition(symbol);
    const t = iso();

    if (!pos) {
      const p: SimPosition = { symbol, qty: signed, entry: price, openedAt: t, takeProfit: protection?.takeProfit ?? null, stopLoss: protection?.stopLoss ?? null };
      state.positions.push(p);
      emit({ type: "position.opened", accountId: SIM_ACCOUNT_ID, positionId: positionId(symbol), entity: toPosition(p) });
      return;
    }

    if (Math.sign(pos.qty) === Math.sign(signed)) {
      const total = Math.abs(pos.qty) + quantity;
      pos.entry = (pos.entry * Math.abs(pos.qty) + price * quantity) / total;
      pos.qty += signed;
      if (protection?.takeProfit != null) pos.takeProfit = protection.takeProfit;
      if (protection?.stopLoss != null) pos.stopLoss = protection.stopLoss;
      emit({ type: "position.updated", accountId: SIM_ACCOUNT_ID, positionId: positionId(symbol), entity: toPosition(pos) });
      return;
    }

    // Opposite side: reduce, close, or flip.
    const closing = Math.min(Math.abs(pos.qty), quantity);
    const direction = Math.sign(pos.qty);
    const realized = (price - pos.entry) * closing * direction * pointValue(symbol);
    state.balance += realized;
    state.seq += 1;
    state.closed.unshift({
      id: `${SIM_ID_PREFIX}c${state.seq}`,
      accountId: SIM_ACCOUNT_ID,
      symbolName: symbol,
      side: direction > 0 ? "LONG" : "SHORT",
      quantity: closing,
      entryPrice: pos.entry,
      exitPrice: price,
      realizedPnl: realized,
      commission: 0,
      swap: 0,
      openedAt: pos.openedAt,
      closedAt: t,
      isPartialClose: closing < Math.abs(pos.qty),
    });
    pos.qty += direction * -closing;

    if (pos.qty === 0) {
      state.positions = state.positions.filter((p) => p !== pos);
      emit({ type: "position.closed", accountId: SIM_ACCOUNT_ID, positionId: positionId(symbol) });
    } else {
      emit({ type: "position.updated", accountId: SIM_ACCOUNT_ID, positionId: positionId(symbol), entity: toPosition(pos) });
    }

    const remainder = quantity - closing;
    if (remainder > 0) applyFill(symbol, side, remainder, price, protection);
  }

  async function marketPrice(symbol: string, side: Side): Promise<number> {
    const q = marketData.peekQuote(symbol) ?? (await marketData.getQuote?.(symbol)) ?? null;
    const price = q ? (side === "BUY" ? q.ask : q.bid) : NaN;
    if (!(price > 0)) throw new TradeError(`No live quote for ${symbol} yet, so the simulator cannot fill a market order.`);
    return price;
  }

  function wholeContracts(quantity: number): number {
    if (!(Number.isInteger(quantity) && quantity >= 1)) {
      throw new TradeError("Futures quantity must be a whole number of contracts (1 or more).");
    }
    return quantity;
  }

  function requireOrder(orderId: string): SimOrder {
    const o = state.orders.find((x) => x.id === orderId);
    if (!o) throw new TradeError("That simulator order is no longer working.");
    return o;
  }

  function requirePosition(id: string): SimPosition {
    const p = state.positions.find((x) => positionId(x.symbol) === id);
    if (!p) throw new TradeError("That simulator position is no longer open.");
    return p;
  }

  function checkAccount(accountId: string | undefined): void {
    if (accountId !== undefined && accountId !== SIM_ACCOUNT_ID) throw new TradeError(`Unknown simulator account "${accountId}".`);
  }

  // ── Live prices ──────────────────────────────────────────

  function onTick(symbol: string, quote: Quote): void {
    let changed = false;

    // Working orders: a buy limit fills at its price once the ask reaches it;
    // a buy stop triggers when the ask rises to it and fills at the ask.
    for (const o of [...state.orders]) {
      if (o.symbol !== symbol) continue;
      const buy = o.side === "BUY";
      const px = buy ? quote.ask : quote.bid;
      const hit = o.type === "LIMIT" ? (buy ? px <= o.price : px >= o.price) : buy ? px >= o.price : px <= o.price;
      if (!hit) continue;
      const fillPrice = o.type === "LIMIT" ? o.price : px;
      state.orders = state.orders.filter((x) => x !== o);
      applyFill(symbol, o.side, o.quantity, fillPrice, { takeProfit: o.takeProfit, stopLoss: o.stopLoss });
      emit({ type: "order.filled", accountId: SIM_ACCOUNT_ID, orderId: o.id, entity: toOrder(o, "FILLED", { qty: o.quantity, price: fillPrice }) });
      changed = true;
    }

    // Protection: take profit fills at its level, stop loss at the market.
    const pos = findPosition(symbol);
    if (pos) {
      const long = pos.qty > 0;
      const exitPx = long ? quote.bid : quote.ask;
      const tpHit = pos.takeProfit !== null && (long ? exitPx >= pos.takeProfit : exitPx <= pos.takeProfit);
      const slHit = pos.stopLoss !== null && (long ? exitPx <= pos.stopLoss : exitPx >= pos.stopLoss);
      if (tpHit || slHit) {
        const price = slHit ? exitPx : pos.takeProfit!;
        applyFill(symbol, long ? "SELL" : "BUY", Math.abs(pos.qty), price);
        changed = true;
      }
    }

    if (changed) {
      persist();
      emitAccount();
      return;
    }

    const live = findPosition(symbol);
    if (!live) return;
    const t = now();
    if (t - (lastLive.get(symbol) ?? 0) < LIVE_UPDATE_MS) return;
    lastLive.set(symbol, t);
    emit({ type: "position.updated", accountId: SIM_ACCOUNT_ID, positionId: positionId(symbol), unrealizedPnl: openPnl(live, quote), entity: toPosition(live, quote) });
    emitAccount();
  }

  const offTicks = marketData.subscribe((e) => {
    if (e.type !== "tick" || !(e.bid > 0) || !(e.ask > 0)) return;
    if (!state.orders.some((o) => o.symbol === e.symbol) && !findPosition(e.symbol)) return;
    onTick(e.symbol, { symbol: e.symbol, bid: e.bid, ask: e.ask, timestamp: e.timestamp ?? now() });
  });
  pinSymbols();

  function pinSymbols(): void {
    marketData.setPinnedSymbols?.([...new Set([...state.positions.map((p) => p.symbol), ...state.orders.map((o) => o.symbol)])]);
  }

  // ── Gateway ──────────────────────────────────────────────

  return {
    async getAccounts() {
      return [account()];
    },

    async getPositions(accountId) {
      checkAccount(accountId);
      return state.positions.map((p) => toPosition(p));
    },

    async getOrders(accountId, status) {
      checkAccount(accountId);
      const wanted = status?.toUpperCase();
      if (wanted && !["PENDING", "NEW", "OPEN", "WORKING"].includes(wanted)) return [];
      return state.orders.map((o) => toOrder(o));
    },

    async getClosedPositions(accountId, page = 1): Promise<Page<ClosedPosition>> {
      checkAccount(accountId);
      const total = state.closed.length;
      const totalPages = Math.max(1, Math.ceil(total / CLOSED_PAGE_SIZE));
      const p = Math.min(Math.max(1, page), totalPages);
      return { data: state.closed.slice((p - 1) * CLOSED_PAGE_SIZE, p * CLOSED_PAGE_SIZE), total, page: p, pageSize: CLOSED_PAGE_SIZE, totalPages };
    },

    async placeOrder(input: PlaceOrderInput): Promise<Order> {
      checkAccount(input.accountId);
      const quantity = wholeContracts(input.quantity);
      const inst = await registry.require(input.symbol);
      const tick = (v: number | undefined) => (v !== undefined && v > 0 ? roundToTick(v, inst.tickSize) : null);
      const protection = { takeProfit: tick(input.takeProfit), stopLoss: tick(input.stopLoss) };
      state.seq += 1;
      const base = { id: `${SIM_ID_PREFIX}o${state.seq}`, symbol: inst.symbol, side: input.side, quantity, ...protection, createdAt: iso() };

      if (input.type === "MARKET") {
        const price = await marketPrice(inst.symbol, input.side);
        applyFill(inst.symbol, input.side, quantity, price, protection);
        const order = toOrder({ ...base, type: "LIMIT", price }, "FILLED", { qty: quantity, price });
        const filled: Order = { ...order, type: "MARKET", price: null };
        persist();
        emit({ type: "order.filled", accountId: SIM_ACCOUNT_ID, orderId: filled.id, entity: filled });
        emitAccount();
        return filled;
      }

      if (input.type !== "LIMIT" && input.type !== "STOP") throw new TradeError(`The simulator does not support ${input.type} orders.`);
      const level = tick(input.type === "LIMIT" ? input.price : (input.stopPrice ?? input.price));
      if (level === null) throw new TradeError(input.type === "LIMIT" ? "A limit order needs a price." : "A stop order needs a stop price.");
      const o: SimOrder = { ...base, type: input.type, price: level };
      state.orders.push(o);
      persist();
      emit({ type: "order.placed", accountId: SIM_ACCOUNT_ID, orderId: o.id, entity: toOrder(o) });
      // A limit already through the market fills on the next tick; check now with the cached quote.
      const q = marketData.peekQuote(o.symbol);
      if (q) onTick(o.symbol, q);
      const still = state.orders.find((x) => x.id === o.id);
      return still ? toOrder(still) : toOrder(o, "FILLED", { qty: o.quantity, price: o.price });
    },

    async modifyOrder(orderId: string, mod: OrderModification): Promise<Order> {
      const o = requireOrder(orderId);
      const inst = registry.get(o.symbol);
      const tick = (v: number) => (inst ? roundToTick(v, inst.tickSize) : v);
      const level = o.type === "LIMIT" ? mod.price : (mod.stopPrice ?? mod.price);
      if (level !== undefined) {
        if (!(level > 0)) throw new TradeError("The price must be positive.");
        o.price = tick(level);
      }
      if (mod.quantity !== undefined) o.quantity = wholeContracts(mod.quantity);
      if (mod.takeProfit !== undefined) o.takeProfit = mod.takeProfit === null ? null : tick(mod.takeProfit);
      if (mod.stopLoss !== undefined) o.stopLoss = mod.stopLoss === null ? null : tick(mod.stopLoss);
      persist();
      const entity = toOrder(o);
      emit({ type: "order.placed", accountId: SIM_ACCOUNT_ID, orderId: o.id, entity });
      return entity;
    },

    async cancelOrder(orderId: string): Promise<void> {
      const o = requireOrder(orderId);
      state.orders = state.orders.filter((x) => x !== o);
      persist();
      emit({ type: "order.canceled", accountId: SIM_ACCOUNT_ID, orderId: o.id, entity: toOrder(o, "CANCELLED") });
    },

    async cancelAllOrders(accountId?: string): Promise<void> {
      checkAccount(accountId);
      const all = state.orders;
      state.orders = [];
      persist();
      for (const o of all) emit({ type: "order.canceled", accountId: SIM_ACCOUNT_ID, orderId: o.id, entity: toOrder(o, "CANCELLED") });
    },

    async closePosition(id: string, quantity?: number): Promise<void> {
      const p = requirePosition(id);
      const qty = quantity === undefined ? Math.abs(p.qty) : Math.min(wholeContracts(quantity), Math.abs(p.qty));
      const side: Side = p.qty > 0 ? "SELL" : "BUY";
      const price = await marketPrice(p.symbol, side);
      applyFill(p.symbol, side, qty, price);
      persist();
      emitAccount();
    },

    async closeAllPositions(accountId?: string): Promise<void> {
      checkAccount(accountId);
      for (const p of [...state.positions]) {
        const side: Side = p.qty > 0 ? "SELL" : "BUY";
        const price = await marketPrice(p.symbol, side);
        applyFill(p.symbol, side, Math.abs(p.qty), price);
      }
      persist();
      emitAccount();
    },

    async modifyPosition(id: string, mod: PositionModification): Promise<Position> {
      const p = requirePosition(id);
      const inst = registry.get(p.symbol);
      const tick = (v: number) => (inst ? roundToTick(v, inst.tickSize) : v);
      if (mod.takeProfit !== undefined) p.takeProfit = priceOrNull(mod.takeProfit) === null ? null : tick(mod.takeProfit!);
      if (mod.stopLoss !== undefined) p.stopLoss = priceOrNull(mod.stopLoss) === null ? null : tick(mod.stopLoss!);
      persist();
      const entity = toPosition(p);
      emit({ type: "position.updated", accountId: SIM_ACCOUNT_ID, positionId: entity.id, entity });
      return entity;
    },

    subscribe(handler) {
      handlers.add(handler);
      return () => {
        handlers.delete(handler);
      };
    },

    reset() {
      const before = state;
      state = initialState();
      persist();
      for (const o of before.orders) emit({ type: "order.canceled", accountId: SIM_ACCOUNT_ID, orderId: o.id, entity: toOrder(o, "CANCELLED") });
      for (const p of before.positions) emit({ type: "position.closed", accountId: SIM_ACCOUNT_ID, positionId: positionId(p.symbol) });
      emitAccount();
    },

    dispose() {
      offTicks();
      marketData.setPinnedSymbols?.([]);
      handlers.clear();
    },
  };
}
