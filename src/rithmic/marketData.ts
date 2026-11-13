import type {
  Candle,
  CandleRequest,
  ConnectionState,
  DepthBook,
  DepthLevel,
  MarketDataSource,
  MarketEvent,
  Quote,
  Symbol as OcSymbol,
  Unsubscribe,
} from "../adapter/types.ts";
import { isNoData } from "./codec.ts";
import type { RithmicPlantConnection } from "./connection.ts";
import { rti } from "./generated/rti.js";
import { instrumentToSymbol, type RithmicInstrument, type RithmicSymbolRegistry } from "./symbols.ts";
import { T } from "./templates.ts";

/**
 * Rithmic market data for the OpenCharts adapter contract.
 *
 * History: `RequestTimeBarReplay` (202) on the history plant. Live: the ticker
 * plant's `RequestMarketDataUpdate` (100) with LAST_TRADE | BBO; best bid/offer
 * frames become `tick` events and trades update the forming bar of every
 * charted timeframe of that symbol, emitted as `candle` events. The depth
 * panel adds the ORDER_BOOK bit and receives `OrderBook` (156) frames, kept as
 * an aggregated book per symbol.
 *
 * Units (matching src/pages/trading/ChartPanel.tsx): `Candle.time` and the
 * candle event `timestamp` are the bar's OPEN time in SECONDS; tick
 * `timestamp` is epoch MS.
 */

const BarType = rti.RequestTimeBarReplay.BarType;

export interface TimeframeSpec {
  barType: rti.RequestTimeBarReplay.BarType;
  period: number;
  seconds: number;
}

export const TIMEFRAMES: Readonly<Record<string, TimeframeSpec>> = {
  "1m": { barType: BarType.MINUTE_BAR, period: 1, seconds: 60 },
  "5m": { barType: BarType.MINUTE_BAR, period: 5, seconds: 300 },
  "15m": { barType: BarType.MINUTE_BAR, period: 15, seconds: 900 },
  "30m": { barType: BarType.MINUTE_BAR, period: 30, seconds: 1800 },
  "1h": { barType: BarType.MINUTE_BAR, period: 60, seconds: 3600 },
  "4h": { barType: BarType.MINUTE_BAR, period: 240, seconds: 14_400 },
  "1d": { barType: BarType.DAILY_BAR, period: 1, seconds: 86_400 },
  "1w": { barType: BarType.WEEKLY_BAR, period: 1, seconds: 604_800 },
};

const DEFAULT_LIMIT = 500;
const MAX_BARS = 10_000;
const MAX_CHART_STREAMS = 6;
const MAX_INTEREST_SUBSCRIPTIONS = 30;
const REPLAY_TIMEOUT_MS = 60_000;
const QUOTE_WAIT_MS = 3_000;
/** Levels per side handed to `subscribeDepth` handlers. */
export const DEPTH_LEVELS = 20;

const Bits = rti.RequestMarketDataUpdate.UpdateBits;
const QUOTE_BITS = Bits.LAST_TRADE | Bits.BBO;

interface BookState {
  bids: Map<number, DepthLevel>;
  asks: Map<number, DepthLevel>;
  /** Inside a (possibly multi-frame) snapshot image. */
  inSnapshot: boolean;
  emitQueued: boolean;
  timestamp: number;
}

/** Best `n` levels: bids high to low, asks low to high. */
export function topLevels(levels: Map<number, DepthLevel>, side: "bid" | "ask", n = DEPTH_LEVELS): DepthLevel[] {
  const sorted = [...levels.values()].sort((a, b) => (side === "bid" ? b.price - a.price : a.price - b.price));
  return sorted.slice(0, n);
}

/**
 * Whether a time bar's `marker` is its close time rather than its open time.
 * R|Protocol documents `marker` only as "the bar's time"; flip this if bars
 * from a live system turn out one period late on the chart.
 */
export const BAR_MARKER_IS_CLOSE_TIME = false;

export interface RithmicMarketDataDeps {
  ticker: RithmicPlantConnection;
  history: RithmicPlantConnection;
  registry: RithmicSymbolRegistry;
  now?: () => number;
}

