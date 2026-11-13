import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { BottomPanel } from "@/pages/trading/BottomPanel";
import { NEWS_ENABLED, REPLAY_ENABLED } from "@/pages/trading/constants";

describe("news and replay are switched off", () => {
  it("has both master switches off", () => {
    expect(NEWS_ENABLED).toBe(false);
    expect(REPLAY_ENABLED).toBe(false);
  });

  it("drops the Calendar and News tabs from the bottom panel", () => {
    const noop = () => undefined;
    render(
      <QueryClientProvider client={new QueryClient()}>
        <BottomPanel
          tab="positions"
          onTabChange={noop}
          positions={[]}
          orders={[]}
          accountId={null}
          journalEntries={[]}
          journalLoading={false}
          onCreateJournal={noop}
          onUpdateJournal={noop}
          onDeleteJournal={noop}
        />
      </QueryClientProvider>,
    );
    expect(screen.getByText(/Positions/)).toBeTruthy();
    expect(screen.queryByText("Calendar")).toBeNull();
    expect(screen.queryByText("News")).toBeNull();
  });
});
