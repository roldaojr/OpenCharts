import type { ConnectionState, Unsubscribe } from "../adapter/types.ts";
import { decodeFrame, encodeMessage, RithmicError, toBytes, type ReplyFields } from "./codec.ts";
import { rti } from "./generated/rti.js";
import { PLANT_NAMES, T, type InfraType, type MessageCodec } from "./templates.ts";

/**
 * One logged-in WebSocket to one Rithmic plant (ticker, history, order, pnl).
 *
 * - Login: `RequestLogin` (10) is the first frame on every socket; the plant
 *   only answers other requests once `ResponseLogin` (11) says rp_code "0".
 * - Correlation: every request carries a unique `user_msg`, which Rithmic
 *   echoes on each frame of the reply. A reply ends with the frame that has
 *   `rp_code` set; frames before it carry `rq_handler_rp_code` and are data
 *   rows. Frames without a `user_msg` we sent are pushes (ticks, order
 *   notifications, PnL updates) and go to `on(templateId)` listeners.
 * - Heartbeat: `RequestHeartbeat` (18) at the interval the login reply gives;
 *   a socket that stays silent for two intervals is considered dead.
 * - Reconnect: after the first successful login, a dropped socket reconnects
 *   with exponential backoff and jitter, logs in again and fires `onReconnect`
 *   so owners can restore their subscriptions. A rejected login or a
 *   `ForcedLogout` (77) is fatal: no retry, `onFatal` fires.
 */

export interface RithmicCredentials {
  user: string;
  password: string;
  systemName: string;
}

export interface PlantConnectionOptions {
  url: string;
  infraType: InfraType;
  credentials: RithmicCredentials;
  appName: string;
  appVersion: string;
  /** R|Protocol template version sent at login. */
  templateVersion?: string;
  webSocketImpl?: typeof WebSocket;
  /** Default per-request timeout (15s). */
  requestTimeoutMs?: number;
  /** Used until the login reply provides one (seconds, default 30). */
  defaultHeartbeatSec?: number;
  backoffBaseMs?: number;
  backoffMaxMs?: number;
  /** Injected in tests; returns [0,1). */
  random?: () => number;
}

export interface LoginInfo {
  fcmId: string;
  ibId: string;
  uniqueUserId: string;
  heartbeatIntervalSec: number;
}

export interface Reply<R> {
  /** Data rows (frames with rq_handler_rp_code), in arrival order. */
  rows: R[];
  /** The closing frame (the one with rp_code). */
  last: R;
}

export interface RequestOptions {
  timeoutMs?: number;
}

interface Pending {
  rows: unknown[];
  resolve: (reply: Reply<unknown>) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

type Listener = (message: unknown) => void;

export class RithmicPlantConnection {
  readonly plant: string;
  private readonly opts: PlantConnectionOptions;
  private readonly SocketImpl: typeof WebSocket;

  private socket: WebSocket | null = null;
  private state: ConnectionState = "disconnected";
  private wantOpen = false;
  private everLoggedIn = false;
  /** True between a successful login and the socket dropping. */
  private loggedIn = false;
  private attempt = 0;
  private seq = 0;
  private login: LoginInfo | null = null;

  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private lastInbound = 0;

  private readonly pending = new Map<string, Pending>();
  private readonly listeners = new Map<number, Set<Listener>>();
  private readonly stateListeners = new Set<(s: ConnectionState) => void>();
  private readonly reconnectListeners = new Set<() => void>();
  private readonly fatalListeners = new Set<(err: Error) => void>();

  /** Settles the promise returned by connect() for the very first login. */
  private firstLogin: { resolve: (info: LoginInfo) => void; reject: (err: Error) => void } | null = null;

  constructor(opts: PlantConnectionOptions) {
    this.opts = opts;
    this.plant = PLANT_NAMES[opts.infraType] ?? `plant-${opts.infraType}`;
    const impl = opts.webSocketImpl ?? globalThis.WebSocket;
    if (!impl) throw new Error("No WebSocket implementation available");
    this.SocketImpl = impl;
  }

  // ---------------------------------------------------------------- lifecycle

