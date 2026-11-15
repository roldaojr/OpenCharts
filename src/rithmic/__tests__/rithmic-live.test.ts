import { describe, it } from "vitest";
import { runAdapterConformance } from "../../adapter/conformance.ts";
import { createRithmicAdapter } from "../adapter.ts";
import { getRithmicConfig } from "../config.ts";
import { RithmicSession } from "../session.ts";

/**
 * Runs the conformance suite against a real Rithmic system (the test gateway
 * by default). Opt-in, so CI never needs credentials:
 *
 *   OC_LIVE_TESTS=1 RITHMIC_USER=... RITHMIC_PASSWORD=... RITHMIC_SYSTEM="Rithmic Test" npm test -- rithmic-live
 *
 * Optional: RITHMIC_GATEWAY (wss URL), RITHMIC_PRODUCTS ("ES:CME,NQ:CME").
 * Trading checks stay off: they place real orders.
 */
const env = process.env;
const enabled = env.OC_LIVE_TESTS === "1" && !!env.RITHMIC_USER && !!env.RITHMIC_PASSWORD && !!env.RITHMIC_SYSTEM;

if (enabled) {
  runAdapterConformance(
    "rithmic (live)",
    async () => {
      const config = getRithmicConfig({
        // The live suite targets the test gateway unless told otherwise.
        VITE_RITHMIC_GATEWAY: env.RITHMIC_GATEWAY ?? "wss://rituz00100.rithmic.com:443",
        VITE_RITHMIC_PRODUCTS: env.RITHMIC_PRODUCTS ?? "ES:CME,NQ:CME",
        VITE_RITHMIC_APP_NAME: env.RITHMIC_APP_NAME,
        VITE_RITHMIC_APP_VERSION: env.RITHMIC_APP_VERSION,
      });
      const session = new RithmicSession({
        config,
        credentials: { user: env.RITHMIC_USER!, password: env.RITHMIC_PASSWORD!, systemName: env.RITHMIC_SYSTEM! },
      });
      await session.connect();
      return createRithmicAdapter({ session, products: config.products });
    },
    { timeframe: "1m", tickTimeoutMs: 15_000, allowTrading: false },
  );
} else {
  describe("adapter conformance: rithmic (live)", () => {
    it.skip("set OC_LIVE_TESTS=1 and RITHMIC_USER/RITHMIC_PASSWORD/RITHMIC_SYSTEM to run against Rithmic", () => {});
  });
}
