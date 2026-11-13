import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { decodeFrame, encodeMessage, isNoData, RithmicError } from "../codec.ts";
import { listRithmicSystems, RithmicPlantConnection } from "../connection.ts";
import { rti } from "../generated/rti.js";
import { InfraType, T } from "../templates.ts";
import { FakeRithmicSocketCtor, flush, server } from "./fakeRithmic.ts";

function makeConn(overrides: Partial<ConstructorParameters<typeof RithmicPlantConnection>[0]> = {}) {
  return new RithmicPlantConnection({
    url: "wss://test.rithmic.example:443",
    infraType: InfraType.TICKER_PLANT,
    credentials: { user: "alice", password: "secret", systemName: "Rithmic Test" },
    appName: "OpenCharts",
    appVersion: "0.3.0",
    webSocketImpl: FakeRithmicSocketCtor,
    random: () => 0,
    backoffBaseMs: 100,
    ...overrides,
  });
}

beforeEach(() => server.reset());
afterEach(() => vi.useRealTimers());

describe("codec", () => {
  it("routes a frame by template id and decodes the concrete message", () => {
    const bytes = encodeMessage(rti.ResponseLogin, {
      templateId: T.ResponseLogin,
      rpCode: ["0"],
      fcmId: "F",
      heartbeatInterval: 30,
    });
    const { templateId, message } = decodeFrame(bytes);
    expect(templateId).toBe(T.ResponseLogin);
    expect((message as rti.ResponseLogin).fcmId).toBe("F");
    expect((message as rti.ResponseLogin).heartbeatInterval).toBe(30);
  });

  it("returns a null message for templates it does not know", () => {
    const bytes = encodeMessage(rti.MessageType, { templateId: 9999 });
    expect(decodeFrame(bytes)).toEqual({ templateId: 9999, message: null });
  });

  it("recognises the 'no data' reply code", () => {
    expect(isNoData(new RithmicError("7", "no data", 203))).toBe(true);
    expect(isNoData(new RithmicError("3", "bad", 203))).toBe(false);
  });
});