  /**
   * Open the socket and log in. Resolves with the login reply; rejects when the
   * first attempt fails (network or credentials), so a sign-in form can show it.
   */
  connect(): Promise<LoginInfo> {
    if (this.login && this.loggedIn) return Promise.resolve(this.login);
    if (this.firstLogin) {
      return new Promise((resolve, reject) => {
        const prev = this.firstLogin!;
        this.firstLogin = {
          resolve: (i) => (prev.resolve(i), resolve(i)),
          reject: (e) => (prev.reject(e), reject(e)),
        };
      });
    }
    this.wantOpen = true;
    const p = new Promise<LoginInfo>((resolve, reject) => {
      this.firstLogin = { resolve, reject };
    });
    if (!this.socket && !this.reconnectTimer) this.open();
    return p;
  }

  /** Log out, close, and stop reconnecting. */
  disconnect(): void {
    this.wantOpen = false;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    const ws = this.socket;
    if (ws && ws.readyState === 1 && this.login) {
      try {
        ws.send(encodeMessage(rti.RequestLogout, { templateId: T.RequestLogout, userMsg: [this.nextId()] }));
      } catch {
        // closing anyway
      }
    }
    this.teardown(new Error(`Rithmic ${this.plant} plant disconnected`));
    if (ws) {
      try {
        ws.close(1000, "logout");
      } catch {
        // already closed
      }
    }
    this.failFirstLogin(new Error(`Rithmic ${this.plant} plant disconnected`));
    // A later connect() is a fresh session, not a reconnect.
    this.everLoggedIn = false;
    this.attempt = 0;
    this.setState("disconnected");
  }

  getState(): ConnectionState {
    return this.state;
  }

  getLoginInfo(): LoginInfo | null {
    return this.login;
  }

  onState(listener: (s: ConnectionState) => void): Unsubscribe {
    this.stateListeners.add(listener);
    listener(this.state);
    return () => this.stateListeners.delete(listener);
  }

  /** Fires after a dropped socket has reconnected and logged in again. */
  onReconnect(listener: () => void): Unsubscribe {
    this.reconnectListeners.add(listener);
    return () => this.reconnectListeners.delete(listener);
  }

  /** Fires when the session ends for good (forced logout, rejected re-login). */
  onFatal(listener: (err: Error) => void): Unsubscribe {
    this.fatalListeners.add(listener);
    return () => this.fatalListeners.delete(listener);
  }

  /** Push messages of one template (ticks, notifications, PnL updates). */
  on<M = unknown>(templateId: number, listener: (message: M) => void): Unsubscribe {
    let set = this.listeners.get(templateId);
    if (!set) {
      set = new Set();
      this.listeners.set(templateId, set);
    }
    set.add(listener as Listener);
    return () => {
      set.delete(listener as Listener);
    };
  }

  // ----------------------------------------------------------------- requests

