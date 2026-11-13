import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { createDemoAdapter } from "@/adapter/demo";
import { __clearAdapter, setAdapter } from "@/adapter/registry";
import type { DepthBook } from "@/adapter/types";
import { DOMPanel } from "@/pages/trading/DOMPanel";
import { getPipDigits, tickDecimals } from "@/pages/trading/utils";

afterEach(() => __clearAdapter());

const TICK = { bid: 7614.75, ask: 7615 };

describe("DOMPanel", () => {
  it("keeps the simulated ladder on the tick grid", () => {
    setAdapter(createDemoAdapter());
    render(<DOMPanel symbol="ESZ6" tick={TICK} tickSize={0.25} />);
    expect(screen.getByText("7,614.75")).toBeTruthy();
    expect(screen.getByText("7,615.25")).toBeTruthy();
    // The old ladder spread around the mid and printed 7,614.87500.
    expect(screen.queryByText(/\.875/)).toBeNull();
  });

  it("shows the adapter's real book when it implements subscribeDepth", async () => {
    const demo = createDemoAdapter();
    let push: ((b: DepthBook) => void) | null = null;
    let unsubscribed = false;
    setAdapter({
      ...demo,
      marketData: {
        ...demo.marketData,
        subscribeDepth: (_symbol, handler) => {
          push = handler;
          return () => {
            unsubscribed = true;
          };
        },
      },
    });
    const view = render(<DOMPanel symbol="ESZ6" tick={TICK} tickSize={0.25} />);
    expect(screen.getByText(/Waiting for order book/)).toBeTruthy();

    await act(async () => {
      push!({
        symbol: "ESZ6",
        bids: [{ price: 7614.75, size: 31 }],
        asks: [{ price: 7615, size: 18 }, { price: 7615.25, size: 40 }],
        timestamp: Date.now(),
      });
      await new Promise((r) => requestAnimationFrame(() => r(null)));
    });
    expect(screen.getByTestId("live-depth")).toBeTruthy();
    expect(screen.getByText("7,614.75")).toBeTruthy();
    expect(screen.getByText("31")).toBeTruthy();
    expect(screen.getByText("40")).toBeTruthy();

    view.unmount();
    expect(unsubscribed).toBe(true);
  });
});

describe("getPipDigits", () => {
  it("follows the tick for futures and crypto", () => {
    expect(getPipDigits({ tickSize: 0.25, category: "Indices" }, "ESZ6")).toBe(2);
    expect(getPipDigits({ tickSize: 0.00005, category: "Currencies" }, "6EZ6")).toBe(5);
    expect(getPipDigits({ tickSize: 1, category: "Indices" }, "YMZ6")).toBe(0);
    expect(getPipDigits({ tickSize: 0.01, category: "CRYPTO" }, "BTCUSD")).toBe(2);
  });

  it("keeps the pipette digit for forex and symbols without a category", () => {
    expect(getPipDigits({ tickSize: 0.0001, category: "FOREX" }, "EURUSD")).toBe(5);
    expect(getPipDigits({ tickSize: 0.0001 }, "EURUSD")).toBe(5);
    expect(getPipDigits(undefined, "ESZ6")).toBe(5);
  });
});

describe("tickDecimals", () => {
  it("counts the decimals of the tick", () => {
    expect(tickDecimals(0.25)).toBe(2);
    expect(tickDecimals(0.0001)).toBe(4);
    expect(tickDecimals(1)).toBe(0);
    expect(tickDecimals(0.03125)).toBe(5);
    expect(tickDecimals(undefined)).toBeNull();
  });
});
