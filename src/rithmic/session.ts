import type { ConnectionState, Unsubscribe } from "../adapter/types.ts";
import type { RithmicConfig } from "./config.ts";
import { RithmicPlantConnection, type LoginInfo, type RithmicCredentials } from "./connection.ts";
import { InfraType } from "./templates.ts";

/**
 * A signed-in Rithmic user: one logged-in socket per plant the terminal needs.
 *
 * The password lives only inside the plant connections (for re-login after a
 * dropped socket) and is gone once the session is disconnected; nothing here
 * is persisted.
 */

export interface RithmicSessionOptions {
  config: RithmicConfig;
  credentials: RithmicCredentials;
  /** Overrides `config.gateway`, e.g. a gateway picked on the sign-in screen. */
  gateway?: string;
  webSocketImpl?: typeof WebSocket;
}

export class RithmicSession {
  readonly user: string;
  readonly systemName: string;
  readonly gateway: string;
  readonly ticker: RithmicPlantConnection;
  readonly history: RithmicPlantConnection;
  readonly order: RithmicPlantConnection;
  readonly pnl: RithmicPlantConnection;

  private readonly fatalListeners = new Set<(err: Error) => void>();
  private readonly offs: Unsubscribe[] = [];
  private closed = false;

  constructor(opts: RithmicSessionOptions) {
    const { config, credentials } = opts;
    this.user = credentials.user;
    this.systemName = credentials.systemName;
    this.gateway = opts.gateway ?? config.gateway;
    const make = (infraType: InfraType) =>
      new RithmicPlantConnection({
        url: this.gateway,
        infraType,
        credentials,
        appName: config.appName,
        appVersion: config.appVersion,
        templateVersion: config.templateVersion,
        ...(opts.webSocketImpl ? { webSocketImpl: opts.webSocketImpl } : {}),
      });
    this.ticker = make(InfraType.TICKER_PLANT);
    this.history = make(InfraType.HISTORY_PLANT);
    this.order = make(InfraType.ORDER_PLANT);
    this.pnl = make(InfraType.PNL_PLANT);
    for (const p of this.plants()) {
      this.offs.push(p.onFatal((err) => this.fail(err)));
    }
  }

  plants(): RithmicPlantConnection[] {
    return [this.ticker, this.history, this.order, this.pnl];
  }

  /** Log in to every plant. If any login fails, all are closed and the first error is thrown. */
  async connect(): Promise<LoginInfo> {
    const results = await Promise.allSettled(this.plants().map((p) => p.connect()));
    const failed = results.find((r): r is PromiseRejectedResult => r.status === "rejected");
    if (failed) {
      this.disconnect();
      throw failed.reason instanceof Error ? failed.reason : new Error(String(failed.reason));
    }
    this.closed = false;
    return (results[2] as PromiseFulfilledResult<LoginInfo>).value;
  }

  disconnect(): void {
    for (const p of this.plants()) p.disconnect();
  }

  /** Worst state across plants, for a single status light. */
  getState(): ConnectionState {
    const states = this.plants().map((p) => p.getState());
    if (states.includes("disconnected")) return "disconnected";
    if (states.includes("reconnecting")) return "reconnecting";
    if (states.includes("connecting")) return "connecting";
    return "connected";
  }

  /** The session ended for good (forced logout, rejected re-login). */
  onFatal(listener: (err: Error) => void): Unsubscribe {
    this.fatalListeners.add(listener);
    return () => this.fatalListeners.delete(listener);
  }

  dispose(): void {
    this.disconnect();
    for (const off of this.offs.splice(0)) off();
    this.fatalListeners.clear();
  }

  private fail(err: Error): void {
    if (this.closed) return;
    this.closed = true;
    this.disconnect();
    for (const l of [...this.fatalListeners]) {
      try {
        l(err);
      } catch (e) {
        console.error("[rithmic] session listener threw", e);
      }
    }
  }
}
