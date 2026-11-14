import { afterEach, describe, expect, it, vi } from "vitest";
import type { MarketEvent, PlaceOrderInput, Quote, TradingEvent, TradingGateway } from "../../adapter/types.ts";
import { combineTrading } from "../combinedTrading.ts";
import { createSimulatorTrading, SIM_ACCOUNT_ID, SIM_STARTING_BALANCE, type SimulatorTrading } from "../simulator.ts";
import type { RithmicInstrument } from "../symbols.ts";

const ES: RithmicInstrument = { symbol: "ESZ6", exchange: "CME", product: "ES", description: null, tickSize: 0.25, pointValue: 50, currency: "USD" };

function fakeMarket() {
  const quotes = new Map<string, Quote>();
  const handlers = new Set<(e: MarketEvent) => void>();
  const pinned: string[][] = [];
  return {
    pinned,
    peekQuote: (s: string) => quotes.get(s) ?? null,
    subscribe(h: (e: MarketEvent) => void) {
      handlers.add(h);
      return () => void handlers.delete(h);
    },
    setPinnedSymbols: (s: string[]) => void pinned.push(s),
    /** Set the quote and push it as a tick. */
    tick(bid: number, ask: number, symbol = ES.symbol) {
      quotes.set(symbol, { symbol, bid, ask, timestamp: 0 });
      for (const h of [...handlers]) h({ type: "tick", symbol, bid, ask });
    },
  };
}

function memoryStore() {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) };
}

const registry = { get: (s: string) => (s === ES.symbol ? ES : undefined), require: async (s: string) => { if (s !== ES.symbol) throw new Error("unknown"); return ES; } };

const clock = 1_000_000;
const sims: SimulatorTrading[] = [];

function makeSim(market = fakeMarket(), store = memoryStore()) {
  const sim = createSimulatorTrading({ marketData: market, registry, store, key: "sim", user: "alice", now: () => clock });
  sims.push(sim);
  return { sim, market, store };
}

const order = (o: Partial<PlaceOrderInput>): PlaceOrderInput =>
  ({ accountId: SIM_ACCOUNT_ID, symbol: ES.symbol, side: "BUY", type: "MARKET", quantity: 1, ...o }) as PlaceOrderInput;

afterEach(() => {
  for (const s of sims.splice(0)) s.dispose();
  vi.restoreAllMocks();
});

