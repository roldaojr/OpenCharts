import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { OrderPanel } from "@/pages/trading/OrderPanel";
import type { Account } from "@/services/schemas";
import { useTradingStore } from "@/services/store";

function account(id: string, label: string | null): Account {
  const now = new Date().toISOString();
  return {
    id,
    userId: "u",
    templateId: "t",
    label,
    status: "ACTIVE",
    balance: 50_000,
    equity: 50_000,
    margin: 0,
    freeMargin: 50_000,
    phase: "LIVE",
    startDate: now,
    createdAt: now,
    updatedAt: now,
    isHftMode: false,
  };
}

/** Wires the ticket to the store the way the terminal does. */
function Ticket() {
  const accountId = useTradingStore((s) => s.activeAccountId);
  return <OrderPanel symbol="ESZ6" accountId={accountId} />;
}

function renderTicket(accounts: Account[], activeAccountId: string | null) {
  useTradingStore.setState({ accounts, activeAccountId });
  render(
    <QueryClientProvider client={new QueryClient()}>
      <Ticket />
    </QueryClientProvider>,
  );
  return screen.getByTestId("order-account-select") as HTMLSelectElement;
}

afterEach(() => {
  cleanup();
  useTradingStore.setState({ accounts: [], activeAccountId: null });
});

describe("order ticket account selector", () => {
  it("shows the selector with a single account selected", () => {
    const select = renderTicket([account("RR18424", "RR18424")], "RR18424");
    expect([...select.options].map((o) => o.text)).toEqual(["RR18424"]);
    expect(select.value).toBe("RR18424");
    expect(select.disabled).toBe(false);
  });

  it("switches the active account", () => {
    const select = renderTicket([account("A1", "Sim 1 (A1)"), account("B2", null)], "A1");
    expect([...select.options].map((o) => o.text)).toEqual(["Sim 1 (A1)", "B2"]);
    fireEvent.change(select, { target: { value: "B2" } });
    expect(useTradingStore.getState().activeAccountId).toBe("B2");
    expect(select.value).toBe("B2");
  });

  it("is disabled with no accounts", () => {
    const select = renderTicket([], null);
    expect(select.disabled).toBe(true);
    expect([...select.options].map((o) => o.text)).toEqual(["No accounts"]);
  });
});
