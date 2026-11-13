import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { formatNumber, cn } from "../../lib/utils.ts";
import { isHyperliquidMode } from "../../hyperliquid/ui/mode.ts";
import { getAdapter, hasAdapter } from "../../adapter/registry.ts";
import type { DepthBook, DepthLevel } from "../../adapter/types.ts";
import { tickDecimals } from "./utils.ts";

// Live brokers show the real book; loaded on demand so the demo bundle is unchanged.
const HlDepthPanel = lazy(() =>
  import("../../hyperliquid/ui/HlDepthPanel.tsx").then((m) => ({ default: m.HlDepthPanel })),
);

const LIVE_LEVELS = 10;

/**
 * Deterministic pseudo-random depth for a price level.
 *
 * The bundled market data carries no order book, so ladder sizes are
 * simulated. Deriving them from the price level (rather than Math.random on
 * every render) keeps a level's size stable while the price hovers, so the
 * ladder no longer reshuffles every tick — and the component stays pure.
 */
function depthAt(symbol: string, price: number, spread: number, base: number, range: number): number {
  // Bucket by tick so tiny float noise does not reshuffle the book.
  const bucket = spread > 0 ? Math.round(price / spread) : Math.round(price);
  let hash = 2166136261 ^ bucket;
  for (let i = 0; i < symbol.length; i += 1) {
    hash = Math.imul(hash ^ symbol.charCodeAt(i), 16777619);
  }
  const unit = ((hash >>> 0) % 1000) / 1000;
  return Math.floor(unit * range + base);
}

interface DOMPanelProps {
  symbol: string;
  tick?: { bid: number; ask: number };
  /** Price increment; levels sit on this grid and print with its decimals. */
  tickSize?: number;
}

/**
 * Depth of market. Hyperliquid has its own panel; any other adapter that
 * implements `marketData.subscribeDepth` gets its real book; the rest (the
 * demo data) get a simulated ladder.
 */
export function DOMPanel(props: DOMPanelProps) {
  if (isHyperliquidMode()) {
    return (
      <Suspense fallback={null}>
        <HlDepthPanel symbol={props.symbol} />
      </Suspense>
    );
  }
  const subscribeDepth = hasAdapter() ? getAdapter().marketData.subscribeDepth : undefined;
  if (subscribeDepth) return <LiveDepthPanel {...props} />;
  return <SimulatedDOMPanel {...props} />;
}

function Header({ title, symbol }: { title: string; symbol: string }) {
  return (
    <div className="flex items-center justify-between px-3 py-2 border-b border-border bg-secondary">
      <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{title}</h3>
      <span className="text-xs font-semibold">{symbol}</span>
    </div>
  );
}

interface Row {
  price: number;
  bidSize: number;
  askSize: number;
  type: "bid" | "ask";
}

