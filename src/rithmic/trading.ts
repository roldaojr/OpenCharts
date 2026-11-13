import type {
  Account,
  ClosedPosition,
  Order,
  OrderModification,
  Page,
  PlaceOrderInput,
  Position,
  PositionModification,
  TradingEvent,
  TradingGateway,
  Unsubscribe,
} from "../adapter/types.ts";
import { RithmicError } from "./codec.ts";
import type { RithmicPlantConnection } from "./connection.ts";
import { rti } from "./generated/rti.js";
import type { RithmicMarketData } from "./marketData.ts";
import { describe } from "./marketData.ts";
import {
  applyExchangeNotification,
  applyRithmicNotification,
  bracketTicks,
  isWorking,
  netQuantity,
  parsePositionId,
  positionId,
  protectionFor,
  roundToTick,
  toAccount,
  toOrder,
  toPosition,
  toTicket,
  TradeError,
  type Protection,
  type RithmicAccountInfo,
  type RithmicOrderState,
} from "./orders.ts";
import type { RithmicInstrument, RithmicSymbolRegistry } from "./symbols.ts";
import { T } from "./templates.ts";

/**
 * Rithmic order routing and account state for the OpenCharts adapter contract.
 *
 * Order plant: login info (300) → accounts (302) → trade routes (310), then per
 * account a subscription to order updates (308) and a snapshot of working
 * orders (320, delivered as 351/352 notifications with is_snapshot).
 * PnL plant: per account a subscription to PnL updates (400) and a snapshot
 * (402, delivered as 450/451 updates).
 *
 * Everything the gateway returns is served from caches those streams keep
 * current; the snapshots are re-run after either plant reconnects.
 *
 * TP/SL: an order with take profit / stop loss is sent as a Rithmic bracket
 * (330). Once the entry fills, the bracket's target and stop are ordinary
 * working orders on the closing side, so a position's TP/SL is read from — and
 * moved by modifying — those orders.
 */

const Manual = rti.RequestNewOrder.OrderPlacement.MANUAL;
const Notify = rti.RithmicOrderNotification.NotifyType;
const PriceType = rti.RequestNewOrder.PriceType;

export interface RithmicTradingDeps {
  order: RithmicPlantConnection;
  pnl: RithmicPlantConnection;
  registry: RithmicSymbolRegistry;
  marketData: Pick<RithmicMarketData, "peekQuote" | "getQuote">;
  user: string;
  now?: () => number;
  /** How long placeOrder/modifyOrder wait for the order's first status (default 3s). */
  ackWaitMs?: number;
}

export interface RithmicTradingGateway extends TradingGateway {
  /** Stop listening and drop caches. */
  dispose(): void;
}

interface Route {
  fcmId: string;
  ibId: string;
  exchange: string;
  tradeRoute: string;
  isDefault: boolean;
  status: string;
}

type OrderWaiter = (state: RithmicOrderState, notify: number | null) => boolean;