describe("RithmicPlantConnection", () => {
  it("logs in with the credentials and plant, then reports connected", async () => {
    const conn = makeConn();
    const info = await conn.connect();
    expect(info).toMatchObject({ fcmId: "FCM1", ibId: "IB1", heartbeatIntervalSec: 60 });
    expect(conn.getState()).toBe("connected");
    const [login] = server.requests(T.RequestLogin);
    expect(login!.msg).toMatchObject({
      user: "alice",
      password: "secret",
      systemName: "Rithmic Test",
      appName: "OpenCharts",
      infraType: InfraType.TICKER_PLANT,
    });
    conn.disconnect();
  });

  it("rejects connect() when the login is refused, without retrying", async () => {
    server.loginReply = { rpCode: ["13", "permission denied"] };
    const conn = makeConn();
    await expect(conn.connect()).rejects.toThrow(/login rejected: permission denied/);
    expect(conn.getState()).toBe("disconnected");
    expect(server.requests(T.RequestLogin)).toHaveLength(1);
  });

  it("rejects connect() when the gateway is unreachable", async () => {
    server.reachable = false;
    await expect(makeConn().connect()).rejects.toThrow(/Could not reach Rithmic/);
  });

  it("collects data rows until the closing rp_code and matches replies by user_msg", async () => {
    server.on(T.RequestTimeBarReplay, () => [
      [rti.ResponseTimeBarReplay, { templateId: T.ResponseTimeBarReplay, rqHandlerRpCode: ["0"], marker: 1, closePrice: 10 }],
      [rti.ResponseTimeBarReplay, { templateId: T.ResponseTimeBarReplay, rqHandlerRpCode: ["0"], marker: 2, closePrice: 11 }],
      [rti.ResponseTimeBarReplay, { templateId: T.ResponseTimeBarReplay, rpCode: ["0"] }],
    ]);
    const conn = makeConn();
    await conn.connect();
    const [a, b] = await Promise.all([
      conn.request<rti.IRequestTimeBarReplay, rti.IResponseTimeBarReplay>(rti.RequestTimeBarReplay, { templateId: T.RequestTimeBarReplay, symbol: "A" }),
      conn.request<rti.IRequestTimeBarReplay, rti.IResponseTimeBarReplay>(rti.RequestTimeBarReplay, { templateId: T.RequestTimeBarReplay, symbol: "B" }),
    ]);
    expect(a.rows.map((r) => r.marker)).toEqual([1, 2]);
    expect(b.rows).toHaveLength(2);
    const ids = server.requests(T.RequestTimeBarReplay).map((r) => r.msg.userMsg?.[0]);
    expect(new Set(ids).size).toBe(2);
    conn.disconnect();
  });

  it("rejects a request with the server's rp_code text", async () => {
    server.on(T.RequestMarketDataUpdate, () => [
      [rti.ResponseMarketDataUpdate, { templateId: T.ResponseMarketDataUpdate, rpCode: ["5", "symbol not found"] }],
    ]);
    const conn = makeConn();
    await conn.connect();
    const err = await conn
      .request(rti.RequestMarketDataUpdate, { templateId: T.RequestMarketDataUpdate, symbol: "XX" })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RithmicError);
    expect((err as RithmicError).code).toBe("5");
    expect((err as Error).message).toBe("symbol not found");
    conn.disconnect();
  });

  it("delivers frames without a known user_msg to template listeners", async () => {
    const conn = makeConn();
    await conn.connect();
    const seen: number[] = [];
    conn.on<rti.BestBidOffer>(T.BestBidOffer, (m) => seen.push(m.bidPrice));
    server.plant(InfraType.TICKER_PLANT).push(rti.BestBidOffer, { templateId: T.BestBidOffer, symbol: "ESZ6", bidPrice: 5000.25 });
    await flush();
    expect(seen).toEqual([5000.25]);
    conn.disconnect();
  });

  it("reconnects after a drop, logs in again and fires onReconnect", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    const conn = makeConn();
    await conn.connect();
    const onReconnect = vi.fn();
    conn.onReconnect(onReconnect);
    const states: string[] = [];
    conn.onState((s) => states.push(s));

    server.plant(InfraType.TICKER_PLANT).drop();
    expect(conn.getState()).toBe("reconnecting");
    await vi.advanceTimersByTimeAsync(200);
    await flush();
    expect(conn.getState()).toBe("connected");
    expect(onReconnect).toHaveBeenCalledTimes(1);
    expect(server.requests(T.RequestLogin)).toHaveLength(2);
    expect(states).toEqual(["connected", "reconnecting", "connected"]);
    conn.disconnect();
  });

  it("fails pending requests when the socket drops", async () => {
    server.on(T.RequestMarketDataUpdate, () => []);
    const conn = makeConn();
    await conn.connect();
    const p = conn.request(rti.RequestMarketDataUpdate, { templateId: T.RequestMarketDataUpdate, symbol: "ES" });
    server.plant(InfraType.TICKER_PLANT).drop();
    await expect(p).rejects.toThrow(/connection closed/);
    conn.disconnect();
  });

  it("treats a forced logout as fatal", async () => {
    const conn = makeConn();
    await conn.connect();
    const onFatal = vi.fn();
    conn.onFatal(onFatal);
    server.plant(InfraType.TICKER_PLANT).push(rti.ForcedLogout, { templateId: T.ForcedLogout });
    await flush();
    expect(onFatal).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringMatching(/forced logout/) }));
    expect(conn.getState()).toBe("disconnected");
  });

  it("sends a logout before closing on disconnect()", async () => {
    const conn = makeConn();
    await conn.connect();
    conn.disconnect();
    expect(server.requests(T.RequestLogout)).toHaveLength(1);
    expect(conn.getState()).toBe("disconnected");
  });
});

describe("listRithmicSystems", () => {
  it("returns the system names the gateway offers", async () => {
    server.on(T.RequestRithmicSystemInfo, () => [
      [
        rti.ResponseRithmicSystemInfo,
        { templateId: T.ResponseRithmicSystemInfo, rpCode: ["0"], systemName: ["Rithmic Test", "Rithmic Paper Trading"] },
      ],
    ]);
    await expect(listRithmicSystems("wss://x", { webSocketImpl: FakeRithmicSocketCtor })).resolves.toEqual([
      "Rithmic Test",
      "Rithmic Paper Trading",
    ]);
  });
});
