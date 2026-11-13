import type { Account, Order, PlaceOrderInput, Position } from "../adapter/types.ts";
import { rti } from "./generated/rti.js";
import type { RithmicInstrument } from "./symbols.ts";

/**
 * Pure mapping between R|Protocol order/PnL messages and OpenCharts records.
 * Nothing here talks to a socket, so all of it is unit-tested directly.
 *
 * Decoded protobufjs messages keep unset fields on the prototype (0, "",
 * false), so "was this field sent?" is an own-property check (`has`).
 */

const PriceType = rti.RequestNewOrder.PriceType;
const TxType = rti.RequestNewOrder.TransactionType;
const Notify = rti.RithmicOrderNotification.NotifyType;
const ExNotify = rti.ExchangeOrderNotification.NotifyType;

export function has(m: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(m, key);
}

function str(v: string | null | undefined): string | null {
  return v ? v : null;
}

/** Rithmic money fields on the PnL plant are strings; unparsable means 0. */
export function money(v: string | number | null | undefined): number {
  if (v === null || v === undefined || v === "") return 0;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

export class TradeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TradeError";
  }
}

// ── Placing ───────────────────────────────────────────────────────────────

export interface OrderTicket {
  priceType: rti.RequestNewOrder.PriceType;
  transactionType: rti.RequestNewOrder.TransactionType;
  quantity: number;
  price?: number;
  triggerPrice?: number;
}

/** Round to the instrument's tick, avoiding float noise like 4501.250000001. */
export function roundToTick(price: number, tickSize: number): number {
  if (!(tickSize > 0)) return price;
  const ticks = Math.round(price / tickSize);
  const decimals = Math.max(0, Math.min(10, Math.ceil(-Math.log10(tickSize)) + 1));
  return Number((ticks * tickSize).toFixed(decimals));
}

export function toTicket(input: PlaceOrderInput, inst: RithmicInstrument): OrderTicket {
  const quantity = Math.floor(input.quantity);
  if (!(quantity >= 1) || quantity !== input.quantity) {
    throw new TradeError("Futures quantity must be a whole number of contracts (1 or more).");
  }
  const transactionType = input.side === "BUY" ? TxType.BUY : TxType.SELL;
  const px = (v: number | undefined, label: string) => {
    if (v === undefined || !(v > 0)) throw new TradeError(`${label} is required for this order type.`);
    return roundToTick(v, inst.tickSize);
  };
  switch (input.type) {
    case "MARKET":
      return { priceType: PriceType.MARKET, transactionType, quantity };
    case "LIMIT":
      return { priceType: PriceType.LIMIT, transactionType, quantity, price: px(input.price, "A limit price") };
    case "STOP":
      return {
        priceType: PriceType.STOP_MARKET,
        transactionType,
        quantity,
        triggerPrice: px(input.stopPrice ?? input.price, "A stop price"),
      };
    case "STOP_LIMIT":
      return {
        priceType: PriceType.STOP_LIMIT,
        transactionType,
        quantity,
        price: px(input.price, "A limit price"),
        triggerPrice: px(input.stopPrice, "A stop price"),
      };
    default:
      throw new TradeError(`Unsupported order type "${String(input.type)}".`);
  }
}

export interface BracketTicks {
  bracketType: rti.RequestBracketOrder.BracketType;
  targetTicks: number[];
  stopTicks: number[];
}

/**
 * Convert absolute TP/SL prices to the tick offsets a Rithmic bracket takes,
 * measured from `entry` (the limit/stop price, or the touch for a market order).
 */
export function bracketTicks(
  side: "BUY" | "SELL",
  entry: number,
  takeProfit: number | undefined,
  stopLoss: number | undefined,
  tickSize: number,
): BracketTicks | null {
  const wantTp = takeProfit !== undefined && takeProfit > 0;
  const wantSl = stopLoss !== undefined && stopLoss > 0;
  if (!wantTp && !wantSl) return null;
  if (!(entry > 0)) throw new TradeError("No reference price to convert take profit / stop loss into ticks.");
  const dir = side === "BUY" ? 1 : -1;
  const toTicks = (price: number) => Math.round(((price - entry) * dir) / tickSize);

  const targetTicks: number[] = [];
  const stopTicks: number[] = [];
  if (wantTp) {
    const t = toTicks(takeProfit!);
    if (t < 1) {
      throw new TradeError(`Take profit must be ${side === "BUY" ? "above" : "below"} the entry price (${entry}).`);
    }
    targetTicks.push(t);
  }
  if (wantSl) {
    const t = -toTicks(stopLoss!);
    if (t < 1) {
      throw new TradeError(`Stop loss must be ${side === "BUY" ? "below" : "above"} the entry price (${entry}).`);
    }
    stopTicks.push(t);
  }
  const B = rti.RequestBracketOrder.BracketType;
  const bracketType = wantTp && wantSl ? B.TARGET_AND_STOP : wantTp ? B.TARGET_ONLY : B.STOP_ONLY;
  return { bracketType, targetTicks, stopTicks };
}

// ── Order state from notifications ────────────────────────────────────────

export type FinalStatus = "FILLED" | "CANCELLED" | "REJECTED";

