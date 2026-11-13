import { rti } from "../generated/rti.js";
import { T, type MessageCodec } from "../templates.ts";

/**
 * An in-memory Rithmic gateway for tests. Sockets created through
 * `FakeRithmicSocketCtor` talk to `server`: requests are decoded with the real
 * generated codec and answered with real protobuf frames, so the adapter is
 * exercised end to end without a network.
 *
 * Login and heartbeat are answered automatically. Everything else is up to a
 * handler registered with `server.on(templateId, fn)`; a handler returns the
 * frames to send back (each `[codec, body]`, `user_msg` echoed for you).
 */

/** Request templates the fake can decode. */
const REQUEST_CODECS: Record<number, MessageCodec<unknown>> = {
  [T.RequestLogin]: rti.RequestLogin,
  [T.RequestLogout]: rti.RequestLogout,
  [T.RequestHeartbeat]: rti.RequestHeartbeat,
  [T.RequestRithmicSystemInfo]: rti.RequestRithmicSystemInfo,
  [T.RequestReferenceData]: rti.RequestReferenceData,
  [T.RequestMarketDataUpdate]: rti.RequestMarketDataUpdate,
  [T.RequestFrontMonthContract]: rti.RequestFrontMonthContract,
  [T.RequestTimeBarReplay]: rti.RequestTimeBarReplay,
  [T.RequestResumeBars]: rti.RequestResumeBars,
  [T.RequestLoginInfo]: rti.RequestLoginInfo,
  [T.RequestAccountList]: rti.RequestAccountList,
  [T.RequestTradeRoutes]: rti.RequestTradeRoutes,
  [T.RequestSubscribeForOrderUpdates]: rti.RequestSubscribeForOrderUpdates,
  [T.RequestNewOrder]: rti.RequestNewOrder,
  [T.RequestModifyOrder]: rti.RequestModifyOrder,
  [T.RequestCancelOrder]: rti.RequestCancelOrder,
  [T.RequestCancelAllOrders]: rti.RequestCancelAllOrders,
  [T.RequestShowOrders]: rti.RequestShowOrders,
  [T.RequestBracketOrder]: rti.RequestBracketOrder,
  [T.RequestExitPosition]: rti.RequestExitPosition,
  [T.RequestPnLPositionUpdates]: rti.RequestPnLPositionUpdates,
  [T.RequestPnLPositionSnapshot]: rti.RequestPnLPositionSnapshot,
};

/** Anything that can encode a server frame (any generated rti message class). */
export interface Encoder {
  encode(message: never): { finish(): Uint8Array };
}

export type Frame = [Encoder, Record<string, unknown>];

export interface Received {
  socket: FakeRithmicSocket;
  templateId: number;
  /** Decoded request (camelCase fields). */
  msg: Record<string, unknown> & { templateId: number; userMsg?: string[] };
}

type Handler = (req: Received) => Frame[] | void;

export class FakeRithmicServer {
  sockets: FakeRithmicSocket[] = [];
  received: Received[] = [];
  handlers = new Map<number, Handler>();
  /** Login answer; set rpCode to reject. */
  loginReply: Record<string, unknown> = { rpCode: ["0"], fcmId: "FCM1", ibId: "IB1", heartbeatInterval: 60, uniqueUserId: "u-1" };
  /** When false, sockets never open (unreachable gateway). */
  reachable = true;

  reset(): void {
    this.sockets = [];
    this.received = [];
    this.handlers.clear();
    this.loginReply = { rpCode: ["0"], fcmId: "FCM1", ibId: "IB1", heartbeatInterval: 60, uniqueUserId: "u-1" };
    this.reachable = true;
  }

  on(templateId: number, handler: Handler): void {
    this.handlers.set(templateId, handler);
  }

  requests(templateId: number): Received[] {
    return this.received.filter((r) => r.templateId === templateId);
  }

  /** The logged-in socket of a plant (1 ticker, 2 order, 3 history, 4 pnl). */
  plant(infraType: number): FakeRithmicSocket {
    const s = [...this.sockets].reverse().find((x) => x.infraType === infraType && x.readyState === 1);
    if (!s) throw new Error(`no open socket for plant ${infraType}`);
    return s;
  }

  handle(socket: FakeRithmicSocket, bytes: Uint8Array): void {
    const { templateId } = rti.MessageType.decode(bytes);
    const codec = REQUEST_CODECS[templateId];
    if (!codec) throw new Error(`fake Rithmic cannot decode template ${templateId}`);
    const msg = { ...(codec.decode(bytes) as object) } as Received["msg"];
    const req: Received = { socket, templateId, msg };
    this.received.push(req);

    if (templateId === T.RequestLogin) {
      socket.infraType = Number(msg.infraType ?? 0);
      socket.reply(msg, [[rti.ResponseLogin, { templateId: T.ResponseLogin, ...this.loginReply }]]);
      return;
    }
    if (templateId === T.RequestHeartbeat) {
      socket.reply(msg, [[rti.ResponseHeartbeat, { templateId: T.ResponseHeartbeat, rpCode: ["0"] }]]);
      return;
    }
    const handler = this.handlers.get(templateId);
    const frames = handler?.(req);
    if (frames) {
      socket.reply(msg, frames);
    } else if (!handler) {
      // Unhandled requests get a bare success, which is enough for acks.
      socket.reply(msg, [[ackCodec(templateId), { templateId: templateId + 1, rpCode: ["0"] }]]);
    }
  }
}

/** Every response type starts with template_id/user_msg/rp_code; Reject encodes just those. */
function ackCodec(_templateId: number): Encoder {
  return rti.Reject;
}

export const server = new FakeRithmicServer();

export class FakeRithmicSocket {
  binaryType = "blob";
  readyState = 0;
  infraType = 0;
  closed = false;
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: ArrayBuffer }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(readonly url: string) {
    server.sockets.push(this);
    queueMicrotask(() => {
      if (this.closed) return;
      if (!server.reachable) {
        this.readyState = 3;
        this.onerror?.();
        this.onclose?.();
        return;
      }
      this.readyState = 1;
      this.onopen?.();
    });
  }

  send(data: Uint8Array): void {
    if (this.readyState !== 1) throw new Error("socket not open");
    server.handle(this, data);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.readyState = 3;
    this.onclose?.();
  }

  /** Simulate the network dropping the connection. */
  drop(): void {
    this.close();
  }

  /** Send frames answering `req` (user_msg echoed). */
  reply(req: { userMsg?: string[] }, frames: Frame[]): void {
    for (const [codec, body] of frames) this.push(codec, { userMsg: req.userMsg ?? [], ...body });
  }

  /** Push one server frame (asynchronously, like a real socket). */
  push(codec: Encoder, body: Record<string, unknown>): void {
    const bytes = codec.encode(body as never).finish();
    // Copy: protobufjs may hand back a Node Buffer that views a shared pool.
    const copy = Uint8Array.from(bytes).buffer;
    queueMicrotask(() => {
      if (this.readyState === 1) this.onmessage?.({ data: copy });
    });
  }
}

export const FakeRithmicSocketCtor = FakeRithmicSocket as unknown as typeof WebSocket;

/** Let queued microtasks (socket opens, replies) run. */
export async function flush(times = 10): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

export const codecs = rti;