  /**
   * Send a request and collect its reply. Rejects with a RithmicError when the
   * closing frame's rp_code is not "0", and with a plain Error on timeout or
   * when the socket drops first.
   */
  request<Req extends { templateId: number; userMsg?: string[] | null }, Res = unknown>(
    codec: MessageCodec<Req>,
    body: Req,
    options: RequestOptions = {},
  ): Promise<Reply<Res>> {
    if (!this.socket || this.socket.readyState !== 1 || (!this.loggedIn && body.templateId !== T.RequestLogin)) {
      return Promise.reject(new Error(`Rithmic ${this.plant} plant is not connected`));
    }
    const id = this.nextId();
    const bytes = encodeMessage(codec, { ...body, userMsg: [id] });
    const timeoutMs = options.timeoutMs ?? this.opts.requestTimeoutMs ?? 15_000;
    return new Promise<Reply<Res>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Rithmic ${this.plant} plant did not answer template ${body.templateId} in time`));
      }, timeoutMs);
      this.pending.set(id, {
        rows: [],
        resolve: resolve as (r: Reply<unknown>) => void,
        reject,
        timer,
      });
      try {
        this.socket!.send(bytes);
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  // ---------------------------------------------------------------- internals

  private nextId(): string {
    this.seq += 1;
    return `oc${this.seq}`;
  }

  private setState(next: ConnectionState): void {
    if (this.state === next) return;
    this.state = next;
    for (const l of [...this.stateListeners]) {
      try {
        l(next);
      } catch (err) {
        console.error("[rithmic] state listener threw", err);
      }
    }
  }

  private open(): void {
    if (this.socket || !this.wantOpen) return;
    this.setState(this.everLoggedIn ? "reconnecting" : "connecting");
    let ws: WebSocket;
    try {
      ws = new this.SocketImpl(this.opts.url);
    } catch (err) {
      this.handleClosed(err instanceof Error ? err : new Error(String(err)));
      return;
    }
    ws.binaryType = "arraybuffer";
    this.socket = ws;

    ws.onopen = () => {
      if (this.socket !== ws) return;
      this.lastInbound = Date.now();
      void this.doLogin();
    };
    ws.onmessage = (ev: MessageEvent) => {
      if (this.socket !== ws) return;
      this.handleFrame(ev.data);
    };
    ws.onerror = () => {
      // onclose follows; nothing else to do.
    };
    ws.onclose = () => {
      if (this.socket !== ws) return;
      this.handleClosed(new Error(`Rithmic ${this.plant} plant connection closed`));
    };
  }

  private async doLogin(): Promise<void> {
    const { credentials, appName, appVersion, infraType } = this.opts;
    try {
      const reply = await this.request<rti.IRequestLogin & { templateId: number }, rti.IResponseLogin>(
        rti.RequestLogin,
        {
          templateId: T.RequestLogin,
          templateVersion: this.opts.templateVersion ?? "3.9",
          user: credentials.user,
          password: credentials.password,
          appName,
          appVersion,
          systemName: credentials.systemName,
          infraType,
        },
      );
      const r = reply.last;
      this.login = {
        fcmId: r.fcmId ?? "",
        ibId: r.ibId ?? "",
        uniqueUserId: r.uniqueUserId ?? "",
        heartbeatIntervalSec: r.heartbeatInterval && r.heartbeatInterval > 0 ? r.heartbeatInterval : this.opts.defaultHeartbeatSec ?? 30,
      };
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      if (err instanceof RithmicError) {
        // Credentials / permissions: retrying cannot help.
        this.fatal(new Error(`Rithmic ${this.plant} login rejected: ${error.message}`));
      } else {
        this.socket?.close();
      }
      return;
    }

    const wasReconnect = this.everLoggedIn;
    this.everLoggedIn = true;
    this.loggedIn = true;
    this.attempt = 0;
    this.startHeartbeat();
    this.setState("connected");
    if (this.firstLogin) {
      const fl = this.firstLogin;
      this.firstLogin = null;
      fl.resolve(this.login);
    }
    if (wasReconnect) {
      for (const l of [...this.reconnectListeners]) {
        try {
          l();
        } catch (err) {
          console.error("[rithmic] reconnect listener threw", err);
        }
      }
    }
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    const intervalMs = Math.max(1, this.login?.heartbeatIntervalSec ?? 30) * 1000;
    const tickMs = Math.max(1_000, Math.floor(intervalMs / 2));
    this.heartbeatTimer = setInterval(() => {
      const ws = this.socket;
      if (!ws || ws.readyState !== 1) return;
      if (Date.now() - this.lastInbound > intervalMs * 2 + 5_000) {
        // Half-open connection: drop it and let the reconnect loop take over.
        ws.close();
        this.handleClosed(new Error(`Rithmic ${this.plant} plant stopped responding`));
        return;
      }
      try {
        ws.send(encodeMessage(rti.RequestHeartbeat, { templateId: T.RequestHeartbeat }));
      } catch {
        // onclose will handle it
      }
    }, tickMs);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  private handleFrame(data: unknown): void {
    const bytes = toBytes(data);
    if (!bytes) return;
    this.lastInbound = Date.now();
    let templateId: number;
    let message: unknown;
    try {
      ({ templateId, message } = decodeFrame(bytes));
    } catch (err) {
      console.error(`[rithmic] ${this.plant}: undecodable frame`, err);
      return;
    }
    if (templateId === T.ForcedLogout) {
      this.fatal(new Error("Rithmic ended the session (forced logout). Another login with the same user may have taken over."));
      return;
    }
    if (!message) return;

    const fields = message as ReplyFields;
    const id = fields.userMsg?.[0];
    const pending = id ? this.pending.get(id) : undefined;
    if (pending && id) {
      const rpCode = fields.rpCode ?? [];
      if (rpCode.length > 0 || templateId === T.Reject) {
        clearTimeout(pending.timer);
        this.pending.delete(id);
        const code = rpCode[0] ?? "-1";
        if (code !== "0") {
          pending.reject(new RithmicError(code, rpCode.slice(1).join(" ") || undefined, templateId));
        } else {
          pending.resolve({ rows: pending.rows, last: message });
        }
      } else {
        pending.rows.push(message);
      }
      return;
    }

    const set = this.listeners.get(templateId);
    if (!set) return;
    for (const l of [...set]) {
      try {
        l(message);
      } catch (err) {
        console.error(`[rithmic] ${this.plant}: listener for template ${templateId} threw`, err);
      }
    }
  }

  /** Drop per-socket state; pending requests fail with `reason`. */
  private teardown(reason: Error): void {
    this.stopHeartbeat();
    this.loggedIn = false;
    const ws = this.socket;
    this.socket = null;
    if (ws) {
      ws.onopen = null;
      ws.onmessage = null;
      ws.onclose = null;
      ws.onerror = null;
    }
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(reason);
      this.pending.delete(id);
    }
  }

  private handleClosed(reason: Error): void {
    this.teardown(reason);
    if (!this.everLoggedIn) {
      // First connect never got through: report it instead of looping.
      this.wantOpen = false;
      this.failFirstLogin(new Error(`Could not reach Rithmic (${this.plant} plant): ${reason.message}`));
      this.setState("disconnected");
      return;
    }
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (!this.wantOpen || this.reconnectTimer) return;
    this.setState("reconnecting");
    const base = this.opts.backoffBaseMs ?? 1_000;
    const max = this.opts.backoffMaxMs ?? 30_000;
    const ceiling = Math.min(max, base * 2 ** this.attempt);
    const delay = Math.round(ceiling / 2 + (this.opts.random ?? Math.random)() * (ceiling / 2));
    this.attempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.open();
    }, delay);
  }

  private failFirstLogin(err: Error): void {
    if (!this.firstLogin) return;
    const fl = this.firstLogin;
    this.firstLogin = null;
    fl.reject(err);
  }

  private fatal(err: Error): void {
    this.wantOpen = false;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    const ws = this.socket;
    this.teardown(err);
    try {
      ws?.close();
    } catch {
      // already closed
    }
    this.login = null;
    this.everLoggedIn = false;
    this.attempt = 0;
    this.setState("disconnected");
    if (this.firstLogin) {
      this.failFirstLogin(err);
      return;
    }
    for (const l of [...this.fatalListeners]) {
      try {
        l(err);
      } catch (e) {
        console.error("[rithmic] fatal listener threw", e);
      }
    }
  }
}

/**
 * The systems ("Rithmic Test", "Rithmic Paper Trading", ...) a gateway serves.
 * Uses its own short-lived socket: Rithmic closes it after answering.
 */
export function listRithmicSystems(
  url: string,
  options: { webSocketImpl?: typeof WebSocket; timeoutMs?: number } = {},
): Promise<string[]> {
  const SocketImpl = options.webSocketImpl ?? globalThis.WebSocket;
  return new Promise((resolve, reject) => {
    let settled = false;
    let ws: WebSocket;
    try {
      ws = new SocketImpl(url);
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
      return;
    }
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
      try {
        ws.close();
      } catch {
        // ignore
      }
    };
    const timer = setTimeout(
      () => finish(() => reject(new Error("Rithmic did not answer the system list request in time"))),
      options.timeoutMs ?? 10_000,
    );
    ws.binaryType = "arraybuffer";
    ws.onopen = () => {
      ws.send(
        encodeMessage(rti.RequestRithmicSystemInfo, {
          templateId: T.RequestRithmicSystemInfo,
          userMsg: ["systems"],
        }),
      );
    };
    ws.onmessage = (ev: MessageEvent) => {
      const bytes = toBytes(ev.data);
      if (!bytes) return;
      try {
        const { templateId, message } = decodeFrame(bytes);
        if (templateId !== T.ResponseRithmicSystemInfo || !message) return;
        const m = message as rti.IResponseRithmicSystemInfo;
        const code = m.rpCode?.[0];
        if (code && code !== "0") {
          finish(() => reject(new RithmicError(code, m.rpCode?.slice(1).join(" "), templateId)));
        } else {
          finish(() => resolve([...(m.systemName ?? [])]));
        }
      } catch (err) {
        finish(() => reject(err instanceof Error ? err : new Error(String(err))));
      }
    };
    ws.onclose = () => finish(() => reject(new Error(`Could not reach the Rithmic gateway at ${url}`)));
  });
}
