import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { TradingEvent } from "../../adapter/types.ts";
import type { RithmicAdapter } from "../adapter.ts";
import { rti } from "../generated/rti.js";
import { InfraType, T } from "../templates.ts";
import { flush, server } from "./fakeRithmic.ts";
import { startAdapter } from "./harness.ts";

const N = rti.RithmicOrderNotification.NotifyType;
const PT = rti.RequestNewOrder.PriceType;

let adapter: RithmicAdapter;
let events: TradingEvent[];

const orderPlant = () => server.plant(InfraType.ORDER_PLANT);
const pnlPlant = () => server.plant(InfraType.PNL_PLANT);

function notify(body: Record<string, unknown>): void {
  orderPlant().push(rti.RithmicOrderNotification, {
    templateId: T.RithmicOrderNotification,
    accountId: "A1",
    fcmId: "FCM1",
    ibId: "IB1",
    symbol: "ESZ6",
    exchange: "CME",
    ...body,
  });
}

function position(net: number, extra: Record<string, unknown> = {}): void {
  pnlPlant().push(rti.InstrumentPnLPositionUpdate, {
    templateId: T.InstrumentPnLPositionUpdate,
    accountId: "A1",
    symbol: "ESZ6",
    exchange: "CME",
    netQuantity: net,
    avgOpenFillPrice: 5000,
    openPositionPnl: "125",
    ...extra,
  });
}

/** Accept new orders with basket ids B1, B2, ... */
function acceptOrders(template: number, response: number, codec: typeof rti.ResponseNewOrder | typeof rti.ResponseBracketOrder) {
  let n = 0;
  server.on(template, () => {
    n += 1;
    return [
      [codec, { templateId: response, rqHandlerRpCode: ["0"], basketId: `B${n}` }],
      [codec, { templateId: response, rpCode: ["0"] }],
    ];
  });
}

beforeEach(async () => {
  server.reset();
  adapter = await startAdapter();
  // The provider connects market data on mount; quotes for brackets need it.
  adapter.marketData.connect?.();
  events = [];
  adapter.trading.subscribe((e) => events.push(e));
  await flush(40);
});
afterEach(() => adapter.dispose());

describe("bootstrap", () => {
  it("loads accounts, routes and subscribes to order and PnL streams", async () => {
    const accounts = await adapter.trading.getAccounts();
    expect(accounts).toHaveLength(1);
    expect(accounts[0]).toMatchObject({ id: "A1", label: "Sim 1 (A1)", balance: 50000, freeMargin: 50000 });
    expect(server.requests(T.RequestAccountList)[0]!.msg).toMatchObject({ fcmId: "FCM1", ibId: "IB1", userType: 3 });
    expect(server.requests(T.RequestSubscribeForOrderUpdates)[0]!.msg).toMatchObject({ accountId: "A1" });
    expect(server.requests(T.RequestShowOrders)).toHaveLength(1);
    expect(server.requests(T.RequestPnLPositionUpdates)[0]!.msg).toMatchObject({ accountId: "A1", request: 1 });
    expect(server.requests(T.RequestPnLPositionSnapshot)).toHaveLength(1);
  });

  it("serves working orders from the show-orders snapshot", async () => {
    notify({ notifyType: N.OPEN, isSnapshot: true, basketId: "OLD", transactionType: 1, priceType: PT.LIMIT, quantity: 1, price: 4990 });
    await flush();
    const orders = await adapter.trading.getOrders("A1");
    expect(orders.map((o) => o.id)).toEqual(["OLD"]);
    expect(await adapter.trading.getOrders("A1", "FILLED")).toEqual([]);
  });
});

