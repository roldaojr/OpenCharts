import { describe, expect, it } from "vitest";
import { rti } from "../generated/rti.js";
import {
  applyExchangeNotification,
  applyRithmicNotification,
  bracketTicks,
  parsePositionId,
  positionId,
  protectionFor,
  roundToTick,
  toAccount,
  toOrder,
  toPosition,
  toTicket,
  type RithmicOrderState,
} from "../orders.ts";
import type { RithmicInstrument } from "../symbols.ts";

const ES: RithmicInstrument = {
  symbol: "ESZ6",
  exchange: "CME",
  product: "ES",
  description: "E-Mini S&P 500",
  tickSize: 0.25,
  pointValue: 50,
  currency: "USD",
};
const PT = rti.RequestNewOrder.PriceType;
// Notifications declare their own PriceType enum with the same numbers.
const NPT = rti.RithmicOrderNotification.PriceType;
const N = rti.RithmicOrderNotification.NotifyType;
const X = rti.ExchangeOrderNotification.NotifyType;
const NOW = "2026-11-12T15:00:00.000Z";

const decoded = <M>(codec: { encode(m: M): { finish(): Uint8Array }; decode(b: Uint8Array): M }, body: M): M =>
  codec.decode(codec.encode(body).finish());

describe("toTicket", () => {
  const base = { accountId: "A1", symbol: "ESZ6", side: "BUY" as const, quantity: 2 };

  it("maps the four order types onto Rithmic price types, rounded to the tick", () => {
    expect(toTicket({ ...base, type: "MARKET" }, ES)).toEqual({ priceType: PT.MARKET, transactionType: 1, quantity: 2 });
    expect(toTicket({ ...base, type: "LIMIT", price: 5000.3 }, ES)).toMatchObject({ priceType: PT.LIMIT, price: 5000.25 });
    expect(toTicket({ ...base, type: "STOP", stopPrice: 5010.1 }, ES)).toMatchObject({
      priceType: PT.STOP_MARKET,
      triggerPrice: 5010,
    });
    expect(toTicket({ ...base, side: "SELL", type: "STOP_LIMIT", price: 4990, stopPrice: 4991 }, ES)).toMatchObject({
      priceType: PT.STOP_LIMIT,
      transactionType: 2,
      price: 4990,
      triggerPrice: 4991,
    });
  });

  it("rejects fractional contracts and missing prices", () => {
    expect(() => toTicket({ ...base, quantity: 0.5, type: "MARKET" }, ES)).toThrow(/whole number/);
    expect(() => toTicket({ ...base, type: "LIMIT" }, ES)).toThrow(/limit price/);
  });
});

describe("roundToTick", () => {
  it("snaps to the tick without float noise", () => {
    expect(roundToTick(4501.3, 0.25)).toBe(4501.25);
    expect(roundToTick(1.08437, 0.00005)).toBe(1.08435);
  });
});

describe("bracketTicks", () => {
  it("converts TP/SL prices into tick offsets from the entry", () => {
    expect(bracketTicks("BUY", 5000, 5010, 4995, 0.25)).toEqual({
      bracketType: rti.RequestBracketOrder.BracketType.TARGET_AND_STOP,
      targetTicks: [40],
      stopTicks: [20],
    });
    expect(bracketTicks("SELL", 5000, 4990, undefined, 0.25)).toEqual({
      bracketType: rti.RequestBracketOrder.BracketType.TARGET_ONLY,
      targetTicks: [40],
      stopTicks: [],
    });
    expect(bracketTicks("BUY", 5000, undefined, undefined, 0.25)).toBeNull();
  });

  it("refuses a target or stop on the wrong side of the entry", () => {
    expect(() => bracketTicks("BUY", 5000, 4990, undefined, 0.25)).toThrow(/above the entry/);
    expect(() => bracketTicks("SELL", 5000, undefined, 4990, 0.25)).toThrow(/above the entry/);
  });
});

