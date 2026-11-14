import { createRithmicAdapter } from "../adapter.ts";
import { withManualContract, type RithmicConfig, type RithmicProduct } from "../config.ts";
import { rti } from "../generated/rti.js";
import { RithmicSession } from "../session.ts";
import { T } from "../templates.ts";
import { FakeRithmicSocketCtor, server, type Frame } from "./fakeRithmic.ts";

/** A small but complete fake Rithmic system: two futures, one account, minute bars. */

export const CONFIG: RithmicConfig = {
  gateway: "wss://fake.rithmic.example:443",
  appName: "OpenCharts",
  appVersion: "test",
  templateVersion: "3.9",
  // Manual contracts as in the default config, pinned to a date so names are stable.
  products: [
    { product: "ES", exchange: "CME" },
    { product: "NQ", exchange: "CME" },
  ].map((p) => withManualContract(p, {}, new Date("2026-11-12T12:00:00Z"))),
};

const CONTRACTS: Record<string, { symbol: string; name: string; tick: number; point: number; px: number }> = {
  ES: { symbol: "ESZ6", name: "E-Mini S&P 500", tick: 0.25, point: 50, px: 5000 },
  NQ: { symbol: "NQZ6", name: "E-Mini Nasdaq-100", tick: 0.25, point: 20, px: 18000 },
};

const bySymbol = (symbol: string) => Object.values(CONTRACTS).find((c) => c.symbol === symbol);

const BAR_COUNT = 300;

export function installDefaultHandlers(): void {
  server.on(T.RequestFrontMonthContract, ({ msg }) => {
    const c = CONTRACTS[String(msg.symbol)];
    if (!c) return [[rti.ResponseFrontMonthContract, { templateId: T.ResponseFrontMonthContract, rpCode: ["7", "no data"] }]];
    return [
      [
        rti.ResponseFrontMonthContract,
        {
          templateId: T.ResponseFrontMonthContract,
          rpCode: ["0"],
          symbol: msg.symbol,
          exchange: msg.exchange,
          symbolName: c.name,
          tradingSymbol: c.symbol,
          tradingExchange: "CME",
          isFrontMonthSymbol: true,
        },
      ],
    ];
  });

  server.on(T.RequestReferenceData, ({ msg }) => {
    const c = bySymbol(String(msg.symbol));
    return [
      [
        rti.ResponseReferenceData,
        {
          templateId: T.ResponseReferenceData,
          rpCode: ["0"],
          symbol: msg.symbol,
          exchange: msg.exchange,
          symbolName: c?.name,
          productCode: String(msg.symbol).slice(0, 2),
          minQpriceChange: c?.tick ?? 0.25,
          singlePointValue: c?.point ?? 50,
          currency: "USD",
        },
      ],
    ];
  });

  server.on(T.RequestTimeBarReplay, ({ msg }) => {
    const c = bySymbol(String(msg.symbol));
    const period = Number(msg.barTypePeriod || 1) * 60;
    const last = Math.floor(Date.now() / 1000 / period) * period;
    const start = Number(msg.startIndex ?? 0);
    const finish = Number(msg.finishIndex ?? last);
    const bars: Frame[] = [];
    for (let i = BAR_COUNT - 1; i >= 0; i--) {
      const t = last - i * period;
      if (t < start || t > finish) continue;
      const o = (c?.px ?? 100) + (i % 7);
      bars.push([
        rti.ResponseTimeBarReplay,
        {
          templateId: T.ResponseTimeBarReplay,
          rqHandlerRpCode: ["0"],
          symbol: msg.symbol,
          exchange: msg.exchange,
          type: msg.barType,
          period: String(msg.barTypePeriod),
          marker: t,
          openPrice: o,
          highPrice: o + 2,
          lowPrice: o - 1,
          closePrice: o + 1,
          volume: 10 + i,
        },
      ]);
    }
    const max = Number(msg.userMaxCount || bars.length);
    const out = bars.slice(-max);
    // Duplicate one row, as a resumed replay can, to prove de-duplication.
    if (out.length > 1) out.push(out[out.length - 1]!);
    return [...out, [rti.ResponseTimeBarReplay, { templateId: T.ResponseTimeBarReplay, rpCode: ["0"] }]];
  });

  server.on(T.RequestMarketDataUpdate, (req) => {
    const c = bySymbol(String(req.msg.symbol));
    if (req.msg.request === rti.RequestMarketDataUpdate.Request.SUBSCRIBE && c) {
      const now = Math.floor(Date.now() / 1000);
      req.socket.push(rti.BestBidOffer, {
        templateId: T.BestBidOffer,
        symbol: c.symbol,
        exchange: "CME",
        isSnapshot: true,
        presenceBits: 3,
        bidPrice: c.px,
        bidSize: 10,
        askPrice: c.px + c.tick,
        askSize: 12,
        ssboe: now,
      });
    }
    return [[rti.ResponseMarketDataUpdate, { templateId: T.ResponseMarketDataUpdate, rpCode: ["0"] }]];
  });

  server.on(T.RequestLoginInfo, () => [
    [rti.ResponseLoginInfo, { templateId: T.ResponseLoginInfo, rpCode: ["0"], fcmId: "FCM1", ibId: "IB1", userType: 3, user: "alice" }],
  ]);

  server.on(T.RequestAccountList, () => [
    [rti.ResponseAccountList, { templateId: T.ResponseAccountList, rqHandlerRpCode: ["0"], fcmId: "FCM1", ibId: "IB1", accountId: "A1", accountName: "Sim 1", accountCurrency: "USD" }],
    [rti.ResponseAccountList, { templateId: T.ResponseAccountList, rpCode: ["0"] }],
  ]);

  server.on(T.RequestTradeRoutes, () => [
    [rti.ResponseTradeRoutes, { templateId: T.ResponseTradeRoutes, rqHandlerRpCode: ["0"], fcmId: "FCM1", ibId: "IB1", exchange: "CME", tradeRoute: "simulator", status: "UP", isDefault: true }],
    [rti.ResponseTradeRoutes, { templateId: T.ResponseTradeRoutes, rpCode: ["0"] }],
  ]);

  server.on(T.RequestPnLPositionSnapshot, (req) => {
    req.socket.push(rti.AccountPnLPositionUpdate, {
      templateId: T.AccountPnLPositionUpdate,
      isSnapshot: true,
      fcmId: "FCM1",
      ibId: "IB1",
      accountId: "A1",
      accountBalance: "50000",
      openPositionPnl: "0",
      availableBuyingPower: "50000",
      usedBuyingPower: "0",
    });
    return [[rti.ResponsePnLPositionSnapshot, { templateId: T.ResponsePnLPositionSnapshot, rpCode: ["0"] }]];
  });
}

export async function startAdapter(products: readonly RithmicProduct[] = CONFIG.products) {
  installDefaultHandlers();
  const session = new RithmicSession({
    config: CONFIG,
    credentials: { user: "alice", password: "secret", systemName: "Rithmic Test" },
    webSocketImpl: FakeRithmicSocketCtor,
  });
  await session.connect();
  const memory = new Map<string, string>();
  return createRithmicAdapter({
    session,
    products,
    simulatorStore: {
      getItem: (k) => memory.get(k) ?? null,
      setItem: (k, v) => void memory.set(k, v),
      removeItem: (k) => void memory.delete(k),
    },
    storage: {
      get: (k) => memory.get(k) ?? null,
      set: (k, v) => {
        memory.set(k, v);
      },
      remove: (k) => {
        memory.delete(k);
      },
    },
  });
}
