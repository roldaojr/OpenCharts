import { afterEach, describe, expect, it } from "vitest";
import type { Account } from "@/services/schemas";
import { useTradingStore } from "@/services/store";

const nextFrame = () => new Promise((r) => requestAnimationFrame(() => r(null)));

const bar = (close: number) => ({ open: 100, high: 101, low: 99, close, volume: 1, timestamp: 1_700_000_000 });

/** Counts store writes while `fn` runs plus one frame. */
async function writesDuring(fn: () => void): Promise<number> {
  let writes = 0;
  const off = useTradingStore.subscribe(() => writes++);
  fn();
  await nextFrame();
  off();
  return writes;
}

afterEach(() => {
  useTradingStore.setState({ accounts: [], liveCandleUpdates: {} });
});

describe("store writes are batched per frame", () => {
  it("forming candles: many updates make one write and the last bar wins", async () => {
    const { updateCandleFromWs } = useTradingStore.getState();
    const writes = await writesDuring(() => {
      for (let i = 0; i < 100; i++) updateCandleFromWs("ESZ6", "1m", bar(100 + i / 4));
      updateCandleFromWs("ESZ6", "5m", bar(7));
    });
    expect(writes).toBe(1);
    const live = useTradingStore.getState().liveCandleUpdates;
    expect(live["ESZ6:1m"]!.close).toBe(100 + 99 / 4);
    expect(live["ESZ6:5m"]!.close).toBe(7);

    // A later update schedules another frame.
    updateCandleFromWs("ESZ6", "1m", bar(1));
    await nextFrame();
    expect(useTradingStore.getState().liveCandleUpdates["ESZ6:1m"]!.close).toBe(1);
  });

  it("accounts: updates merge per account into one write", async () => {
    useTradingStore.setState({
      accounts: [
        { id: "A", equity: 0, balance: 0 } as Account,
        { id: "B", equity: 0, balance: 0 } as Account,
      ],
    });
    const { updateAccountInStore } = useTradingStore.getState();
    const writes = await writesDuring(() => {
      for (let i = 1; i <= 50; i++) updateAccountInStore({ id: "A", equity: i });
      updateAccountInStore({ id: "A", balance: 10 });
      updateAccountInStore({ id: "B", equity: 5 });
    });
    expect(writes).toBe(1);
    const [a, b] = useTradingStore.getState().accounts;
    expect(a).toMatchObject({ id: "A", equity: 50, balance: 10 });
    expect(b).toMatchObject({ id: "B", equity: 5, balance: 0 });
  });

  it("switching symbol drops forming candles not yet written", async () => {
    const s = useTradingStore.getState();
    s.setSelectedSymbol("ESZ6");
    s.updateCandleFromWs("ESZ6", "1m", bar(5));
    s.setSelectedSymbol("NQZ6");
    await nextFrame();
    expect(useTradingStore.getState().liveCandleUpdates).toEqual({});
  });
});
