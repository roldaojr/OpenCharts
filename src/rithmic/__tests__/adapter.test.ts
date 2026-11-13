import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runAdapterConformance } from "../../adapter/conformance.ts";
import type { DepthBook } from "../../adapter/types.ts";
import { createUserStorage, type RithmicAdapter } from "../adapter.ts";
import { getRithmicConfig, parseContracts, parseProducts, quarterlyContract, RITHMIC_TEST_GATEWAY } from "../config.ts";
import { rti } from "../generated/rti.js";
import { TIMEFRAMES, barToCandle } from "../marketData.ts";
import { InfraType, T } from "../templates.ts";
import { flush, server } from "./fakeRithmic.ts";
import { installDefaultHandlers, startAdapter } from "./harness.ts";

// The conformance suite reuses one adapter across tests, so the fake gateway
// keeps answering after each reset.
beforeEach(() => {
  server.reset();
  installDefaultHandlers();
});

runAdapterConformance("rithmic (fake gateway)", () => startAdapter(), {
  symbol: "ESZ6",
  timeframe: "1m",
  tickTimeoutMs: 200,
});

describe("config", () => {
  const NOV_12 = new Date("2026-11-12T12:00:00Z");

  it("defaults to the test gateway and ES/MES/NQ/MNQ with manual contracts", () => {
    const c = getRithmicConfig({}, NOV_12);
    expect(c.gateway).toBe(RITHMIC_TEST_GATEWAY);
    expect(c.products).toEqual([
      { product: "ES", exchange: "CME", contract: "ESZ6", tickSize: 0.25, pointValue: 50, description: "E-Mini S&P 500" },
      { product: "MES", exchange: "CME", contract: "MESZ6", tickSize: 0.25, pointValue: 5, description: "Micro E-Mini S&P 500" },
      { product: "NQ", exchange: "CME", contract: "NQZ6", tickSize: 0.25, pointValue: 20, description: "E-Mini Nasdaq-100" },
      { product: "MNQ", exchange: "CME", contract: "MNQZ6", tickSize: 0.25, pointValue: 2, description: "Micro E-Mini Nasdaq-100" },
    ]);
  });

  it("maps listed products it knows and leaves the rest to the front-month lookup", () => {
    const c = getRithmicConfig({ VITE_RITHMIC_PRODUCTS: "es:cme, CL:NYMEX ES:CME bogus" }, NOV_12);
    expect(c.products).toEqual([
      expect.objectContaining({ product: "ES", contract: "ESZ6" }),
      { product: "CL", exchange: "NYMEX" },
    ]);
    expect(parseProducts("")).toEqual([]);
  });

  it("lets VITE_RITHMIC_CONTRACTS pin a contract", () => {
    const c = getRithmicConfig({ VITE_RITHMIC_CONTRACTS: "es:esh7, NQ:NQH7" }, NOV_12);
    expect(c.products.map((p) => p.contract)).toEqual(["ESH7", "MESZ6", "NQH7", "MNQZ6"]);
    expect(parseContracts("ES:ESH7 bad")).toEqual({ ES: "ESH7" });
  });

  it("rolls quarterly 8 days before the third Friday", () => {
    // Dec 2026: third Friday is the 18th, so the roll is Dec 10.
    expect(quarterlyContract("ES", new Date("2026-12-09T23:59:59Z"))).toBe("ESZ6");
    expect(quarterlyContract("ES", new Date("2026-12-10T00:00:00Z"))).toBe("ESH7");
    expect(quarterlyContract("MNQ", new Date("2027-01-15T00:00:00Z"))).toBe("MNQH7");
    // Mar 2027: third Friday is the 19th, roll Mar 11.
    expect(quarterlyContract("NQ", new Date("2027-03-10T12:00:00Z"))).toBe("NQH7");
    expect(quarterlyContract("NQ", new Date("2027-03-11T12:00:00Z"))).toBe("NQM7");
    expect(quarterlyContract("MES", new Date("2026-07-01T00:00:00Z"))).toBe("MESU6");
  });
});

