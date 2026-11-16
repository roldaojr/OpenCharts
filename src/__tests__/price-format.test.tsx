import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OrderPanel } from "@/pages/trading/OrderPanel";
import { OrdersTable } from "@/pages/trading/OrdersTable";
import { PositionsTable } from "@/pages/trading/PositionsTable";
import { formatSymbolPrice, priceFormatterFor } from "@/pages/trading/utils";
import { WatchlistPanel } from "@/pages/trading/WatchlistPanel";
import { OrderConfirmDialog } from "@/components/trading-dialogs/OrderConfirmDialog";
import { queryKeys } from "@/services/queries";

const ES = { name: "ESZ6", tickSize: 0.25, category: "futures" };
const formatPrice = priceFormatterFor([ES]);

afterEach(cleanup);

describe("symbol price formatting", () => {
  it("prints the tick's decimals", () => {
    expect(formatSymbolPrice(5000.25, ES, ES.name)).toBe("5,000.25");
    expect(formatSymbolPrice(5000, { tickSize: 1, category: "futures" }, "YM")).toBe("5,000");
  });

  it("looks symbols up by name and falls back to the name heuristic", () => {
    expect(formatPrice("ESZ6", 5000.5)).toBe("5,000.50");
    expect(formatPrice("EURUSD", 1.1)).toBe("1.10000");
  });
});

describe("prices in the trading UI use the symbol's decimals", () => {
  it("Buy and Sell buttons", () => {
    const client = new QueryClient();
    render(
      <QueryClientProvider client={client}>
        <OrderPanel
          symbol="ESZ6"
          symbolInfo={{ ...ES, contractSize: 50 }}
          tick={{ bid: 5000, ask: 5000.25, timestamp: Date.now() }}
          accountId="acc"
        />
      </QueryClientProvider>,
    );
    expect(screen.getByRole("button", { name: /^BUY\s+5,000\.25$/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^SELL\s+5,000\.00$/ })).toBeInTheDocument();
  });

  it("Positions tab", () => {
    render(
      <PositionsTable
        positions={[
          {
            id: "p1",
            symbolName: "ESZ6",
            side: "LONG",
            quantity: 1,
            entryPrice: 5000.25,
            currentPrice: 5001.5,
            unrealizedPnl: 62.5,
            stopLoss: 4990,
            takeProfit: 5010.75,
            openedAt: new Date().toISOString(),
          },
        ]}
        onClose={vi.fn()}
        formatPrice={formatPrice}
      />,
    );
    for (const text of ["5,000.25", "5,001.50", "4,990.00", "5,010.75"]) {
      expect(screen.getByText(text)).toBeInTheDocument();
    }
  });

  it("order confirmation dialog and watchlist read the symbol list", () => {
    const client = new QueryClient();
    client.setQueryData(queryKeys.market.symbols, [ES]);
    render(
      <QueryClientProvider client={client}>
        <OrderConfirmDialog
          isOpen
          onConfirm={vi.fn()}
          onCancel={vi.fn()}
          order={{ symbol: "ESZ6", side: "BUY", type: "LIMIT", quantity: 1, price: 4995.5, takeProfit: 5010, stopLoss: 4990.25 }}
        />
        <WatchlistPanel
          symbols={[{ name: "ESZ6", category: "futures" }]}
          ticks={{ ESZ6: { bid: 5000, ask: 5000.25, timestamp: Date.now() } }}
          selectedSymbol="ESZ6"
          onSelect={vi.fn()}
        />
      </QueryClientProvider>,
    );
    for (const text of ["4,995.50", "5,010.00", "4,990.25", "5,000.00", "5,000.25"]) {
      expect(screen.getByText(text)).toBeInTheDocument();
    }
  });

  it("Orders tab", () => {
    render(
      <OrdersTable
        orders={[
          {
            id: "o1",
            symbolName: "ESZ6",
            side: "BUY",
            type: "LIMIT",
            quantity: 1,
            price: 4995.75,
            stopLoss: 4985.5,
            takeProfit: 5005,
            status: "PENDING",
            createdAt: new Date().toISOString(),
          },
        ]}
        onCancel={vi.fn()}
        formatPrice={formatPrice}
      />,
    );
    for (const text of ["4,995.75", "4,985.50", "5,005.00"]) {
      expect(screen.getByText(text)).toBeInTheDocument();
    }
  });
});