export interface RithmicOrderState {
  basketId: string;
  accountId: string;
  symbol: string;
  exchange: string;
  side: "BUY" | "SELL";
  priceType: number;
  quantity: number;
  price: number | null;
  triggerPrice: number | null;
  filled: number;
  avgFillPrice: number | null;
  final: FinalStatus | null;
  text: string | null;
  bracketType: number | null;
  userTag: string | null;
  createdAt: string;
  updatedAt: string;
}

function eventTime(n: { ssboe?: number | null; usecs?: number | null }, fallback: string): string {
  if (n.ssboe && n.ssboe > 0) return new Date(n.ssboe * 1000 + Math.floor((n.usecs ?? 0) / 1000)).toISOString();
  return fallback;
}

type AnyNotification = rti.IRithmicOrderNotification | rti.IExchangeOrderNotification;

function baseState(prev: RithmicOrderState | undefined, n: AnyNotification, nowIso: string): RithmicOrderState {
  const at = eventTime(n, nowIso);
  const s: RithmicOrderState = prev
    ? { ...prev, updatedAt: at }
    : {
        basketId: n.basketId ?? "",
        accountId: n.accountId ?? "",
        symbol: n.symbol ?? "",
        exchange: n.exchange ?? "",
        side: "BUY",
        priceType: PriceType.LIMIT,
        quantity: 0,
        price: null,
        triggerPrice: null,
        filled: 0,
        avgFillPrice: null,
        final: null,
        text: null,
        bracketType: null,
        userTag: null,
        createdAt: at,
        updatedAt: at,
      };
  const m = n;
  if (has(m, "accountId") && n.accountId) s.accountId = n.accountId;
  if (has(m, "symbol") && n.symbol) s.symbol = n.symbol;
  if (has(m, "exchange") && n.exchange) s.exchange = n.exchange;
  if (has(m, "transactionType") && n.transactionType) s.side = n.transactionType === TxType.BUY ? "BUY" : "SELL";
  if (has(m, "priceType") && n.priceType) s.priceType = n.priceType;
  if (has(m, "quantity") && n.quantity) s.quantity = n.quantity;
  if (has(m, "price")) s.price = n.price ?? null;
  if (has(m, "triggerPrice")) s.triggerPrice = n.triggerPrice ?? null;
  if (has(m, "totalFillSize")) s.filled = n.totalFillSize ?? 0;
  if (has(m, "avgFillPrice") && n.avgFillPrice) s.avgFillPrice = n.avgFillPrice;
  if (has(m, "bracketType") && n.bracketType) s.bracketType = n.bracketType;
  if (has(m, "userTag") && n.userTag) s.userTag = n.userTag;
  const text = str(n.text) ?? str(n.reportText);
  if (text) s.text = text;
  return s;
}

function completeAs(s: RithmicOrderState, reason: string): FinalStatus {
  const r = reason.toLowerCase();
  if (r.includes("reject")) return "REJECTED";
  if (s.quantity > 0 && s.filled >= s.quantity) return "FILLED";
  if (r.includes("fill") && !r.includes("partial")) return "FILLED";
  return "CANCELLED";
}

/** Fold a `RithmicOrderNotification` (351) into the order's state. */
export function applyRithmicNotification(
  prev: RithmicOrderState | undefined,
  n: rti.IRithmicOrderNotification,
  nowIso: string,
): RithmicOrderState {
  const s = baseState(prev, n, nowIso);
  const notify = n.notifyType ?? 0;
  const status = (n.status ?? "").toLowerCase();
  if (notify === Notify.COMPLETE || status === "complete") {
    s.final = completeAs(s, `${n.completionReason ?? ""} ${n.status ?? ""}`);
  } else if (prev?.final == null) {
    s.final = null;
  }
  return s;
}

/** Fold an `ExchangeOrderNotification` (352) into the order's state. */
export function applyExchangeNotification(
  prev: RithmicOrderState | undefined,
  n: rti.IExchangeOrderNotification,
  nowIso: string,
): RithmicOrderState {
  const s = baseState(prev, n, nowIso);
  switch (n.notifyType) {
    case ExNotify.FILL:
      if (n.totalUnfilledSize === 0 || (s.quantity > 0 && s.filled >= s.quantity)) s.final = "FILLED";
      break;
    case ExNotify.REJECT:
      s.final = "REJECTED";
      break;
    case ExNotify.CANCEL:
      if (s.final == null) s.final = s.filled > 0 && s.filled >= s.quantity ? "FILLED" : "CANCELLED";
      break;
    default:
      break;
  }
  return s;
}

export function orderStatus(s: RithmicOrderState): string {
  return s.final ?? "PENDING";
}

export function isWorking(s: RithmicOrderState): boolean {
  return s.final === null;
}

export function orderTypeOf(priceType: number): Order["type"] {
  if (priceType === PriceType.MARKET) return "MARKET";
  if (priceType === PriceType.LIMIT) return "LIMIT";
  return "STOP";
}

export interface Protection {
  takeProfit: number | null;
  stopLoss: number | null;
}