export interface RithmicMarketData extends MarketDataSource {
  /** Last known top of book, if subscribed. */
  peekQuote(symbol: string): Quote | null;
  subscribeDepth(symbol: string, handler: (book: DepthBook) => void): Unsubscribe;
}

export function barToCandle(
  bar: rti.IResponseTimeBarReplay,
  periodSeconds: number,
): Candle | null {
  const marker = bar.marker ?? 0;
  const open = bar.openPrice ?? NaN;
  const high = bar.highPrice ?? NaN;
  const low = bar.lowPrice ?? NaN;
  const close = bar.closePrice ?? NaN;
  if (!marker || ![open, high, low, close].every(Number.isFinite)) return null;
  const time = BAR_MARKER_IS_CLOSE_TIME ? marker - periodSeconds : marker;
  return { time, open, high, low, close, volume: Number(bar.volume ?? 0) };
}

/** Intraday bars align to the period; daily/weekly follow the exchange session, so they roll from the last bar. */
function bucketStart(spec: TimeframeSpec, tradeSec: number, forming: Candle | undefined): number {
  if (spec.barType === BarType.MINUTE_BAR) return Math.floor(tradeSec / spec.seconds) * spec.seconds;
  if (!forming) return Math.floor(tradeSec / spec.seconds) * spec.seconds;
  let start = forming.time;
  while (tradeSec >= start + spec.seconds) start += spec.seconds;
  return start;
}

function worstState(states: ConnectionState[]): ConnectionState {
  if (states.includes("disconnected")) return "disconnected";
  if (states.includes("reconnecting")) return "reconnecting";
  if (states.includes("connecting")) return "connecting";
  return "connected";
}

