import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RithmicAdapter } from "../adapter.ts";
import { rti } from "../generated/rti.js";
import { T } from "../templates.ts";
import { server, type Frame } from "./fakeRithmic.ts";
import { startAdapter } from "./harness.ts";

// Kept apart from trading.test.ts, whose setup starts the trading bootstrap
// before a test could change the account handlers.

const NO_PERMISSION = ["13", "user has no permission to this account"];

let adapter: RithmicAdapter;

function listAccounts(ids: string[]): void {
  server.on(T.RequestAccountList, (): Frame[] => [
    ...ids.map((id): Frame => [
      rti.ResponseAccountList,
      { templateId: T.ResponseAccountList, rqHandlerRpCode: ["0"], fcmId: "FCM1", ibId: "IB1", accountId: id, accountName: id, accountCurrency: "USD" },
    ]),
    [rti.ResponseAccountList, { templateId: T.ResponseAccountList, rpCode: ["0"] }],
  ]);
}

function refuseOrderUpdatesFor(ids: string[]): void {
  server.on(T.RequestSubscribeForOrderUpdates, (req) => [
    [
      rti.ResponseSubscribeForOrderUpdates,
      { templateId: T.ResponseSubscribeForOrderUpdates, rpCode: ids.includes(String(req.msg.accountId)) ? NO_PERMISSION : ["0"] },
    ],
  ]);
}

beforeEach(async () => {
  server.reset();
  adapter = await startAdapter();
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(() => {
  adapter.dispose();
  vi.restoreAllMocks();
});

function refusePnlSnapshot(): void {
  server.on(T.RequestPnLPositionSnapshot, () => [
    [rti.ResponsePnLPositionSnapshot, { templateId: T.ResponsePnLPositionSnapshot, rpCode: NO_PERMISSION }],
  ]);
}

describe("refused account subscriptions", () => {
  it("keeps an account whose order updates are refused and names the request", async () => {
    listAccounts(["A1", "B2"]);
    refuseOrderUpdatesFor(["B2"]);
    const accounts = await adapter.rithmicTrading.getAccounts();
    expect(accounts.map((a) => a.id)).toEqual(["A1", "B2"]);
    expect(console.warn).toHaveBeenCalledWith("[rithmic] B2: Order updates refused: user has no permission to this account");
  });

  it("opens with the only account when its PnL snapshot is refused", async () => {
    listAccounts(["RR1"]);
    refusePnlSnapshot();
    const accounts = await adapter.rithmicTrading.getAccounts();
    expect(accounts.map((a) => a.id)).toEqual(["RR1"]);
    expect(console.warn).toHaveBeenCalledWith("[rithmic] RR1: PnL snapshot refused: user has no permission to this account");
  });

  it("names the bootstrap step when the account list is refused", async () => {
    server.on(T.RequestAccountList, () => [[rti.ResponseAccountList, { templateId: T.ResponseAccountList, rpCode: NO_PERMISSION }]]);
    await expect(adapter.rithmicTrading.getAccounts()).rejects.toThrow("Account list: user has no permission to this account");
  });
});