export function toOrder(s: RithmicOrderState, protection: Protection = { takeProfit: null, stopLoss: null }): Order {
  const type = orderTypeOf(s.priceType);
  const isStop = s.priceType === PriceType.STOP_MARKET || s.priceType === PriceType.STOP_LIMIT;
  return {
    id: s.basketId,
    accountId: s.accountId,
    symbolName: s.symbol,
    side: s.side,
    type,
    quantity: s.quantity,
    price: s.priceType === PriceType.MARKET || s.priceType === PriceType.STOP_MARKET ? null : s.price,
    stopPrice: isStop ? s.triggerPrice : null,
    takeProfit: protection.takeProfit,
    stopLoss: protection.stopLoss,
    status: orderStatus(s),
    filledQuantity: s.filled,
    avgFillPrice: s.avgFillPrice,
    comment: s.final === "REJECTED" ? s.text : s.bracketType ? "Bracket" : null,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
  };
}

// ── Positions ─────────────────────────────────────────────────────────────

export function positionId(accountId: string, exchange: string, symbol: string): string {
  return `${accountId}|${exchange}|${symbol}`;
}

export function parsePositionId(id: string): { accountId: string; exchange: string; symbol: string } | null {
  const parts = id.split("|");
  if (parts.length !== 3 || parts.some((p) => !p)) return null;
  const [accountId, exchange, symbol] = parts as [string, string, string];
  return { accountId, exchange, symbol };
}

export function netQuantity(p: rti.IInstrumentPnLPositionUpdate): number {
  if (has(p, "netQuantity")) return p.netQuantity ?? 0;
  return (p.buyQty ?? 0) - (p.sellQty ?? 0);
}

export function toPosition(
  p: rti.IInstrumentPnLPositionUpdate,
  extra: { openedAt: string; currentPrice?: number; pointValue?: number; protection?: Protection },
): Position | null {
  const net = netQuantity(p);
  if (!net || !p.accountId || !p.symbol) return null;
  const open = has(p, "openPositionPnl") ? money(p.openPositionPnl) : (p.dayOpenPnl ?? 0);
  return {
    id: positionId(p.accountId, p.exchange ?? "", p.symbol),
    accountId: p.accountId,
    symbolName: p.symbol,
    side: net > 0 ? "LONG" : "SHORT",
    quantity: Math.abs(net),
    entryPrice: p.avgOpenFillPrice ?? 0,
    ...(extra.currentPrice !== undefined ? { currentPrice: extra.currentPrice } : {}),
    unrealizedPnl: open,
    margin: 0,
    ...(extra.pointValue !== undefined ? { contractSize: extra.pointValue } : {}),
    openedAt: extra.openedAt,
    takeProfit: extra.protection?.takeProfit ?? null,
    stopLoss: extra.protection?.stopLoss ?? null,
  };
}

/**
 * TP/SL of a position, read from the working orders that would close it:
 * a limit on the opposite side is the target, a stop on the opposite side is
 * the stop (the legs a Rithmic bracket leaves once its entry fills).
 */
export function protectionFor(
  position: { accountId: string; symbol: string; side: "LONG" | "SHORT" },
  orders: Iterable<RithmicOrderState>,
): Protection & { targetOrder: RithmicOrderState | null; stopOrder: RithmicOrderState | null } {
  const closingSide = position.side === "LONG" ? "SELL" : "BUY";
  let targetOrder: RithmicOrderState | null = null;
  let stopOrder: RithmicOrderState | null = null;
  for (const o of orders) {
    if (!isWorking(o) || o.accountId !== position.accountId || o.symbol !== position.symbol) continue;
    if (o.side !== closingSide) continue;
    if (o.priceType === PriceType.LIMIT && !targetOrder) targetOrder = o;
    else if ((o.priceType === PriceType.STOP_MARKET || o.priceType === PriceType.STOP_LIMIT) && !stopOrder) stopOrder = o;
  }
  return {
    targetOrder,
    stopOrder,
    takeProfit: targetOrder?.price ?? null,
    stopLoss: stopOrder?.triggerPrice ?? null,
  };
}

// ── Accounts ──────────────────────────────────────────────────────────────

export interface RithmicAccountInfo {
  accountId: string;
  accountName: string | null;
  currency: string | null;
  fcmId: string;
  ibId: string;
}

export function toAccount(
  info: RithmicAccountInfo,
  pnl: rti.IAccountPnLPositionUpdate | undefined,
  user: string,
  nowIso: string,
): Account {
  const balance = money(pnl?.accountBalance);
  const open = money(pnl?.openPositionPnl);
  return {
    id: info.accountId,
    userId: user,
    templateId: "rithmic",
    label: info.accountName && info.accountName !== info.accountId ? `${info.accountName} (${info.accountId})` : info.accountId,
    status: "ACTIVE",
    balance,
    equity: balance + open,
    margin: money(pnl?.usedBuyingPower),
    freeMargin: money(pnl?.availableBuyingPower),
    phase: "LIVE",
    startDate: nowIso,
    createdAt: nowIso,
    updatedAt: nowIso,
    isHftMode: false,
    template: { name: "Rithmic", startingBalance: balance, instrumentType: "FUTURES" },
  };
}