describe("placeOrder", () => {
  it("sends a new order on the account's trade route and resolves once it is working", async () => {
    acceptOrders(T.RequestNewOrder, T.ResponseNewOrder, rti.ResponseNewOrder);
    const p = adapter.trading.placeOrder({ accountId: "A1", symbol: "ESZ6", side: "BUY", type: "LIMIT", quantity: 2, price: 4990.1 });
    await flush(30);
    notify({ notifyType: N.OPEN, basketId: "B1", transactionType: 1, priceType: PT.LIMIT, quantity: 2, price: 4990 });
    const order = await p;
    expect(order).toMatchObject({ id: "B1", status: "PENDING", type: "LIMIT", price: 4990, quantity: 2 });
    expect(server.requests(T.RequestNewOrder)[0]!.msg).toMatchObject({
      accountId: "A1",
      fcmId: "FCM1",
      ibId: "IB1",
      symbol: "ESZ6",
      exchange: "CME",
      quantity: 2,
      price: 4990,
      transactionType: 1,
      priceType: PT.LIMIT,
      duration: rti.RequestNewOrder.Duration.DAY,
      tradeRoute: "simulator",
      manualOrAuto: 1,
    });
    expect(events).toContainEqual(expect.objectContaining({ type: "order.placed", orderId: "B1" }));
  });

  it("is one order when submitted twice at once", async () => {
    acceptOrders(T.RequestNewOrder, T.ResponseNewOrder, rti.ResponseNewOrder);
    const input = { accountId: "A1", symbol: "ESZ6", side: "SELL" as const, type: "MARKET" as const, quantity: 1 };
    const a = adapter.trading.placeOrder(input);
    const b = adapter.trading.placeOrder(input);
    expect(a).toBe(b);
    await flush(30);
    notify({ notifyType: N.COMPLETE, basketId: "B1", transactionType: 2, priceType: PT.MARKET, quantity: 1, totalFillSize: 1, avgFillPrice: 5000, completionReason: "Fill" });
    await expect(a).resolves.toMatchObject({ status: "FILLED", avgFillPrice: 5000 });
    expect(server.requests(T.RequestNewOrder)).toHaveLength(1);
  });

  it("rejects with Rithmic's text when the order is refused", async () => {
    server.on(T.RequestNewOrder, () => [[rti.ResponseNewOrder, { templateId: T.ResponseNewOrder, rpCode: ["1039", "trading not allowed"] }]]);
    await expect(
      adapter.trading.placeOrder({ accountId: "A1", symbol: "ESZ6", side: "BUY", type: "MARKET", quantity: 1 }),
    ).rejects.toThrow("Rithmic rejected the order: trading not allowed");
  });

  it("rejects when the exchange rejects the accepted order", async () => {
    acceptOrders(T.RequestNewOrder, T.ResponseNewOrder, rti.ResponseNewOrder);
    const p = adapter.trading.placeOrder({ accountId: "A1", symbol: "ESZ6", side: "BUY", type: "MARKET", quantity: 1 });
    await flush(30);
    orderPlant().push(rti.ExchangeOrderNotification, {
      templateId: T.ExchangeOrderNotification,
      notifyType: rti.ExchangeOrderNotification.NotifyType.REJECT,
      basketId: "B1",
      accountId: "A1",
      symbol: "ESZ6",
      text: "Insufficient margin",
    });
    await expect(p).rejects.toThrow("Order rejected: Insufficient margin");
    expect(events).toContainEqual(expect.objectContaining({ type: "order.rejected", orderId: "B1" }));
  });

  it("sends TP/SL as a bracket in ticks from the touch for a market order", async () => {
    acceptOrders(T.RequestBracketOrder, T.ResponseBracketOrder, rti.ResponseBracketOrder);
    const p = adapter.trading.placeOrder({
      accountId: "A1",
      symbol: "ESZ6",
      side: "BUY",
      type: "MARKET",
      quantity: 1,
      takeProfit: 5010.25,
      stopLoss: 4995.25,
    });
    await flush(60);
    notify({ notifyType: N.OPEN, basketId: "B1", transactionType: 1, priceType: PT.MARKET, quantity: 1, bracketType: 3 });
    const order = await p;
    expect(order).toMatchObject({ id: "B1", takeProfit: 5010.25, stopLoss: 4995.25 });
    // The fake quotes 5000 / 5000.25: a buy enters at the ask.
    expect(server.requests(T.RequestBracketOrder)[0]!.msg).toMatchObject({
      bracketType: rti.RequestBracketOrder.BracketType.TARGET_AND_STOP,
      targetTicks: [40],
      targetQuantity: [1],
      stopTicks: [20],
      stopQuantity: [1],
      tradeRoute: "simulator",
    });
    expect(server.requests(T.RequestNewOrder)).toHaveLength(0);
  });

  it("refuses an unknown account or symbol", async () => {
    await expect(adapter.trading.placeOrder({ accountId: "nope", symbol: "ESZ6", side: "BUY", type: "MARKET", quantity: 1 })).rejects.toThrow(/Unknown Rithmic account/);
    await expect(adapter.trading.placeOrder({ accountId: "A1", symbol: "ZZZ", side: "BUY", type: "MARKET", quantity: 1 })).rejects.toThrow(/Unknown Rithmic symbol/);
  });
});

