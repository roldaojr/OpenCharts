import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { MarketDataBridge } from "@/components/MarketDataBridge";
import { computeLivePnl } from "@/lib/livePnl";
import { publish } from "@/services/demo/bus";
import type { Order, Position } from "@/services/schemas";

const POS_KEY = ["positions", "SIM"];
const ORD_KEY = ["orders", "SIM", undefined];

const position = (id: string, unrealizedPnl = 0) =>
  ({ id, accountId: "SIM", symbolName: "ESZ6", side: "LONG", quantity: 1, entryPrice: 7473, unrealizedPnl }) as Position;
const order = (id: string) => ({ id, accountId: "SIM", symbolName: "ESZ6", status: "PENDING" }) as Order;

function mount() {
  const client = new QueryClient();
  render(
    <QueryClientProvider client={client}>
      <MarketDataBridge />
    </QueryClientProvider>,
  );
  return client;
}

/** Lets the startTransition patches and the 50ms/150ms batches run. */
const settle = () => act(() => new Promise((r) => setTimeout(r, 250)));

afterEach(cleanup);

describe("trading events never seed a list that was not loaded", () => {
  it("a position update before the first fetch leaves the cache empty", async () => {
    const client = mount();
    publish("positions", { eventType: "PositionUpdated", accountId: "SIM", positionId: "SIM:ESZ6", unrealizedPnl: 5 });
    publish("positions", { eventType: "PositionClosed", accountId: "SIM", positionId: "SIM:NQZ6" });
    await settle();
    // Before the fix this cached [] as fresh data and the open position never showed.
    expect(client.getQueryData(POS_KEY)).toBeUndefined();
  });

  it("an opened position or a new order before the first fetch is not cached alone", async () => {
    const client = mount();
    publish("positions", { eventType: "PositionOpened", accountId: "SIM", positionId: "SIM:ESZ6", _entity: position("SIM:ESZ6") });
    publish("orders", { eventType: "OrderPlaced", accountId: "SIM", orderId: "SIM:o1", _entity: order("SIM:o1") });
    await settle();
    expect(client.getQueryData(POS_KEY)).toBeUndefined();
    expect(client.getQueryData(ORD_KEY)).toBeUndefined();
  });

  it("a position update keeps the P&L and its mark price together", async () => {
    const client = mount();
    // Fetched at 7473.25 (+$12.50); the market then drops to 7440.
    client.setQueryData(POS_KEY, [{ ...position("SIM:ESZ6", 12.5), contractSize: 50, currentPrice: 7473.25 }]);
    publish("positions", {
      eventType: "PositionUpdated",
      accountId: "SIM",
      positionId: "SIM:ESZ6",
      unrealizedPnl: -1650,
      _entity: { ...position("SIM:ESZ6", -1650), currentPrice: 7440 },
    });
    await settle();
    const [p] = client.getQueryData<Position[]>(POS_KEY)!;
    expect(p).toMatchObject({ unrealizedPnl: -1650, currentPrice: 7440 });
    // Live P&L at the same price is then exact: (7440 - 7473) x 1 x $50.
    expect(computeLivePnl(p!, { bid: 7440, ask: 7440.25, timestamp: 0 })).toBe(-1650);
  });

  it("loaded lists are still patched in place", async () => {
    const client = mount();
    client.setQueryData(POS_KEY, [position("SIM:ESZ6"), position("SIM:NQZ6")]);
    client.setQueryData(ORD_KEY, [order("SIM:o1")]);

    publish("positions", { eventType: "PositionUpdated", accountId: "SIM", positionId: "SIM:ESZ6", unrealizedPnl: 42 });
    publish("positions", { eventType: "PositionClosed", accountId: "SIM", positionId: "SIM:NQZ6" });
    publish("positions", { eventType: "PositionOpened", accountId: "SIM", positionId: "SIM:MESZ6", _entity: position("SIM:MESZ6") });
    publish("orders", { eventType: "OrderPlaced", accountId: "SIM", orderId: "SIM:o2", _entity: order("SIM:o2") });
    await settle();

    const positions = client.getQueryData<Position[]>(POS_KEY)!;
    expect(positions.map((p) => p.id)).toEqual(["SIM:ESZ6", "SIM:MESZ6"]);
    expect(positions[0]!.unrealizedPnl).toBe(42);
    expect(client.getQueryData<Order[]>(ORD_KEY)!.map((o) => o.id)).toEqual(["SIM:o2", "SIM:o1"]);
  });
});
