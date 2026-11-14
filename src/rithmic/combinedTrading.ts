import type { Account, TradingEvent, TradingGateway } from "../adapter/types.ts";
import { describe } from "./marketData.ts";
import { isSimulatorId } from "./simulator.ts";

/**
 * One gateway over the real Rithmic accounts and the local simulator account.
 *
 * Calls that name an account go to the side that owns it; calls that only
 * carry an order or position id are routed by the simulator's `SIM:` prefix.
 * Account-less "all" calls go to both.
 */
export function combineTrading<R extends TradingGateway, S extends TradingGateway>(real: R, sim: S): TradingGateway {
  const pick = (id: string | undefined): TradingGateway => (isSimulatorId(id) ? sim : real);

  return {
    async getAccounts(): Promise<Account[]> {
      const simAccounts = await sim.getAccounts();
      try {
        return [...(await real.getAccounts()), ...simAccounts];
      } catch (err) {
        // The simulator stays usable when Rithmic trading is unavailable.
        console.warn("[rithmic] trading accounts unavailable, showing the simulator only:", describe(err));
        return simAccounts;
      }
    },
    getPositions: (accountId) => pick(accountId).getPositions(accountId),
    getOrders: (accountId, status) => pick(accountId).getOrders(accountId, status),
    getClosedPositions: (accountId, page) => pick(accountId).getClosedPositions(accountId, page),

    placeOrder: (input) => pick(input.accountId).placeOrder(input),
    modifyOrder: (orderId, mod) => pick(orderId).modifyOrder(orderId, mod),
    cancelOrder: (orderId) => pick(orderId).cancelOrder(orderId),
    async cancelAllOrders(accountId) {
      if (accountId !== undefined) return pick(accountId).cancelAllOrders(accountId);
      await Promise.all([real.cancelAllOrders(), sim.cancelAllOrders()]);
    },

    closePosition: (positionId, quantity) => pick(positionId).closePosition(positionId, quantity),
    async closeAllPositions(accountId) {
      if (accountId !== undefined) return pick(accountId).closeAllPositions(accountId);
      await Promise.all([real.closeAllPositions(), sim.closeAllPositions()]);
    },
    modifyPosition: (positionId, mod) => pick(positionId).modifyPosition(positionId, mod),

    subscribe(handler: (event: TradingEvent) => void) {
      const offs = [real.subscribe(handler), sim.subscribe(handler)];
      return () => offs.forEach((off) => off());
    },
  };
}