describe("simulator account", () => {
  it("starts at $50,000 as the Simulator account", async () => {
    const { sim } = makeSim();
    const [a] = await sim.getAccounts();
    expect(a).toMatchObject({ id: "SIM", label: "Simulator", balance: SIM_STARTING_BALANCE, equity: SIM_STARTING_BALANCE });
  });

  it("fills a market buy at the ask and marks it to the bid", async () => {
    const { sim, market } = makeSim();
    market.tick(5000, 5000.25);
    const filled = await sim.placeOrder(order({ quantity: 2 }));
    expect(filled).toMatchObject({ status: "FILLED", avgFillPrice: 5000.25, type: "MARKET" });
    market.tick(5002, 5002.25);
    const [p] = await sim.getPositions(SIM_ACCOUNT_ID);
    expect(p).toMatchObject({ id: "SIM:ESZ6", side: "LONG", quantity: 2, entryPrice: 5000.25, unrealizedPnl: (5002 - 5000.25) * 2 * 50 });
  });

  it("nets an opposite fill: realizes the closed part and flips the rest", async () => {
    const { sim, market } = makeSim();
    market.tick(5000, 5000.25);
    await sim.placeOrder(order({ quantity: 2 }));
    market.tick(5010, 5010.25);
    await sim.placeOrder(order({ side: "SELL", quantity: 3 }));
    const [p] = await sim.getPositions(SIM_ACCOUNT_ID);
    expect(p).toMatchObject({ side: "SHORT", quantity: 1, entryPrice: 5010 });
    const [a] = await sim.getAccounts();
    expect(a!.balance).toBe(SIM_STARTING_BALANCE + (5010 - 5000.25) * 2 * 50);
    const closed = await sim.getClosedPositions(SIM_ACCOUNT_ID);
    expect(closed.data[0]).toMatchObject({ side: "LONG", quantity: 2, exitPrice: 5010, realizedPnl: (5010 - 5000.25) * 2 * 50 });
  });

  it("rejects fractional contracts and market orders without a quote", async () => {
    const { sim, market } = makeSim();
    await expect(sim.placeOrder(order({}))).rejects.toThrow(/No live quote/);
    market.tick(5000, 5000.25);
    await expect(sim.placeOrder(order({ quantity: 1.5 }))).rejects.toThrow(/whole number/);
  });

  it("fills a buy limit when the ask reaches it and a sell stop when the bid falls to it", async () => {
    const { sim, market } = makeSim();
    market.tick(5000, 5000.25);
    const limit = await sim.placeOrder(order({ type: "LIMIT", price: 4995 }));
    expect(limit.status).toBe("PENDING");
    market.tick(4996, 4996.25);
    expect(await sim.getOrders(SIM_ACCOUNT_ID)).toHaveLength(1);
    market.tick(4994.75, 4995);
    expect(await sim.getOrders(SIM_ACCOUNT_ID)).toHaveLength(0);
    expect((await sim.getPositions(SIM_ACCOUNT_ID))[0]).toMatchObject({ quantity: 1, entryPrice: 4995 });

    await sim.placeOrder(order({ side: "SELL", type: "STOP", stopPrice: 4990 }));
    market.tick(4991, 4991.25);
    expect(await sim.getPositions(SIM_ACCOUNT_ID)).toHaveLength(1);
    market.tick(4989.75, 4990);
    expect(await sim.getPositions(SIM_ACCOUNT_ID)).toHaveLength(0);
    expect((await sim.getClosedPositions(SIM_ACCOUNT_ID)).data[0]).toMatchObject({ exitPrice: 4989.75 });
  });

  it("closes the position at the take profit level", async () => {
    const { sim, market } = makeSim();
    const events: TradingEvent[] = [];
    sim.subscribe((e) => events.push(e));
    market.tick(5000, 5000.25);
    await sim.placeOrder(order({ takeProfit: 5005, stopLoss: 4990 }));
    expect((await sim.getPositions(SIM_ACCOUNT_ID))[0]).toMatchObject({ takeProfit: 5005, stopLoss: 4990 });
    market.tick(5005.25, 5005.5);
    expect(await sim.getPositions(SIM_ACCOUNT_ID)).toHaveLength(0);
    expect((await sim.getAccounts())[0]!.balance).toBe(SIM_STARTING_BALANCE + (5005 - 5000.25) * 50);
    expect(events.some((e) => e.type === "position.closed")).toBe(true);
  });

  it("moves protection and closes part of a position", async () => {
    const { sim, market } = makeSim();
    market.tick(5000, 5000.25);
    await sim.placeOrder(order({ quantity: 3 }));
    const moved = await sim.modifyPosition("SIM:ESZ6", { stopLoss: 4997.1 });
    expect(moved.stopLoss).toBe(4997);
    await sim.closePosition("SIM:ESZ6", 2);
    expect((await sim.getPositions(SIM_ACCOUNT_ID))[0]).toMatchObject({ quantity: 1 });
    await sim.closeAllPositions(SIM_ACCOUNT_ID);
    expect(await sim.getPositions(SIM_ACCOUNT_ID)).toHaveLength(0);
  });

  it("keeps its state across a reload and resets to the start", async () => {
    const store = memoryStore();
    const first = makeSim(fakeMarket(), store);
    first.market.tick(5000, 5000.25);
    await first.sim.placeOrder(order({}));
    await first.sim.placeOrder(order({ type: "LIMIT", price: 4980 }));
    first.sim.dispose();

    const again = makeSim(fakeMarket(), store);
    expect(await again.sim.getPositions(SIM_ACCOUNT_ID)).toHaveLength(1);
    expect(await again.sim.getOrders(SIM_ACCOUNT_ID)).toHaveLength(1);
    expect(again.market.pinned.at(-1)).toEqual(["ESZ6"]);

    again.sim.reset();
    expect(await again.sim.getPositions(SIM_ACCOUNT_ID)).toHaveLength(0);
    expect(await again.sim.getOrders(SIM_ACCOUNT_ID)).toHaveLength(0);
    expect((await again.sim.getAccounts())[0]!.balance).toBe(SIM_STARTING_BALANCE);
    expect(JSON.parse(store.getItem("sim")!)).toMatchObject({ balance: SIM_STARTING_BALANCE, positions: [], orders: [] });
  });

  it("starts over when the stored state is unreadable", async () => {
    const store = memoryStore();
    store.setItem("sim", "{not json");
    const { sim } = makeSim(fakeMarket(), store);
    expect((await sim.getAccounts())[0]!.balance).toBe(SIM_STARTING_BALANCE);
  });
});

describe("combined gateway", () => {
  function fakeReal(fail = false): TradingGateway {
    const reject = () => Promise.reject(new Error("real"));
    return {
      getAccounts: vi.fn(() => (fail ? Promise.reject(new Error("no permission")) : Promise.resolve([{ id: "RR1" } as never]))),
      getPositions: vi.fn(async () => []),
      getOrders: vi.fn(async () => []),
      getClosedPositions: vi.fn(reject),
      placeOrder: vi.fn(reject),
      modifyOrder: vi.fn(reject),
      cancelOrder: vi.fn(async () => undefined),
      cancelAllOrders: vi.fn(async () => undefined),
      closePosition: vi.fn(async () => undefined),
      closeAllPositions: vi.fn(async () => undefined),
      modifyPosition: vi.fn(reject),
      subscribe: vi.fn(() => () => undefined),
    };
  }

  it("lists both and routes by account and by id prefix", async () => {
    const real = fakeReal();
    const { sim, market } = makeSim();
    const both = combineTrading(real, sim);
    expect((await both.getAccounts()).map((a) => a.id)).toEqual(["RR1", "SIM"]);

    market.tick(5000, 5000.25);
    await both.placeOrder(order({ type: "LIMIT", price: 4900 }));
    expect(real.placeOrder).not.toHaveBeenCalled();
    await both.cancelOrder("SIM:o1");
    expect(real.cancelOrder).not.toHaveBeenCalled();
    expect(await sim.getOrders(SIM_ACCOUNT_ID)).toHaveLength(0);

    await expect(both.placeOrder(order({ accountId: "RR1" }))).rejects.toThrow("real");
    await both.cancelOrder("12345");
    expect(real.cancelOrder).toHaveBeenCalledWith("12345");
    await both.getPositions("RR1");
    expect(real.getPositions).toHaveBeenCalledWith("RR1");
  });

  it("shows only the simulator when Rithmic trading fails", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { sim } = makeSim();
    const both = combineTrading(fakeReal(true), sim);
    expect((await both.getAccounts()).map((a) => a.id)).toEqual(["SIM"]);
  });
});