export function createRithmicMarketData(deps: RithmicMarketDataDeps): RithmicMarketData {
  const { ticker, history, registry } = deps;
  const now = deps.now ?? Date.now;

  const handlers = new Set<(e: MarketEvent) => void>();
  const quotes = new Map<string, Quote>();
  /** Last traded price per subscribed symbol. */
  const lastTrades = new Map<string, number>();
  const quoteWaiters = new Map<string, Set<(q: Quote) => void>>();
  /** symbol|timeframe → chart, most recent last. */
  const chartKeys = new Map<string, { symbol: string; timeframe: string }>();
  const forming = new Map<string, Candle>();
  /** Update bits currently subscribed on the ticker plant, per symbol. */
  const subscribed = new Map<string, number>();
  /** Depth-panel handlers per symbol, and the book kept for them. */
  const depthSubs = new Map<string, Set<(book: DepthBook) => void>>();
  const books = new Map<string, BookState>();
  const temporary = new Set<string>();
  let interest: string[] = [];
  let started = false;
  const teardown: Unsubscribe[] = [];

  const emit = (event: MarketEvent) => {
    for (const h of [...handlers]) {
      try {
        h(event);
      } catch (err) {
        console.error("[rithmic] market data handler threw", err);
      }
    }
  };

  // ── Live ────────────────────────────────────────────────

  function sendSubscription(inst: RithmicInstrument, on: boolean, updateBits: number): Promise<unknown> {
    const Req = rti.RequestMarketDataUpdate;
    return ticker.request(Req, {
      templateId: T.RequestMarketDataUpdate,
      symbol: inst.symbol,
      exchange: inst.exchange,
      request: on ? Req.Request.SUBSCRIBE : Req.Request.UNSUBSCRIBE,
      updateBits,
    });
  }

  function desired(): Set<string> {
    const want = new Set<string>();
    for (const { symbol } of chartKeys.values()) want.add(symbol);
    for (const s of temporary) want.add(s);
    for (const s of interest) {
      if (want.size >= MAX_INTEREST_SUBSCRIPTIONS + chartKeys.size) break;
      want.add(s);
    }
    return want;
  }

  /**
   * Bring the ticker plant's subscriptions in line with what is on screen:
   * LAST_TRADE | BBO for charted and watched symbols, plus ORDER_BOOK for
   * symbols with a depth panel. Only the bits that change are sent.
   */
  function reconcile(): void {
    if (!started || ticker.getState() !== "connected") return;
    const want = desired();
    const symbols = new Set([...want, ...depthSubs.keys(), ...subscribed.keys()]);
    for (const symbol of symbols) {
      const target = (want.has(symbol) ? QUOTE_BITS : 0) | (depthSubs.has(symbol) ? Bits.ORDER_BOOK : 0);
      const current = subscribed.get(symbol) ?? 0;
      if (target === current) continue;
      const inst = registry.get(symbol);
      if (!inst) continue;
      const removed = current & ~target;
      const added = target & ~current;
      if (target) subscribed.set(symbol, target);
      else subscribed.delete(symbol);
      if (removed & QUOTE_BITS) {
        quotes.delete(symbol);
        lastTrades.delete(symbol);
      }
      if (removed & Bits.ORDER_BOOK) books.delete(symbol);
      if (removed) sendSubscription(inst, false, removed).catch(() => undefined);
      if (added) {
        sendSubscription(inst, true, added).catch((err: unknown) => {
          const left = (subscribed.get(symbol) ?? 0) & ~added;
          if (left) subscribed.set(symbol, left);
          else subscribed.delete(symbol);
          console.warn(`[rithmic] market data subscription for ${symbol} failed:`, describe(err));
        });
      }
    }
  }

  // ── Order book ──────────────────────────────────────────

  function bookFor(symbol: string): BookState {
    let b = books.get(symbol);
    if (!b) {
      b = { bids: new Map(), asks: new Map(), inSnapshot: false, emitQueued: false, timestamp: 0 };
      books.set(symbol, b);
    }
    return b;
  }

  function snapshotOf(symbol: string, b: BookState): DepthBook {
    return {
      symbol,
      bids: topLevels(b.bids, "bid"),
      asks: topLevels(b.asks, "ask"),
      timestamp: b.timestamp || now(),
    };
  }

  function emitBook(symbol: string): void {
    const b = books.get(symbol);
    const subs = depthSubs.get(symbol);
    if (!b || !subs) return;
    const book = snapshotOf(symbol, b);
    for (const h of [...subs]) {
      try {
        h(book);
      } catch (err) {
        console.error("[rithmic] depth handler threw", err);
      }
    }
  }

  function applySide(
    levels: Map<number, DepthLevel>,
    prices: number[] | null | undefined,
    sizes: number[] | null | undefined,
    orders: number[] | null | undefined,
  ): void {
    if (!prices) return;
    prices.forEach((price, i) => {
      if (!Number.isFinite(price)) return;
      const size = sizes?.[i] ?? 0;
      const count = orders?.[i];
      if (size <= 0) levels.delete(price);
      else levels.set(price, count ? { price, size, orders: count } : { price, size });
    });
  }

  function onOrderBook(m: rti.OrderBook): void {
    const symbol = m.symbol;
    if (!symbol || !depthSubs.has(symbol)) return;
    const U = rti.OrderBook.UpdateType;
    const P = rti.OrderBook.PresenceBits;
    const b = bookFor(symbol);
    const type = m.updateType || U.SOLO;
    if (m.ssboe) b.timestamp = m.ssboe * 1000 + Math.floor((m.usecs ?? 0) / 1000);

    if (type === U.CLEAR_ORDER_BOOK || type === U.NO_BOOK) {
      b.bids.clear();
      b.asks.clear();
      b.inSnapshot = false;
      emitBook(symbol);
      return;
    }
    if (type === U.SNAPSHOT_IMAGE) {
      // A snapshot may span several frames: the first one replaces the book.
      if (!b.inSnapshot) {
        b.bids.clear();
        b.asks.clear();
        b.inSnapshot = true;
      }
    } else {
      b.inSnapshot = false;
    }
    // Presence bits say which sides the frame carries; without them, read both.
    const present = m.presenceBits || P.BID | P.ASK;
    if (present & P.BID) applySide(b.bids, m.bidPrice, m.bidSize, m.bidOrders);
    if (present & P.ASK) applySide(b.asks, m.askPrice, m.askSize, m.askOrders);

    if (type === U.SNAPSHOT_IMAGE) {
      // The snapshot's frames arrive back to back: emit once they are all in.
      if (!b.emitQueued) {
        b.emitQueued = true;
        setTimeout(() => {
          b.emitQueued = false;
          b.inSnapshot = false;
          emitBook(symbol);
        }, 0);
      }
      return;
    }
    if (type === U.BEGIN || type === U.MIDDLE) return;
    emitBook(symbol);
  }

  function onBbo(m: rti.BestBidOffer): void {
    const symbol = m.symbol;
    if (!symbol) return;
    const prev = quotes.get(symbol);
    const Bits = rti.BestBidOffer.PresenceBits;
    const present = m.presenceBits ?? 0;
    const cleared = m.clearBits ?? 0;
    let bid = prev?.bid ?? NaN;
    let ask = prev?.ask ?? NaN;
    if (present & Bits.BID && Number.isFinite(m.bidPrice)) bid = m.bidPrice;
    if (present & Bits.ASK && Number.isFinite(m.askPrice)) ask = m.askPrice;
    if (cleared & Bits.BID) bid = NaN;
    if (cleared & Bits.ASK) ask = NaN;
    if (!Number.isFinite(bid) && !Number.isFinite(ask)) return;
    // One-sided book: quote the side we have on both sides rather than drop it.
    if (!Number.isFinite(bid)) bid = ask;
    if (!Number.isFinite(ask)) ask = bid;
    const timestamp = m.ssboe ? m.ssboe * 1000 + Math.floor((m.usecs ?? 0) / 1000) : now();
    const quote: Quote = { symbol, bid, ask, timestamp };
    quotes.set(symbol, quote);
    const waiters = quoteWaiters.get(symbol);
    if (waiters) {
      quoteWaiters.delete(symbol);
      for (const w of waiters) w(quote);
    }
    const last = lastTrades.get(symbol);
    emit({ type: "tick", symbol, bid, ask, timestamp, ...(last !== undefined ? { last } : {}) });
  }

  function onTrade(m: rti.LastTrade): void {
    const symbol = m.symbol;
    if (!symbol) return;
    const Bits = rti.LastTrade.PresenceBits;
    if (!((m.presenceBits ?? 0) & Bits.LAST_TRADE)) return;
    const price = m.tradePrice;
    if (!Number.isFinite(price) || price <= 0) return;
    // Every trade, the snapshot included, moves the chart's last price.
    lastTrades.set(symbol, price);
    const quote = quotes.get(symbol);
    const tradeMs = m.ssboe ? m.ssboe * 1000 + Math.floor((m.usecs ?? 0) / 1000) : now();
    emit({ type: "tick", symbol, bid: quote?.bid ?? price, ask: quote?.ask ?? price, timestamp: tradeMs, last: price });
    // The subscription snapshot repeats the last trade; it is already in history.
    if (m.isSnapshot) return;
    const size = Math.max(0, m.tradeSize ?? 0);
    const tradeSec = m.ssboe || Math.floor(now() / 1000);

    for (const [key, chart] of chartKeys) {
      if (chart.symbol !== symbol) continue;
      const spec = TIMEFRAMES[chart.timeframe];
      if (!spec) continue;
      const cur = forming.get(key);
      if (cur && tradeSec < cur.time) continue;
      const start = bucketStart(spec, tradeSec, cur);
      let bar: Candle;
      if (cur && cur.time === start) {
        bar = {
          ...cur,
          high: Math.max(cur.high, price),
          low: Math.min(cur.low, price),
          close: price,
          volume: cur.volume + size,
        };
      } else {
        bar = { time: start, open: price, high: price, low: price, close: price, volume: size };
      }
      forming.set(key, bar);
      emit({
        type: "candle",
        symbol,
        timeframe: chart.timeframe,
        open: bar.open,
        high: bar.high,
        low: bar.low,
        close: bar.close,
        volume: bar.volume,
        timestamp: bar.time,
      });
    }
  }

  function rememberChart(symbol: string, timeframe: string): string {
    const key = `${symbol}|${timeframe}`;
    chartKeys.delete(key);
    chartKeys.set(key, { symbol, timeframe });
    while (chartKeys.size > MAX_CHART_STREAMS) {
      const oldest = chartKeys.keys().next().value;
      if (oldest === undefined) break;
      chartKeys.delete(oldest);
      forming.delete(oldest);
    }
    reconcile();
    return key;
  }

  // ── History ─────────────────────────────────────────────

  async function replay(
    inst: RithmicInstrument,
    spec: TimeframeSpec,
    startSec: number,
    finishSec: number,
    maxCount: number,
  ): Promise<rti.IResponseTimeBarReplay[]> {
    const Req = rti.RequestTimeBarReplay;
    let reply;
    try {
      reply = await history.request<rti.IRequestTimeBarReplay, rti.IResponseTimeBarReplay>(
        Req,
        {
          templateId: T.RequestTimeBarReplay,
          symbol: inst.symbol,
          exchange: inst.exchange,
          barType: spec.barType,
          barTypePeriod: spec.period,
          startIndex: Math.max(0, Math.floor(startSec)),
          finishIndex: Math.floor(finishSec),
          userMaxCount: maxCount,
          direction: Req.Direction.LAST,
          timeOrder: Req.TimeOrder.FORWARDS,
        },
        { timeoutMs: REPLAY_TIMEOUT_MS },
      );
    } catch (err) {
      if (isNoData(err)) return [];
      throw err;
    }
    const rows = [...reply.rows];
    // A replay cut short by a server-side cap closes with a key to fetch the rest.
    const key = reply.last.requestKey;
    if (key && rows.length > 0 && rows.length < maxCount) {
      try {
        const more = await history.request<rti.IRequestResumeBars, rti.IResponseTimeBarReplay>(
          rti.RequestResumeBars,
          { templateId: T.RequestResumeBars, requestKey: key },
          { timeoutMs: REPLAY_TIMEOUT_MS },
        );
        rows.push(...more.rows);
      } catch (err) {
        console.warn("[rithmic] could not resume a truncated bar replay:", describe(err));
      }
    }
    return rows;
  }

  async function getCandles(request: CandleRequest): Promise<Candle[]> {
    const spec = Object.hasOwn(TIMEFRAMES, request.timeframe) ? TIMEFRAMES[request.timeframe] : undefined;
    if (!spec) {
      throw new Error(
        `Unsupported timeframe "${request.timeframe}". Rithmic supports ${Object.keys(TIMEFRAMES).join(", ")}.`,
      );
    }
    const inst = await registry.require(request.symbol);
    const live = request.toMs === undefined;
    const chartKey = live ? rememberChart(inst.symbol, request.timeframe) : null;

    const cap = Math.min(MAX_BARS, Math.max(1, Math.floor(request.limit ?? DEFAULT_LIMIT)));
    const toSec = request.toMs !== undefined ? Math.floor(request.toMs / 1000) : Infinity;
    // finish_index is inclusive; toMs is exclusive.
    const finishSec = Number.isFinite(toSec) ? toSec - 1 : Math.floor(now() / 1000) + spec.seconds;
    const fromSec = request.fromMs !== undefined ? Math.floor(request.fromMs / 1000) : -Infinity;
    // Without a lower bound, ask for a window wide enough for `cap` bars across
    // overnight breaks and weekends; direction LAST + user_max_count trims it.
    const startSec = Number.isFinite(fromSec) ? fromSec : finishSec - cap * spec.seconds * 3 - 4 * 86_400;

    let rows: rti.IResponseTimeBarReplay[];
    try {
      rows = await replay(inst, spec, startSec, finishSec, cap);
    } catch (err) {
      throw new Error(`Could not load ${inst.symbol} ${request.timeframe} bars: ${describe(err)}`);
    }

    const byTime = new Map<number, Candle>();
    for (const row of rows) {
      const c = barToCandle(row, spec.seconds);
      if (c && c.time >= fromSec && c.time < toSec) byTime.set(c.time, c);
    }
    const sorted = [...byTime.values()].sort((a, b) => a.time - b.time);
    const out = request.limit !== undefined || request.fromMs === undefined ? sorted.slice(-cap) : sorted;

    if (chartKey) {
      const last = out[out.length - 1];
      const cur = forming.get(chartKey);
      if (last && (!cur || cur.time <= last.time)) forming.set(chartKey, { ...last });
    }
    return out;
  }

  // ── Public surface ──────────────────────────────────────

  return {
    async getSymbols(): Promise<OcSymbol[]> {
      const list = await registry.load();
      return list.map(instrumentToSymbol);
    },

    getCandles,

    async getQuote(symbol: string): Promise<Quote | null> {
      const cached = quotes.get(symbol);
      if (cached) return cached;
      if (!registry.get(symbol)) {
        try {
          await registry.load();
        } catch {
          return null;
        }
        if (!registry.get(symbol)) return null;
      }
      const wasTemporary = !desired().has(symbol);
      if (wasTemporary) {
        temporary.add(symbol);
        reconcile();
      }
      const quote = await new Promise<Quote | null>((resolve) => {
        const timer = setTimeout(() => {
          quoteWaiters.get(symbol)?.delete(done);
          resolve(null);
        }, QUOTE_WAIT_MS);
        const done = (q: Quote) => {
          clearTimeout(timer);
          resolve(q);
        };
        let set = quoteWaiters.get(symbol);
        if (!set) {
          set = new Set();
          quoteWaiters.set(symbol, set);
        }
        set.add(done);
      });
      if (wasTemporary) {
        temporary.delete(symbol);
        reconcile();
      }
      return quote;
    },

    peekQuote: (symbol: string) => quotes.get(symbol) ?? null,

    subscribe(handler: (event: MarketEvent) => void): Unsubscribe {
      handlers.add(handler);
      return () => {
        handlers.delete(handler);
      };
    },

    connect(): void {
      if (started) return;
      started = true;
      teardown.push(
        ticker.on<rti.BestBidOffer>(T.BestBidOffer, onBbo),
        ticker.on<rti.LastTrade>(T.LastTrade, onTrade),
        ticker.on<rti.OrderBook>(T.OrderBook, onOrderBook),
        ticker.onReconnect(() => {
          // Server-side subscriptions and books died with the old socket.
          subscribed.clear();
          books.clear();
          reconcile();
        }),
        ticker.onState((s) => {
          if (s === "connected") reconcile();
        }),
      );
      registry
        .load()
        .then(reconcile)
        .catch((err: unknown) => console.warn("[rithmic] instrument list unavailable:", describe(err)));
    },

    disconnect(): void {
      if (!started) return;
      for (const [symbol, bits] of subscribed) {
        const inst = registry.get(symbol);
        if (inst && ticker.getState() === "connected") sendSubscription(inst, false, bits).catch(() => undefined);
      }
      started = false;
      for (const off of teardown.splice(0)) off();
      subscribed.clear();
      quotes.clear();
      lastTrades.clear();
      forming.clear();
      depthSubs.clear();
      books.clear();
    },

    onConnectionChange(handler: (state: ConnectionState) => void): Unsubscribe {
      let last: ConnectionState | null = null;
      const update = () => {
        const next = worstState([ticker.getState(), history.getState()]);
        if (next === last) return;
        last = next;
        handler(next);
      };
      const offs = [ticker.onState(update), history.onState(update)];
      return () => offs.forEach((off) => off());
    },

    getConnectionState: () => worstState([ticker.getState(), history.getState()]),

    setSymbolInterest(symbols: string[]): void {
      interest = [...new Set(symbols)];
      reconcile();
    },

    subscribeDepth(symbol: string, handler: (book: DepthBook) => void): Unsubscribe {
      let set = depthSubs.get(symbol);
      const first = !set;
      if (!set) {
        set = new Set();
        depthSubs.set(symbol, set);
      }
      set.add(handler);
      if (first) {
        if (registry.get(symbol)) reconcile();
        else registry.require(symbol).then(reconcile, () => undefined);
      } else {
        // A later subscriber gets the current book right away.
        const b = books.get(symbol);
        if (b) handler(snapshotOf(symbol, b));
      }
      return () => {
        const cur = depthSubs.get(symbol);
        if (!cur?.delete(handler) || cur.size > 0) return;
        depthSubs.delete(symbol);
        reconcile();
      };
    },
  };
}

export function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