function Ladder({ rows, digits }: { rows: Row[]; digits: number }) {
  const maxSize = Math.max(...rows.map((l) => Math.max(l.bidSize, l.askSize)), 1);
  return (
    <table className="w-full text-[11px]">
      <thead className="sticky top-0 bg-card z-10">
        <tr>
          <th className="text-right w-[30%]">Bid Size</th>
          <th className="text-center w-[40%]">Price</th>
          <th className="text-left w-[30%]">Ask Size</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((l) => (
          <tr key={`${l.type}-${l.price}`} className="relative hover:bg-secondary/50">
            <td className="text-right relative">
              {l.bidSize > 0 && (
                <>
                  <div
                    className="absolute inset-y-0 right-0 bg-buy/20"
                    style={{ width: `${(l.bidSize / maxSize) * 100}%` }}
                  />
                  <span className="relative text-buy">{l.bidSize}</span>
                </>
              )}
            </td>
            <td className={cn("text-center font-mono", l.type === "ask" ? "text-sell" : "text-buy")}>
              {formatNumber(l.price, digits)}
            </td>
            <td className="text-left relative">
              {l.askSize > 0 && (
                <>
                  <div
                    className="absolute inset-y-0 left-0 bg-sell/20"
                    style={{ width: `${(l.askSize / maxSize) * 100}%` }}
                  />
                  <span className="relative text-sell">{l.askSize}</span>
                </>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Decimals for a book without a known tick: the most any of its prices needs, at most 5. */
function digitsOf(levels: DepthLevel[]): number {
  let d = 0;
  for (const { price } of levels) {
    const s = String(price);
    const i = s.indexOf(".");
    if (i >= 0) d = Math.max(d, s.length - i - 1);
  }
  return Math.min(d, 5);
}

/** The adapter's real order book, best levels around the spread. */
function LiveDepthPanel({ symbol, tickSize }: DOMPanelProps) {
  const [state, setState] = useState<{ symbol: string; book: DepthBook } | null>(null);
  const latest = useRef<DepthBook | null>(null);

  useEffect(() => {
    const subscribeDepth = getAdapter().marketData.subscribeDepth;
    if (!subscribeDepth) return;
    let frame = 0;
    // Books can update many times a second: render at most once per frame.
    const off = subscribeDepth(symbol, (book) => {
      latest.current = book;
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        if (latest.current) setState({ symbol, book: latest.current });
      });
    });
    return () => {
      off();
      if (frame) cancelAnimationFrame(frame);
      latest.current = null;
    };
  }, [symbol]);

  const book = state?.symbol === symbol ? state.book : null;
  const rows: Row[] = useMemo(() => {
    if (!book) return [];
    const asks = book.asks
      .slice(0, LIVE_LEVELS)
      .reverse()
      .map((l): Row => ({ price: l.price, bidSize: 0, askSize: l.size, type: "ask" }));
    const bids = book.bids
      .slice(0, LIVE_LEVELS)
      .map((l): Row => ({ price: l.price, bidSize: l.size, askSize: 0, type: "bid" }));
    return [...asks, ...bids];
  }, [book]);
  const digits = tickDecimals(tickSize) ?? (book ? digitsOf([...book.bids, ...book.asks]) : 2);

  return (
    <div className="flex flex-col h-full" data-testid="live-depth">
      <Header title="Depth of Market" symbol={symbol} />
      <div className="flex-1 overflow-y-auto">
        {!book ? (
          <p className="p-3 text-center text-xs text-muted-foreground">Waiting for order book…</p>
        ) : rows.length === 0 ? (
          <p className="p-3 text-center text-xs text-muted-foreground">No order book</p>
        ) : (
          <Ladder rows={rows} digits={digits} />
        )}
      </div>
    </div>
  );
}

function SimulatedDOMPanel({ symbol, tick, tickSize }: DOMPanelProps) {
  const tickDigits = tickDecimals(tickSize);
  const levels = useMemo(() => {
    if (!tick) return [];
    // On a known tick grid, step from the bid and ask themselves; otherwise
    // fall back to spreading around the mid with the spread as the step.
    const onGrid = tickDigits !== null;
    const step = onGrid ? tickSize! : tick.ask - tick.bid || 0.0001;
    const askBase = onGrid ? tick.ask : (tick.bid + tick.ask) / 2;
    const bidBase = onGrid ? tick.bid : (tick.bid + tick.ask) / 2;
    const result: Row[] = [];

    for (let i = 10; i >= 1; i--) {
      const price = askBase + step * i;
      result.push({ price, bidSize: 0, askSize: depthAt(symbol, price, step, 5, 50), type: "ask" });
    }
    result.push({ price: tick.ask, bidSize: 0, askSize: depthAt(symbol, tick.ask, step, 20, 100), type: "ask" });
    result.push({ price: tick.bid, bidSize: depthAt(symbol, tick.bid, step, 20, 100), askSize: 0, type: "bid" });
    for (let i = 1; i <= 10; i++) {
      const price = bidBase - step * i;
      result.push({ price, bidSize: depthAt(symbol, price, step, 5, 50), askSize: 0, type: "bid" });
    }
    return result;
  }, [symbol, tick, tickSize, tickDigits]);

  return (
    <div className="flex flex-col h-full">
      <Header title="Depth of Market" symbol={symbol} />
      <div className="flex-1 overflow-y-auto">
        <Ladder rows={levels} digits={tickDigits ?? 5} />
      </div>
    </div>
  );
}