describe("storage", () => {
  it("namespaces keys by user", () => {
    const store = new Map<string, string>();
    const s = createUserStorage("Alice", {
      getItem: (k) => store.get(k) ?? null,
      setItem: (k, v) => void store.set(k, v),
      removeItem: (k) => void store.delete(k),
    });
    s.set("drawings", "[]");
    expect([...store.keys()]).toEqual(["rithmic:alice:drawings"]);
  });
});

describe("market data", () => {
  let adapter: RithmicAdapter;
  beforeEach(async () => {
    adapter = await startAdapter();
  });
  afterEach(() => adapter.dispose());

  it("lists the manual contracts without asking for the front month", async () => {
    // The Rithmic test system never answers RequestFrontMonthContract.
    server.on(T.RequestFrontMonthContract, () => []);
    const symbols = await adapter.marketData.getSymbols();
    expect(symbols.map((s) => s.name)).toEqual(["ESZ6", "NQZ6"]);
    expect(symbols[0]).toMatchObject({ category: "Indices", tickSize: 0.25, tickValue: 12.5, displayName: "E-Mini S&P 500" });
    expect(server.requests(T.RequestFrontMonthContract)).toHaveLength(0);
    expect(server.requests(T.RequestReferenceData)[0]!.msg).toMatchObject({ symbol: "ESZ6", exchange: "CME" });
  });

  it("maps timeframes to Rithmic bar types and asks for the last N bars", async () => {
    await adapter.marketData.getCandles({ symbol: "ESZ6", timeframe: "4h", limit: 10 });
    const [req] = server.requests(T.RequestTimeBarReplay);
    expect(req!.msg).toMatchObject({
      symbol: "ESZ6",
      exchange: "CME",
      barType: rti.RequestTimeBarReplay.BarType.MINUTE_BAR,
      barTypePeriod: 240,
      userMaxCount: 10,
      direction: rti.RequestTimeBarReplay.Direction.LAST,
      timeOrder: rti.RequestTimeBarReplay.TimeOrder.FORWARDS,
    });
    await expect(adapter.marketData.getCandles({ symbol: "ESZ6", timeframe: "2m" })).rejects.toThrow(/Unsupported timeframe/);
    expect(TIMEFRAMES["1d"]!.barType).toBe(rti.RequestTimeBarReplay.BarType.DAILY_BAR);
  });

  it("returns de-duplicated bars, oldest first, inside an exclusive toMs", async () => {
    const recent = await adapter.marketData.getCandles({ symbol: "ESZ6", timeframe: "1m", limit: 20 });
    expect(recent).toHaveLength(20);
    expect(new Set(recent.map((c) => c.time)).size).toBe(20);
    const cutoff = recent[10]!.time;
    const older = await adapter.marketData.getCandles({ symbol: "ESZ6", timeframe: "1m", toMs: cutoff * 1000 });
    expect(older.every((c) => c.time < cutoff)).toBe(true);
    const req = server.requests(T.RequestTimeBarReplay).at(-1)!;
    expect(req.msg.finishIndex).toBe(cutoff - 1);
  });

  it("treats Rithmic's 'no data' as an empty page", async () => {
    server.on(T.RequestTimeBarReplay, () => [
      [rti.ResponseTimeBarReplay, { templateId: T.ResponseTimeBarReplay, rpCode: ["7", "no data"] }],
    ]);
    await expect(adapter.marketData.getCandles({ symbol: "ESZ6", timeframe: "1m", toMs: 1000 })).resolves.toEqual([]);
  });

  it("subscribes the charted symbol and streams BBO as ticks", async () => {
    const events: unknown[] = [];
    adapter.marketData.subscribe((e) => events.push(e));
    adapter.marketData.connect?.();
    await adapter.marketData.getCandles({ symbol: "ESZ6", timeframe: "1m", limit: 5 });
    await flush(20);
    const sub = server.requests(T.RequestMarketDataUpdate).find((r) => r.msg.symbol === "ESZ6");
    expect(sub!.msg).toMatchObject({ request: 1, updateBits: 3 });
    expect(events).toContainEqual(expect.objectContaining({ type: "tick", symbol: "ESZ6", bid: 5000, ask: 5000.25 }));
    expect(adapter.marketData.peekQuote("ESZ6")).toMatchObject({ bid: 5000, ask: 5000.25 });
  });

  it("builds the forming bar from live trades", async () => {
    const events: Array<{ type: string; close?: number; volume?: number; timestamp?: number }> = [];
    adapter.marketData.subscribe((e) => events.push(e));
    adapter.marketData.connect?.();
    const bars = await adapter.marketData.getCandles({ symbol: "ESZ6", timeframe: "1m", limit: 5 });
    const last = bars.at(-1)!;
    server.plant(InfraType.TICKER_PLANT).push(rti.LastTrade, {
      templateId: T.LastTrade,
      symbol: "ESZ6",
      exchange: "CME",
      presenceBits: 1,
      tradePrice: 5003.5,
      tradeSize: 4,
      ssboe: last.time + 30,
    });
    server.plant(InfraType.TICKER_PLANT).push(rti.LastTrade, {
      templateId: T.LastTrade,
      symbol: "ESZ6",
      exchange: "CME",
      presenceBits: 1,
      tradePrice: 5004,
      tradeSize: 1,
      ssboe: last.time + 65,
    });
    await flush(20);
    const candles = events.filter((e) => e.type === "candle");
    expect(candles[0]).toMatchObject({ timestamp: last.time, close: 5003.5, volume: last.volume + 4 });
    expect(candles[1]).toMatchObject({ timestamp: last.time + 60, close: 5004, volume: 1 });
  });

  it("re-subscribes after the ticker plant reconnects", async () => {
    adapter.marketData.connect?.();
    adapter.marketData.setSymbolInterest?.(["NQZ6"]);
    await flush(20);
    expect(server.requests(T.RequestMarketDataUpdate).filter((r) => r.msg.symbol === "NQZ6")).toHaveLength(1);
    server.plant(InfraType.TICKER_PLANT).drop();
    await new Promise((r) => setTimeout(r, 1_100));
    await flush(20);
    expect(server.requests(T.RequestMarketDataUpdate).filter((r) => r.msg.symbol === "NQZ6")).toHaveLength(2);
  });

  describe("order book", () => {
    const U = rti.OrderBook.UpdateType;
    const book = (body: Record<string, unknown>) =>
      server.plant(InfraType.TICKER_PLANT).push(rti.OrderBook, { templateId: T.OrderBook, symbol: "ESZ6", exchange: "CME", ...body });
    const depthRequests = () =>
      server.requests(T.RequestMarketDataUpdate).filter((r) => r.msg.symbol === "ESZ6" && r.msg.updateBits === 4);

    it("subscribes ORDER_BOOK alone and keeps a sorted, aggregated book", async () => {
      adapter.marketData.connect?.();
      const books: DepthBook[] = [];
      const off = adapter.marketData.subscribeDepth!("ESZ6", (b) => books.push(b));
      await flush(20);
      expect(depthRequests()[0]!.msg).toMatchObject({ request: rti.RequestMarketDataUpdate.Request.SUBSCRIBE, updateBits: 4 });

      // A two-frame snapshot, then an update that removes one level and adds another.
      book({ updateType: U.SNAPSHOT_IMAGE, presenceBits: 3, bidPrice: [5000, 4999.75], bidSize: [10, 7], askPrice: [5000.25], askSize: [12] });
      book({ updateType: U.SNAPSHOT_IMAGE, presenceBits: 2, askPrice: [5000.5], askSize: [4] });
      await flush(20);
      // The snapshot is published on the next macrotask, once all its frames are in.
      await new Promise((r) => setTimeout(r, 0));
      expect(books).toHaveLength(1);
      expect(books.at(-1)).toMatchObject({
        bids: [{ price: 5000, size: 10 }, { price: 4999.75, size: 7 }],
        asks: [{ price: 5000.25, size: 12 }, { price: 5000.5, size: 4 }],
      });
      book({ updateType: U.SOLO, presenceBits: 1, bidPrice: [5000, 4999.5], bidSize: [0, 3] });
      await flush(20);
      expect(books.at(-1)!.bids).toEqual([{ price: 4999.75, size: 7 }, { price: 4999.5, size: 3 }]);

      // BEGIN/MIDDLE are applied silently; END publishes.
      const before = books.length;
      book({ updateType: U.BEGIN, presenceBits: 2, askPrice: [5000.25], askSize: [1] });
      await flush(20);
      expect(books).toHaveLength(before);
      book({ updateType: U.END, presenceBits: 2, askPrice: [5000.75], askSize: [2] });
      await flush(20);
      expect(books.at(-1)!.asks.map((l) => l.size)).toEqual([1, 4, 2]);

      book({ updateType: U.CLEAR_ORDER_BOOK });
      await flush(20);
      expect(books.at(-1)).toMatchObject({ bids: [], asks: [] });

      off();
      await flush(20);
      expect(depthRequests().at(-1)!.msg).toMatchObject({ request: rti.RequestMarketDataUpdate.Request.UNSUBSCRIBE, updateBits: 4 });
    });

    it("re-subscribes the book after the ticker plant reconnects", async () => {
      adapter.marketData.connect?.();
      const off = adapter.marketData.subscribeDepth!("ESZ6", () => undefined);
      await flush(20);
      expect(depthRequests()).toHaveLength(1);
      server.plant(InfraType.TICKER_PLANT).drop();
      await new Promise((r) => setTimeout(r, 1_100));
      await flush(20);
      expect(depthRequests().filter((r) => r.msg.request === rti.RequestMarketDataUpdate.Request.SUBSCRIBE)).toHaveLength(2);
      off();
    });
  });

  it("ignores bars with missing prices", () => {
    expect(barToCandle({ templateId: 203, marker: 10 }, 60)).toBeNull();
  });
});