describe("working orders", () => {
  beforeEach(async () => {
    notify({ notifyType: N.OPEN, basketId: "W1", transactionType: 1, priceType: PT.LIMIT, quantity: 1, price: 4980 });
    await flush();
  });

  it("modifies price and waits for the confirmation", async () => {
    const p = adapter.trading.modifyOrder("W1", { price: 4975.1 });
    await flush(30);
    notify({ notifyType: N.MODIFIED, basketId: "W1", price: 4975 });
    await expect(p).resolves.toMatchObject({ id: "W1", price: 4975 });
    expect(server.requests(T.RequestModifyOrder)[0]!.msg).toMatchObject({ basketId: "W1", price: 4975, quantity: 1, priceType: PT.LIMIT });
  });

  it("refuses to change TP/SL on a pending order", async () => {
    await expect(adapter.trading.modifyOrder("W1", { takeProfit: 5000 })).rejects.toThrow(/can't be changed on a pending order/);
  });

  it("cancels by basket id and reports the cancel", async () => {
    await adapter.trading.cancelOrder("W1");
    expect(server.requests(T.RequestCancelOrder)[0]!.msg).toMatchObject({ basketId: "W1", accountId: "A1", manualOrAuto: 1 });
    notify({ notifyType: N.COMPLETE, basketId: "W1", completionReason: "Cancel" });
    await flush();
    expect(events).toContainEqual(expect.objectContaining({ type: "order.canceled", orderId: "W1" }));
    expect(await adapter.trading.getOrders("A1")).toEqual([]);
  });

  it("cancels all orders per account", async () => {
    await adapter.trading.cancelAllOrders();
    expect(server.requests(T.RequestCancelAllOrders)[0]!.msg).toMatchObject({ accountId: "A1" });
  });
});

describe("positions", () => {
  it("emits opened / updated / closed from PnL updates", async () => {
    position(2);
    await flush();
    const [p] = await adapter.trading.getPositions("A1");
    expect(p).toMatchObject({ id: "A1|CME|ESZ6", side: "LONG", quantity: 2, entryPrice: 5000, unrealizedPnl: 125, contractSize: 50 });
    position(2, { openPositionPnl: "150" });
    position(0);
    await flush();
    expect(events.filter((e) => e.type.startsWith("position.")).map((e) => e.type)).toEqual([
      "position.opened",
      "position.updated",
      "position.closed",
    ]);
    expect(await adapter.trading.getPositions("A1")).toEqual([]);
  });

  it("reports account balances from account PnL updates", async () => {
    pnlPlant().push(rti.AccountPnLPositionUpdate, {
      templateId: T.AccountPnLPositionUpdate,
      accountId: "A1",
      accountBalance: "51000",
      openPositionPnl: "250",
    });
    await flush();
    expect(events).toContainEqual(expect.objectContaining({ type: "account.updated", accountId: "A1", balance: 51000, equity: 51250 }));
  });

  it("reads TP/SL from the bracket legs and moves the stop by modifying its order", async () => {
    position(1);
    notify({ notifyType: N.OPEN, basketId: "TGT", transactionType: 2, priceType: PT.LIMIT, quantity: 1, price: 5010 });
    notify({ notifyType: N.TRIGGER_PENDING, basketId: "STP", transactionType: 2, priceType: PT.STOP_MARKET, quantity: 1, triggerPrice: 4990 });
    await flush();
    const [p] = await adapter.trading.getPositions("A1");
    expect(p).toMatchObject({ takeProfit: 5010, stopLoss: 4990 });

    const moved = adapter.trading.modifyPosition(p!.id, { stopLoss: 4995 });
    await flush(30);
    notify({ notifyType: N.MODIFIED, basketId: "STP", triggerPrice: 4995 });
    await expect(moved).resolves.toMatchObject({ stopLoss: 4995, takeProfit: 5010 });
    expect(server.requests(T.RequestModifyOrder)[0]!.msg).toMatchObject({ basketId: "STP", triggerPrice: 4995, priceType: PT.STOP_MARKET });
  });

  it("refuses to add TP/SL to a position without bracket legs", async () => {
    position(1);
    await flush();
    await expect(adapter.trading.modifyPosition("A1|CME|ESZ6", { takeProfit: 5050 })).rejects.toThrow(/no take-profit order/);
  });

  it("closes in full with exit-position and cancels the leftover legs", async () => {
    position(1);
    notify({ notifyType: N.TRIGGER_PENDING, basketId: "STP", transactionType: 2, priceType: PT.STOP_MARKET, quantity: 1, triggerPrice: 4990 });
    await flush();
    await adapter.trading.closePosition("A1|CME|ESZ6");
    expect(server.requests(T.RequestExitPosition)[0]!.msg).toMatchObject({ accountId: "A1", symbol: "ESZ6", exchange: "CME", manualOrAuto: 1 });
    expect(server.requests(T.RequestCancelOrder)[0]!.msg).toMatchObject({ basketId: "STP" });
  });

  it("closes part of a position with an opposite market order", async () => {
    acceptOrders(T.RequestNewOrder, T.ResponseNewOrder, rti.ResponseNewOrder);
    position(-3);
    await flush();
    const p = adapter.trading.closePosition("A1|CME|ESZ6", 1);
    await flush(30);
    notify({ notifyType: N.COMPLETE, basketId: "B1", transactionType: 1, priceType: PT.MARKET, quantity: 1, totalFillSize: 1, completionReason: "Fill" });
    await p;
    expect(server.requests(T.RequestNewOrder)[0]!.msg).toMatchObject({ transactionType: 1, priceType: PT.MARKET, quantity: 1 });
    expect(server.requests(T.RequestExitPosition)).toHaveLength(0);
  });
});