describe("order notifications", () => {
  const placed = decoded(rti.RithmicOrderNotification, {
    templateId: 351,
    notifyType: N.OPEN,
    basketId: "B1",
    accountId: "A1",
    symbol: "ESZ6",
    exchange: "CME",
    transactionType: 1,
    priceType: NPT.LIMIT,
    quantity: 2,
    price: 5000,
    ssboe: 1_700_000_000,
  });

  it("builds a working order from the first notification", () => {
    const s = applyRithmicNotification(undefined, placed, NOW);
    const o = toOrder(s);
    expect(o).toMatchObject({
      id: "B1",
      accountId: "A1",
      symbolName: "ESZ6",
      side: "BUY",
      type: "LIMIT",
      quantity: 2,
      price: 5000,
      stopPrice: null,
      status: "PENDING",
      filledQuantity: 0,
    });
    expect(o.createdAt).toBe(new Date(1_700_000_000_000).toISOString());
  });

  it("keeps fields a later partial notification does not repeat", () => {
    const s1 = applyRithmicNotification(undefined, placed, NOW);
    const s2 = applyRithmicNotification(s1, decoded(rti.RithmicOrderNotification, { templateId: 351, notifyType: N.MODIFIED, basketId: "B1", price: 4999.5 }), NOW);
    expect(s2).toMatchObject({ price: 4999.5, quantity: 2, side: "BUY", symbol: "ESZ6" });
  });

  it("marks fills, cancels and rejects as final", () => {
    const s1 = applyRithmicNotification(undefined, placed, NOW);
    const filled = applyExchangeNotification(
      s1,
      decoded(rti.ExchangeOrderNotification, { templateId: 352, notifyType: X.FILL, basketId: "B1", totalFillSize: 2, totalUnfilledSize: 0, avgFillPrice: 5000 }),
      NOW,
    );
    expect(toOrder(filled)).toMatchObject({ status: "FILLED", filledQuantity: 2, avgFillPrice: 5000 });

    const cancelled = applyRithmicNotification(
      s1,
      decoded(rti.RithmicOrderNotification, { templateId: 351, notifyType: N.COMPLETE, basketId: "B1", completionReason: "Cancel" }),
      NOW,
    );
    expect(cancelled.final).toBe("CANCELLED");

    const rejected = applyExchangeNotification(
      undefined,
      decoded(rti.ExchangeOrderNotification, { templateId: 352, notifyType: X.REJECT, basketId: "B2", text: "Insufficient margin" }),
      NOW,
    );
    expect(toOrder(rejected)).toMatchObject({ status: "REJECTED", comment: "Insufficient margin" });
  });

  it("reports stop orders with their trigger as stopPrice", () => {
    const s = applyRithmicNotification(
      undefined,
      decoded(rti.RithmicOrderNotification, { templateId: 351, notifyType: N.TRIGGER_PENDING, basketId: "S1", accountId: "A1", symbol: "ESZ6", transactionType: 2, priceType: NPT.STOP_MARKET, quantity: 1, triggerPrice: 4980 }),
      NOW,
    );
    expect(toOrder(s)).toMatchObject({ type: "STOP", stopPrice: 4980, price: null, side: "SELL" });
  });
});

describe("positions", () => {
  it("maps a net position and parses its id back", () => {
    const pnl = decoded(rti.InstrumentPnLPositionUpdate, {
      templateId: 450,
      accountId: "A1",
      symbol: "ESZ6",
      exchange: "CME",
      netQuantity: -3,
      avgOpenFillPrice: 5001.25,
      openPositionPnl: "-187.50",
    });
    const p = toPosition(pnl, { openedAt: NOW, pointValue: 50 });
    expect(p).toMatchObject({
      id: "A1|CME|ESZ6",
      side: "SHORT",
      quantity: 3,
      entryPrice: 5001.25,
      unrealizedPnl: -187.5,
      contractSize: 50,
    });
    expect(parsePositionId(p!.id)).toEqual({ accountId: "A1", exchange: "CME", symbol: "ESZ6" });
    expect(positionId("A1", "CME", "ESZ6")).toBe(p!.id);
  });

  it("is null for a flat instrument", () => {
    const flat = decoded(rti.InstrumentPnLPositionUpdate, { templateId: 450, accountId: "A1", symbol: "ESZ6", netQuantity: 0 });
    expect(toPosition(flat, { openedAt: NOW })).toBeNull();
  });

  it("reads TP/SL from working closing-side orders", () => {
    const leg = (over: Partial<RithmicOrderState>): RithmicOrderState => ({
      basketId: "x",
      accountId: "A1",
      symbol: "ESZ6",
      exchange: "CME",
      side: "SELL",
      priceType: PT.LIMIT,
      quantity: 1,
      price: null,
      triggerPrice: null,
      filled: 0,
      avgFillPrice: null,
      final: null,
      text: null,
      bracketType: null,
      userTag: null,
      createdAt: NOW,
      updatedAt: NOW,
      ...over,
    });
    const prot = protectionFor({ accountId: "A1", symbol: "ESZ6", side: "LONG" }, [
      leg({ basketId: "T", price: 5010 }),
      leg({ basketId: "S", priceType: PT.STOP_MARKET, triggerPrice: 4990 }),
      leg({ basketId: "other", side: "BUY", price: 4900 }),
      leg({ basketId: "done", price: 5020, final: "CANCELLED" }),
    ]);
    expect(prot).toMatchObject({ takeProfit: 5010, stopLoss: 4990 });
    expect(prot.targetOrder?.basketId).toBe("T");
    expect(prot.stopOrder?.basketId).toBe("S");
  });
});

describe("toAccount", () => {
  it("parses the PnL plant's string money fields", () => {
    const pnl = decoded(rti.AccountPnLPositionUpdate, {
      templateId: 451,
      accountId: "A1",
      accountBalance: "50000.00",
      openPositionPnl: "-250.5",
      usedBuyingPower: "1200",
      availableBuyingPower: "48800",
    });
    const a = toAccount({ accountId: "A1", accountName: "Sim 1", currency: "USD", fcmId: "F", ibId: "I" }, pnl, "alice", NOW);
    expect(a).toMatchObject({
      id: "A1",
      label: "Sim 1 (A1)",
      balance: 50000,
      equity: 49749.5,
      margin: 1200,
      freeMargin: 48800,
      template: { instrumentType: "FUTURES" },
    });
  });

  it("is all zeros before the first PnL update", () => {
    const a = toAccount({ accountId: "A1", accountName: null, currency: null, fcmId: "F", ibId: "I" }, undefined, "alice", NOW);
    expect(a).toMatchObject({ label: "A1", balance: 0, equity: 0 });
  });
});