export function createRithmicTrading(deps: RithmicTradingDeps): RithmicTradingGateway {
  const { order: orderPlant, pnl: pnlPlant, registry, marketData, user } = deps;
  const now = deps.now ?? Date.now;
  const ackWaitMs = deps.ackWaitMs ?? 3_000;
  const iso = () => new Date(now()).toISOString();

  const handlers = new Set<(e: TradingEvent) => void>();
  const accounts = new Map<string, RithmicAccountInfo>();
  let routes: Route[] = [];
  const orders = new Map<string, RithmicOrderState>();
  const requestedProtection = new Map<string, Protection>();
  const orderWaiters = new Map<string, Set<OrderWaiter>>();
  /** Last RithmicOrderNotification type per order: a notification can beat the order's own reply. */
  const lastNotify = new Map<string, number>();
  const instrumentPnl = new Map<string, rti.IInstrumentPnLPositionUpdate>();
  const accountPnl = new Map<string, rti.IAccountPnLPositionUpdate>();
  const openedAt = new Map<string, string>();
  /** Positions last reported to subscribers, for opened/closed transitions. */
  const emittedPositions = new Map<string, string>();
  const inflight = new Map<string, Promise<Order>>();
  const teardown: Unsubscribe[] = [];
  let tagSeq = 0;
  let ready: Promise<void> | null = null;

  const emit = (event: TradingEvent) => {
    for (const h of [...handlers]) {
      try {
        h(event);
      } catch (err) {
        console.error("[rithmic] trading handler threw", err);
      }
    }
  };

  // ── Identity ──────────────────────────────────────────

  function ids(accountId: string): { fcmId: string; ibId: string; accountId: string } {
    const a = accounts.get(accountId);
    if (!a) throw new TradeError(`Unknown Rithmic account "${accountId}".`);
    return { fcmId: a.fcmId, ibId: a.ibId, accountId: a.accountId };
  }

  function routeFor(accountId: string, exchange: string): string {
    const a = accounts.get(accountId);
    const candidates = routes.filter(
      (r) => r.exchange === exchange && (!a || ((!r.fcmId || r.fcmId === a.fcmId) && (!r.ibId || r.ibId === a.ibId))),
    );
    const usable = candidates.filter((r) => !r.status || /up|open|ok/i.test(r.status));
    const pick = usable.find((r) => r.isDefault) ?? usable[0] ?? candidates.find((r) => r.isDefault) ?? candidates[0];
    if (!pick) throw new TradeError(`No Rithmic trade route to ${exchange} for account ${accountId}.`);
    return pick.tradeRoute;
  }

  // ── Streams ───────────────────────────────────────────

  function protectionOfOrder(s: RithmicOrderState): Protection {
    return requestedProtection.get(s.basketId) ?? { takeProfit: null, stopLoss: null };
  }

  function updateOrder(next: RithmicOrderState, prev: RithmicOrderState | undefined, notify: number | null): void {
    if (!next.basketId) return;
    orders.set(next.basketId, next);
    if (notify !== null) lastNotify.set(next.basketId, notify);
    const waiters = orderWaiters.get(next.basketId);
    if (waiters) {
      for (const w of [...waiters]) if (w(next, notify)) waiters.delete(w);
      if (waiters.size === 0) orderWaiters.delete(next.basketId);
    }
    const entity = toOrder(next, protectionOfOrder(next));
    const base = { accountId: next.accountId, orderId: next.basketId, entity };
    if (next.final !== (prev?.final ?? null)) {
      if (next.final === "FILLED") emit({ type: "order.filled", ...base });
      else if (next.final === "CANCELLED") emit({ type: "order.canceled", ...base });
      else if (next.final === "REJECTED") emit({ type: "order.rejected", ...base });
    } else if (isWorking(next)) {
      // New or modified working order: "placed" upserts it in the terminal.
      emit({ type: "order.placed", ...base });
    }
    // A target/stop leg appearing or going away changes a position's TP/SL.
    refreshPositionsFor(next.accountId, next.symbol);
  }

  function onRithmicNotification(n: rti.RithmicOrderNotification): void {
    if (!n.basketId) return;
    const prev = orders.get(n.basketId);
    updateOrder(applyRithmicNotification(prev, n, iso()), prev, n.notifyType ?? null);
  }

  function onExchangeNotification(n: rti.ExchangeOrderNotification): void {
    if (!n.basketId) return;
    const prev = orders.get(n.basketId);
    updateOrder(applyExchangeNotification(prev, n, iso()), prev, null);
  }

  function currentPrice(symbol: string): number | undefined {
    const q = marketData.peekQuote(symbol);
    return q ? (q.bid + q.ask) / 2 : undefined;
  }

  function buildPosition(raw: rti.IInstrumentPnLPositionUpdate): Position | null {
    if (!raw.accountId || !raw.symbol) return null;
    const id = positionId(raw.accountId, raw.exchange ?? "", raw.symbol);
    const net = netQuantity(raw);
    if (!net) return null;
    let opened = openedAt.get(id);
    if (!opened) {
      opened = iso();
      openedAt.set(id, opened);
    }
    const prot = protectionFor(
      { accountId: raw.accountId, symbol: raw.symbol, side: net > 0 ? "LONG" : "SHORT" },
      orders.values(),
    );
    const inst = registry.get(raw.symbol);
    const price = currentPrice(raw.symbol);
    return toPosition(raw, {
      openedAt: opened,
      ...(price !== undefined ? { currentPrice: price } : {}),
      ...(inst ? { pointValue: inst.pointValue } : {}),
      protection: { takeProfit: prot.takeProfit, stopLoss: prot.stopLoss },
    });
  }

  function emitPosition(id: string, accountId: string, pos: Position | null): void {
    const prevSig = emittedPositions.get(id);
    if (!pos) {
      openedAt.delete(id);
      if (prevSig !== undefined) {
        emittedPositions.delete(id);
        emit({ type: "position.closed", accountId, positionId: id });
      }
      return;
    }
    const sig = `${pos.side}|${pos.quantity}|${pos.entryPrice}|${pos.unrealizedPnl}|${pos.takeProfit}|${pos.stopLoss}`;
    if (sig === prevSig) return;
    const protectionChanged = prevSig !== undefined && prevSig.split("|").slice(4).join("|") !== `${pos.takeProfit}|${pos.stopLoss}`;
    emittedPositions.set(id, sig);
    if (prevSig === undefined || protectionChanged) {
      // "opened" carries the full record, so the terminal upserts TP/SL too.
      emit({ type: "position.opened", accountId, positionId: id, entity: pos });
    } else {
      emit({
        type: "position.updated",
        accountId,
        positionId: id,
        entity: pos,
        unrealizedPnl: pos.unrealizedPnl,
        quantity: pos.quantity,
        averagePrice: pos.entryPrice,
      });
    }
  }

  function refreshPositionsFor(accountId: string, symbol: string): void {
    for (const [id, raw] of instrumentPnl) {
      if (raw.accountId === accountId && raw.symbol === symbol) emitPosition(id, accountId, buildPosition(raw));
    }
  }

  function onInstrumentPnl(m: rti.InstrumentPnLPositionUpdate): void {
    if (!m.accountId || !m.symbol) return;
    const id = positionId(m.accountId, m.exchange ?? "", m.symbol);
    const merged = { ...(instrumentPnl.get(id) ?? {}), ...m } as rti.IInstrumentPnLPositionUpdate;
    instrumentPnl.set(id, merged);
    if (!registry.get(m.symbol) && m.exchange) void registry.learn(m.symbol, m.exchange);
    emitPosition(id, m.accountId, buildPosition(merged));
  }

  function onAccountPnl(m: rti.AccountPnLPositionUpdate): void {
    if (!m.accountId) return;
    const merged = { ...(accountPnl.get(m.accountId) ?? {}), ...m } as rti.IAccountPnLPositionUpdate;
    accountPnl.set(m.accountId, merged);
    const info = accounts.get(m.accountId);
    if (!info) return;
    const a = toAccount(info, merged, user, iso());
    emit({
      type: "account.updated",
      accountId: a.id,
      equity: a.equity,
      balance: a.balance,
      freeMargin: a.freeMargin,
      marginUsed: a.margin,
    });
  }

  // ── Bootstrap ─────────────────────────────────────────

  /** Name the bootstrap step in a Rithmic refusal, e.g. "Account list: user has no permission ...". */
  async function step<R>(label: string, p: Promise<R>): Promise<R> {
    try {
      return await p;
    } catch (err) {
      if (err instanceof RithmicError) throw new RithmicError(err.code, `${label}: ${err.message}`, err.templateId);
      throw err;
    }
  }

  async function loadIdentity(): Promise<void> {
    const info = await step(
      "Login info",
      orderPlant.request<rti.IRequestLoginInfo, rti.IResponseLoginInfo>(rti.RequestLoginInfo, {
        templateId: T.RequestLoginInfo,
      }),
    );
    const li = info.rows[0] ?? info.last;
    const UserType = rti.RequestAccountList.UserType;
    // ResponseLoginInfo and RequestAccountList declare separate enums with the same numbers.
    const LoginUserType = rti.ResponseLoginInfo.UserType;
    const userType =
      li.userType === LoginUserType.USER_TYPE_FCM
        ? UserType.USER_TYPE_FCM
        : li.userType === LoginUserType.USER_TYPE_IB
          ? UserType.USER_TYPE_IB
          : UserType.USER_TYPE_TRADER;
    const list = await step(
      "Account list",
      orderPlant.request<rti.IRequestAccountList, rti.IResponseAccountList>(rti.RequestAccountList, {
        templateId: T.RequestAccountList,
        fcmId: li.fcmId ?? undefined,
        ibId: li.ibId ?? undefined,
        userType,
      }),
    );
    accounts.clear();
    for (const row of list.rows) {
      if (!row.accountId) continue;
      accounts.set(row.accountId, {
        accountId: row.accountId,
        accountName: row.accountName || null,
        currency: row.accountCurrency || null,
        fcmId: row.fcmId || li.fcmId || "",
        ibId: row.ibId || li.ibId || "",
      });
    }
    if (accounts.size === 0) throw new Error("This Rithmic user has no trading accounts.");

    const tr = await step(
      "Trade routes",
      orderPlant.request<rti.IRequestTradeRoutes, rti.IResponseTradeRoutes>(rti.RequestTradeRoutes, {
        templateId: T.RequestTradeRoutes,
        subscribeForUpdates: false,
      }),
    );
    routes = tr.rows
      .filter((r) => r.exchange && r.tradeRoute)
      .map((r) => ({
        fcmId: r.fcmId ?? "",
        ibId: r.ibId ?? "",
        exchange: r.exchange ?? "",
        tradeRoute: r.tradeRoute ?? "",
        isDefault: r.isDefault === true,
        status: r.status ?? "",
      }));
  }

  /**
   * Send one per-account subscription. A Rithmic refusal (e.g. "user has no
   * permission to this account" for PnL on some prop-firm systems) only leaves
   * that stream without data: the account came from the account list, so it
   * stays. Transport errors (dropped connection, timeout) still throw.
   */
  async function subscribeStream(a: RithmicAccountInfo, label: string, send: () => Promise<unknown>): Promise<void> {
    try {
      await send();
    } catch (err) {
      if (!(err instanceof RithmicError)) throw err;
      console.warn(`[rithmic] ${a.accountId}: ${label} refused: ${err.message}`);
    }
  }

  async function syncAccountOrders(a: RithmicAccountInfo): Promise<void> {
    const who = { fcmId: a.fcmId, ibId: a.ibId, accountId: a.accountId };
    await subscribeStream(a, "Order updates", () =>
      orderPlant.request(rti.RequestSubscribeForOrderUpdates, { templateId: T.RequestSubscribeForOrderUpdates, ...who }),
    );
    await subscribeStream(a, "Show orders", () => orderPlant.request(rti.RequestShowOrders, { templateId: T.RequestShowOrders, ...who }));
  }

  async function syncAccountPnl(a: RithmicAccountInfo): Promise<void> {
    const Req = rti.RequestPnLPositionUpdates;
    const who = { fcmId: a.fcmId, ibId: a.ibId, accountId: a.accountId };
    await subscribeStream(a, "PnL updates", () =>
      pnlPlant.request(Req, { templateId: T.RequestPnLPositionUpdates, request: Req.Request.SUBSCRIBE, ...who }),
    );
    await subscribeStream(a, "PnL snapshot", () =>
      pnlPlant.request(rti.RequestPnLPositionSnapshot, { templateId: T.RequestPnLPositionSnapshot, ...who }),
    );
  }

  async function syncAccounts(): Promise<void> {
    await Promise.all([...accounts.values()].flatMap((a) => [syncAccountOrders(a), syncAccountPnl(a)]));
  }

  /** Re-subscribe every account after a plant reconnects; one failure does not stop the rest. */
  async function resync(plant: string, sync: (a: RithmicAccountInfo) => Promise<void>): Promise<void> {
    for (const a of accounts.values()) {
      try {
        await sync(a);
      } catch (err) {
        console.warn(`[rithmic] ${plant} resync failed for ${a.accountId}:`, describe(err));
      }
    }
  }

  function ensureReady(): Promise<void> {
    if (!ready) {
      teardown.push(
        orderPlant.on<rti.RithmicOrderNotification>(T.RithmicOrderNotification, onRithmicNotification),
        orderPlant.on<rti.ExchangeOrderNotification>(T.ExchangeOrderNotification, onExchangeNotification),
        pnlPlant.on<rti.InstrumentPnLPositionUpdate>(T.InstrumentPnLPositionUpdate, onInstrumentPnl),
        pnlPlant.on<rti.AccountPnLPositionUpdate>(T.AccountPnLPositionUpdate, onAccountPnl),
        orderPlant.onReconnect(() => void resync("order", syncAccountOrders)),
        pnlPlant.onReconnect(() => void resync("PnL", syncAccountPnl)),
      );
      const p = (async () => {
        await loadIdentity();
        await syncAccounts();
      })();
      ready = p;
      p.catch(() => {
        if (ready === p) ready = null;
        for (const off of teardown.splice(0)) off();
      });
    }
    return ready;
  }

  // ── Order helpers ─────────────────────────────────────

  /** Resolve once `accept` says the order reached a telling state, or with the latest state on timeout. */
  function awaitOrder(basketId: string, accept: OrderWaiter): Promise<RithmicOrderState | undefined> {
    const current = orders.get(basketId);
    if (current && accept(current, lastNotify.get(basketId) ?? null)) return Promise.resolve(current);
    return new Promise((resolve) => {
      let set = orderWaiters.get(basketId);
      if (!set) {
        set = new Set();
        orderWaiters.set(basketId, set);
      }
      const waiter: OrderWaiter = (state, notify) => {
        if (!accept(state, notify)) return false;
        clearTimeout(timer);
        resolve(state);
        return true;
      };
      const timer = setTimeout(() => {
        orderWaiters.get(basketId)?.delete(waiter);
        resolve(orders.get(basketId));
      }, ackWaitMs);
      set.add(waiter);
    });
  }

  function syntheticOrder(basketId: string, input: PlaceOrderInput, inst: RithmicInstrument, prot: Protection): Order {
    const t = iso();
    return {
      id: basketId,
      accountId: input.accountId,
      symbolName: inst.symbol,
      side: input.side,
      type: input.type === "STOP_LIMIT" ? "STOP" : input.type,
      quantity: input.quantity,
      price: input.price ?? null,
      stopPrice: input.stopPrice ?? null,
      takeProfit: prot.takeProfit,
      stopLoss: prot.stopLoss,
      status: "PENDING",
      filledQuantity: 0,
      avgFillPrice: null,
      comment: null,
      createdAt: t,
      updatedAt: t,
    };
  }

  async function entryReference(input: PlaceOrderInput, inst: RithmicInstrument, price?: number, trigger?: number): Promise<number> {
    if (input.type === "LIMIT" || input.type === "STOP_LIMIT") return price ?? 0;
    if (input.type === "STOP") return trigger ?? 0;
    const q = marketData.peekQuote(inst.symbol) ?? (await marketData.getQuote?.(inst.symbol)) ?? null;
    if (!q) throw new TradeError(`No live quote for ${inst.symbol} yet, so take profit / stop loss can't be converted to ticks.`);
    return input.side === "BUY" ? q.ask : q.bid;
  }

  async function submitOrder(input: PlaceOrderInput): Promise<Order> {
    await ensureReady();
    const who = ids(input.accountId);
    const inst = await registry.require(input.symbol);
    const ticket = toTicket(input, inst);
    const tradeRoute = routeFor(who.accountId, inst.exchange);
    tagSeq += 1;
    const userTag = `oc-${now().toString(36)}-${tagSeq}`;
    const common = {
      ...who,
      userTag,
      symbol: inst.symbol,
      exchange: inst.exchange,
      quantity: ticket.quantity,
      transactionType: ticket.transactionType,
      duration: rti.RequestNewOrder.Duration.DAY,
      priceType: ticket.priceType,
      tradeRoute,
      manualOrAuto: Manual,
      ...(ticket.price !== undefined ? { price: ticket.price } : {}),
      ...(ticket.triggerPrice !== undefined ? { triggerPrice: ticket.triggerPrice } : {}),
    };

    const entry = input.takeProfit || input.stopLoss ? await entryReference(input, inst, ticket.price, ticket.triggerPrice) : 0;
    const bracket = bracketTicks(input.side, entry, input.takeProfit, input.stopLoss, inst.tickSize);
    const prot: Protection = {
      takeProfit: input.takeProfit ? roundToTick(input.takeProfit, inst.tickSize) : null,
      stopLoss: input.stopLoss ? roundToTick(input.stopLoss, inst.tickSize) : null,
    };

    let basketId = "";
    try {
      if (bracket) {
        const reply = await orderPlant.request<rti.IRequestBracketOrder, rti.IResponseBracketOrder>(rti.RequestBracketOrder, {
          templateId: T.RequestBracketOrder,
          ...common,
          bracketType: bracket.bracketType,
          targetQuantity: bracket.targetTicks.map(() => ticket.quantity),
          targetTicks: bracket.targetTicks,
          stopQuantity: bracket.stopTicks.map(() => ticket.quantity),
          stopTicks: bracket.stopTicks,
        });
        basketId = reply.rows.find((r) => r.basketId)?.basketId || reply.last.basketId || "";
      } else {
        const reply = await orderPlant.request<rti.IRequestNewOrder, rti.IResponseNewOrder>(rti.RequestNewOrder, {
          templateId: T.RequestNewOrder,
          ...common,
        });
        basketId = reply.rows.find((r) => r.basketId)?.basketId || reply.last.basketId || "";
      }
    } catch (err) {
      if (err instanceof RithmicError) throw new TradeError(`Rithmic rejected the order: ${err.message}`);
      throw err;
    }
    if (!basketId) throw new TradeError("Rithmic accepted the order but returned no order id.");
    requestedProtection.set(basketId, prot);

    const state = await awaitOrder(
      basketId,
      (s, notify) =>
        s.final !== null ||
        notify === Notify.OPEN ||
        notify === Notify.TRIGGER_PENDING ||
        notify === Notify.COMPLETE,
    );
    if (state?.final === "REJECTED") throw new TradeError(state.text ? `Order rejected: ${state.text}` : "Order rejected by Rithmic.");
    return state ? toOrder(state, prot) : syntheticOrder(basketId, input, inst, prot);
  }

  function requireWorking(orderId: string): RithmicOrderState {
    const s = orders.get(orderId);
    if (!s) throw new TradeError("That order is not known to this session.");
    if (!isWorking(s)) throw new TradeError("That order is no longer working.");
    return s;
  }

  async function modifyWorking(
    s: RithmicOrderState,
    change: { price?: number; triggerPrice?: number; quantity?: number },
  ): Promise<RithmicOrderState> {
    const inst = registry.get(s.symbol) ?? (await registry.require(s.symbol).catch(() => undefined));
    const tick = inst?.tickSize ?? 0;
    const isLimitLike = s.priceType === PriceType.LIMIT || s.priceType === PriceType.STOP_LIMIT;
    const isStopLike = s.priceType === PriceType.STOP_MARKET || s.priceType === PriceType.STOP_LIMIT;
    const price = change.price ?? s.price ?? undefined;
    const triggerPrice = change.triggerPrice ?? s.triggerPrice ?? undefined;
    const quantity = change.quantity ?? s.quantity;
    if (!(quantity >= 1) || Math.floor(quantity) !== quantity) {
      throw new TradeError("Futures quantity must be a whole number of contracts (1 or more).");
    }
    // Only notifications about this modify count from here on.
    lastNotify.delete(s.basketId);
    try {
      await orderPlant.request<rti.IRequestModifyOrder, rti.IResponseModifyOrder>(rti.RequestModifyOrder, {
        templateId: T.RequestModifyOrder,
        ...ids(s.accountId),
        basketId: s.basketId,
        symbol: s.symbol,
        exchange: s.exchange,
        quantity,
        priceType: s.priceType,
        manualOrAuto: Manual,
        ...(isLimitLike && price !== undefined ? { price: roundToTick(price, tick) } : {}),
        ...(isStopLike && triggerPrice !== undefined ? { triggerPrice: roundToTick(triggerPrice, tick) } : {}),
      });
    } catch (err) {
      if (err instanceof RithmicError) throw new TradeError(`Rithmic rejected the change: ${err.message}`);
      throw err;
    }
    let failed = false;
    const after = await awaitOrder(s.basketId, (st, notify) => {
      if (notify === Notify.MODIFICATION_FAILED) failed = true;
      return failed || notify === Notify.MODIFIED || st.final !== null;
    });
    if (failed) throw new TradeError(after?.text ? `Modify failed: ${after.text}` : "Rithmic could not modify the order.");
    return after ?? s;
  }

  async function cancelWorking(s: RithmicOrderState): Promise<void> {
    try {
      await orderPlant.request(rti.RequestCancelOrder, {
        templateId: T.RequestCancelOrder,
        ...ids(s.accountId),
        basketId: s.basketId,
        manualOrAuto: Manual,
      });
    } catch (err) {
      // Filled or cancelled in the meantime: nothing left to cancel.
      if (!isWorking(orders.get(s.basketId) ?? s)) return;
      if (err instanceof RithmicError) throw new TradeError(`Rithmic could not cancel the order: ${err.message}`);
      throw err;
    }
  }

  function targetAccounts(accountId?: string): RithmicAccountInfo[] {
    if (accountId) {
      const a = accounts.get(accountId);
      if (!a) throw new TradeError(`Unknown Rithmic account "${accountId}".`);
      return [a];
    }
    return [...accounts.values()];
  }

  function positionRecord(id: string) {
    const parsed = parsePositionId(id);
    const raw = instrumentPnl.get(id);
    if (!parsed || !raw) throw new TradeError("That position is no longer open.");
    const pos = buildPosition(raw);
    if (!pos) throw new TradeError("That position is no longer open.");
    return { parsed, raw, pos };
  }

  // ── Gateway ───────────────────────────────────────────

  return {
    async getAccounts(): Promise<Account[]> {
      await ensureReady();
      const t = iso();
      return [...accounts.values()].map((a) => toAccount(a, accountPnl.get(a.accountId), user, t));
    },

    async getPositions(accountId: string): Promise<Position[]> {
      await ensureReady();
      const out: Position[] = [];
      for (const raw of instrumentPnl.values()) {
        if (raw.accountId !== accountId) continue;
        const p = buildPosition(raw);
        if (p) out.push(p);
      }
      return out;
    },

    async getOrders(accountId: string, status?: string): Promise<Order[]> {
      await ensureReady();
      const wanted = status?.toUpperCase();
      const workingOnly = wanted === undefined || wanted === "PENDING" || wanted === "NEW" || wanted === "OPEN";
      return [...orders.values()]
        .filter((s) => s.accountId === accountId && (workingOnly ? isWorking(s) : s.final === wanted))
        .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
        .map((s) => toOrder(s, protectionOfOrder(s)));
    },

    async getClosedPositions(_accountId: string, page = 1): Promise<Page<ClosedPosition>> {
      // R|Protocol has no closed-trade history call this adapter maps yet.
      return { data: [], total: 0, page, pageSize: 50, totalPages: 0 };
    },

    placeOrder(input: PlaceOrderInput): Promise<Order> {
      // A double click is one order.
      const key = JSON.stringify(input);
      const existing = inflight.get(key);
      if (existing) return existing;
      const p = submitOrder(input).finally(() => inflight.delete(key));
      inflight.set(key, p);
      return p;
    },

    async modifyOrder(orderId: string, modification: OrderModification): Promise<Order> {
      await ensureReady();
      const s = requireWorking(orderId);
      const prot = protectionOfOrder(s);
      const tpChange = modification.takeProfit !== undefined && modification.takeProfit !== prot.takeProfit;
      const slChange = modification.stopLoss !== undefined && modification.stopLoss !== prot.stopLoss;
      if (tpChange || slChange) {
        throw new TradeError(
          "Rithmic brackets can't be changed on a pending order. Cancel and place it again, or move the TP/SL on the position once it fills.",
        );
      }
      const isStopMarket = s.priceType === PriceType.STOP_MARKET;
      const after = await modifyWorking(s, {
        ...(modification.quantity !== undefined ? { quantity: modification.quantity } : {}),
        ...(isStopMarket
          ? { triggerPrice: modification.stopPrice ?? modification.price }
          : { price: modification.price, triggerPrice: modification.stopPrice }),
      });
      return toOrder(after, protectionOfOrder(after));
    },

    async cancelOrder(orderId: string): Promise<void> {
      await ensureReady();
      const s = orders.get(orderId);
      if (!s || !isWorking(s)) return;
      await cancelWorking(s);
    },

    async cancelAllOrders(accountId?: string): Promise<void> {
      await ensureReady();
      for (const a of targetAccounts(accountId)) {
        await orderPlant.request(rti.RequestCancelAllOrders, {
          templateId: T.RequestCancelAllOrders,
          fcmId: a.fcmId,
          ibId: a.ibId,
          accountId: a.accountId,
          manualOrAuto: Manual,
        });
      }
    },

    async closePosition(id: string, quantity?: number): Promise<void> {
      await ensureReady();
      const { parsed, pos } = positionRecord(id);
      const who = ids(parsed.accountId);
      if (quantity !== undefined && !(Number.isInteger(quantity) && quantity >= 1)) {
        throw new TradeError("Futures quantity must be a whole number of contracts (1 or more).");
      }
      if (quantity !== undefined && quantity < pos.quantity) {
        await submitOrder({
          accountId: parsed.accountId,
          symbol: parsed.symbol,
          side: pos.side === "LONG" ? "SELL" : "BUY",
          type: "MARKET",
          quantity,
        });
        return;
      }
      const prot = protectionFor({ accountId: parsed.accountId, symbol: parsed.symbol, side: pos.side }, orders.values());
      try {
        await orderPlant.request(rti.RequestExitPosition, {
          templateId: T.RequestExitPosition,
          ...who,
          symbol: parsed.symbol,
          exchange: parsed.exchange,
          manualOrAuto: Manual,
        });
      } catch (err) {
        if (err instanceof RithmicError) throw new TradeError(`Rithmic could not close the position: ${err.message}`);
        throw err;
      }
      // Leftover target/stop legs would reopen the position; take them down too.
      for (const leg of [prot.targetOrder, prot.stopOrder]) {
        if (leg && isWorking(orders.get(leg.basketId) ?? leg)) {
          await cancelWorking(leg).catch((err: unknown) =>
            console.warn("[rithmic] could not cancel a protective order after closing:", describe(err)),
          );
        }
      }
    },

    async closeAllPositions(accountId?: string): Promise<void> {
      await ensureReady();
      for (const a of targetAccounts(accountId)) {
        await orderPlant.request(rti.RequestExitPosition, {
          templateId: T.RequestExitPosition,
          fcmId: a.fcmId,
          ibId: a.ibId,
          accountId: a.accountId,
          manualOrAuto: Manual,
        });
      }
    },

    async modifyPosition(id: string, modification: PositionModification): Promise<Position> {
      await ensureReady();
      const { parsed, raw, pos } = positionRecord(id);
      const prot = protectionFor({ accountId: parsed.accountId, symbol: parsed.symbol, side: pos.side }, orders.values());
      const steps: Array<() => Promise<unknown>> = [];

      if (modification.takeProfit !== undefined && modification.takeProfit !== pos.takeProfit) {
        const leg = prot.targetOrder;
        if (!leg) {
          if (modification.takeProfit !== null) {
            throw new TradeError(
              "This position has no take-profit order to move. On Rithmic, TP/SL are attached when the order is placed (bracket).",
            );
          }
        } else if (modification.takeProfit === null) {
          steps.push(() => cancelWorking(leg));
        } else {
          const tp = modification.takeProfit;
          steps.push(() => modifyWorking(leg, { price: tp }));
        }
      }
      if (modification.stopLoss !== undefined && modification.stopLoss !== pos.stopLoss) {
        const leg = prot.stopOrder;
        if (!leg) {
          if (modification.stopLoss !== null) {
            throw new TradeError(
              "This position has no stop-loss order to move. On Rithmic, TP/SL are attached when the order is placed (bracket).",
            );
          }
        } else if (modification.stopLoss === null) {
          steps.push(() => cancelWorking(leg));
        } else {
          const sl = modification.stopLoss;
          steps.push(() => modifyWorking(leg, { triggerPrice: sl }));
        }
      }
      for (const step of steps) await step();
      return buildPosition(instrumentPnl.get(id) ?? raw) ?? pos;
    },

    subscribe(handler: (event: TradingEvent) => void): Unsubscribe {
      handlers.add(handler);
      // Start the order/PnL streams as soon as someone listens.
      ensureReady().catch((err: unknown) => console.warn("[rithmic] trading streams unavailable:", describe(err)));
      return () => {
        handlers.delete(handler);
      };
    },

    dispose(): void {
      for (const off of teardown.splice(0)) off();
      ready = null;
      handlers.clear();
      orders.clear();
      instrumentPnl.clear();
      accountPnl.clear();
      emittedPositions.clear();
      openedAt.clear();
      orderWaiters.clear();
      lastNotify.clear();
    },
  };
}
