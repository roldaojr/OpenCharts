import { describe, expect, it } from "vitest";
import { tradePrice } from "@/pages/trading/utils";
import { useTradingStore } from "@/services/store";

const nextFrame = () => new Promise((r) => requestAnimationFrame(() => r(null)));

describe("last traded price", () => {
  it("tracks the last trade when the feed reports one, else the mid", () => {
    expect(tradePrice({ bid: 7614.75, ask: 7615, last: 7615 })).toBe(7615);
    expect(tradePrice({ bid: 7614.75, ask: 7615 })).toBe(7614.875);
  });

  it("stores the last price with the tick and does not drop a trade at an unchanged quote", async () => {
    const { updateTick } = useTradingStore.getState();
    const ts = Date.now();
    updateTick("LASTTEST", 100, 100.25, ts, 100.25);
    await nextFrame();
    expect(useTradingStore.getState().ticks.LASTTEST).toMatchObject({ bid: 100, ask: 100.25, last: 100.25 });

    // Same bid/ask and timestamp, new trade price: must still update.
    updateTick("LASTTEST", 100, 100.25, ts, 100);
    await nextFrame();
    expect(useTradingStore.getState().ticks.LASTTEST!.last).toBe(100);
  });

  it("leaves quote-only ticks without a last price", async () => {
    useTradingStore.getState().updateTick("QUOTEONLY", 1.1, 1.2, Date.now());
    await nextFrame();
    expect(useTradingStore.getState().ticks.QUOTEONLY).not.toHaveProperty("last");
  });
});