describe("contract resolution", () => {
  let adapter: RithmicAdapter | null = null;
  afterEach(() => adapter?.dispose());

  it("falls back to the manual tick size and point value when reference data has none", async () => {
    adapter = await startAdapter(getRithmicConfig({ VITE_RITHMIC_PRODUCTS: "MES:CME,MNQ:CME" }, new Date("2026-11-12T12:00:00Z")).products);
    // After startAdapter, which reinstalls the default handlers.
    server.on(T.RequestReferenceData, () => [
      [rti.ResponseReferenceData, { templateId: T.ResponseReferenceData, rpCode: ["7", "no data"] }],
    ]);
    const symbols = await adapter.marketData.getSymbols();
    expect(symbols.map((s) => [s.name, s.tickSize, s.tickValue, s.displayName])).toEqual([
      ["MESZ6", 0.25, 1.25, "Micro E-Mini S&P 500"],
      ["MNQZ6", 0.25, 0.5, "Micro E-Mini Nasdaq-100"],
    ]);
  });

  it("still resolves unmapped products through the front-month request", async () => {
    adapter = await startAdapter([{ product: "NQ", exchange: "CME" }]);
    const symbols = await adapter.marketData.getSymbols();
    expect(symbols.map((s) => s.name)).toEqual(["NQZ6"]);
    expect(server.requests(T.RequestFrontMonthContract)[0]!.msg).toMatchObject({ symbol: "NQ", exchange: "CME" });
  });
});
