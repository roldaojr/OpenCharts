/**
 * Build-time configuration for the Rithmic adapter. This is the only Rithmic
 * module that reads `import.meta.env`; everything else takes a `RithmicConfig`.
 *
 *   VITE_RITHMIC_GATEWAY      wss URL of the R|Protocol gateway
 *                             (default: the Rithmic test gateway)
 *   VITE_RITHMIC_APP_NAME     app name sent at login. Production systems only
 *   VITE_RITHMIC_APP_VERSION  accept names that passed Rithmic conformance.
 *   VITE_RITHMIC_PRODUCTS     comma-separated PRODUCT:EXCHANGE list, resolved to
 *                             front-month contracts at sign-in
 *   VITE_RITHMIC_CONTRACTS    optional PRODUCT:CONTRACT overrides for the manual
 *                             map, e.g. "ES:ESH7,NQ:NQH7"
 *
 * ES, MES, NQ and MNQ are mapped manually (MANUAL_CONTRACTS + the quarterly
 * roll rule below) because RequestFrontMonthContract does not answer on the
 * Rithmic test system. Other products still go through that request.
 */

export const RITHMIC_TEST_GATEWAY = "wss://rituz00100.rithmic.com:443";

export interface RithmicGateway {
  /** Location shown on the sign-in screen, e.g. "Chicago". */
  name: string;
  /** wss URL of the R|Protocol gateway. */
  url: string;
}

/** The R|Protocol gateways Rithmic publishes, offered on the sign-in screen. */
export const RITHMIC_GATEWAYS: readonly RithmicGateway[] = [
  { name: "Chicago", url: "wss://rprotocol-mobile.rithmic.com:443" },
  { name: "Cape Town", url: "wss://rprotocol-za.rithmic.com:443" },
  { name: "Frankfurt", url: "wss://rprotocol-de.rithmic.com:443" },
  { name: "Hong Kong", url: "wss://rprotocol-hk.rithmic.com:443" },
  { name: "Ireland", url: "wss://rprotocol-ie.rithmic.com:443" },
  { name: "Mumbai", url: "wss://rprotocol-in.rithmic.com:443" },
  { name: "New York", url: "wss://rprotocol-nyc.rithmic.com:443" },
  { name: "Sao Paulo", url: "wss://rprotocol-br.rithmic.com:443" },
  { name: "Seoul", url: "wss://rprotocol-kr.rithmic.com:443" },
  { name: "Singapore", url: "wss://rprotocol-sg.rithmic.com:443" },
  { name: "Sydney", url: "wss://rprotocol-au.rithmic.com:443" },
  { name: "Tokyo", url: "wss://rprotocol-jp.rithmic.com:443" },
  { name: "Test", url: RITHMIC_TEST_GATEWAY },
];

export interface RithmicProduct {
  /** Product code, e.g. "ES". */
  product: string;
  /** Exchange, e.g. "CME". */
  exchange: string;
  /** Contract to trade, e.g. "ESZ6". When set, no front-month lookup is made. */
  contract?: string;
  /** Fallbacks used when reference data is unavailable. */
  tickSize?: number;
  pointValue?: number;
  description?: string;
}

export interface RithmicConfig {
  gateway: string;
  appName: string;
  appVersion: string;
  templateVersion: string;
  products: RithmicProduct[];
}

/** Contract specs for the products resolved locally instead of via RequestFrontMonthContract. */
export const MANUAL_CONTRACTS: Readonly<Record<string, Required<Omit<RithmicProduct, "product" | "contract">>>> = {
  ES: { exchange: "CME", tickSize: 0.25, pointValue: 50, description: "E-Mini S&P 500" },
  MES: { exchange: "CME", tickSize: 0.25, pointValue: 5, description: "Micro E-Mini S&P 500" },
  NQ: { exchange: "CME", tickSize: 0.25, pointValue: 20, description: "E-Mini Nasdaq-100" },
  MNQ: { exchange: "CME", tickSize: 0.25, pointValue: 2, description: "Micro E-Mini Nasdaq-100" },
};

const QUARTER_CODES: Readonly<Record<number, string>> = { 3: "H", 6: "M", 9: "U", 12: "Z" };

/** Third Friday of a month (UTC), as a day of the month. */
function thirdFriday(year: number, month: number): number {
  const weekday = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
  return 1 + ((5 - weekday + 7) % 7) + 14;
}

/**
 * The quarterly (H/M/U/Z) equity-index contract to trade on `now`, e.g.
 * "ESZ6". Rolls 8 days before the third Friday of the expiry month, CME's
 * equity-index roll date. The year is one digit, as Rithmic names contracts.
 */
export function quarterlyContract(product: string, now: Date = new Date()): string {
  let year = now.getUTCFullYear();
  let month = Math.ceil((now.getUTCMonth() + 1) / 3) * 3;
  for (;;) {
    const roll = Date.UTC(year, month - 1, thirdFriday(year, month) - 8);
    if (now.getTime() < roll) break;
    month += 3;
    if (month > 12) {
      month = 3;
      year += 1;
    }
  }
  return `${product}${QUARTER_CODES[month]}${year % 10}`;
}

/** PRODUCT:CONTRACT overrides, e.g. "ES:ESH7,NQ:NQH7". */
export function parseContracts(raw: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (raw ?? "").split(/[\s,]+/)) {
    const [product, contract] = part.split(":").map((s) => s.trim().toUpperCase());
    if (product && contract) out[product] = contract;
  }
  return out;
}

/** Fill in the manual contract and specs for products in MANUAL_CONTRACTS. */
export function withManualContract(
  p: RithmicProduct,
  overrides: Readonly<Record<string, string>> = {},
  now: Date = new Date(),
): RithmicProduct {
  const spec = MANUAL_CONTRACTS[p.product];
  if (!spec || p.exchange !== spec.exchange) return p;
  return {
    ...spec,
    ...p,
    contract: p.contract ?? overrides[p.product] ?? quarterlyContract(p.product, now),
  };
}

export const DEFAULT_PRODUCTS: readonly RithmicProduct[] = [
  { product: "ES", exchange: "CME" },
  { product: "MES", exchange: "CME" },
  { product: "NQ", exchange: "CME" },
  { product: "MNQ", exchange: "CME" },
];

export function parseProducts(raw: string | undefined): RithmicProduct[] {
  const out: RithmicProduct[] = [];
  const seen = new Set<string>();
  for (const part of (raw ?? "").split(/[\s,]+/)) {
    const [product, exchange] = part.split(":").map((s) => s.trim().toUpperCase());
    if (!product || !exchange) continue;
    const key = `${product}:${exchange}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ product, exchange });
  }
  return out;
}

export function getRithmicConfig(
  env: Record<string, string | undefined> = import.meta.env,
  now: Date = new Date(),
): RithmicConfig {
  const listed = parseProducts(env.VITE_RITHMIC_PRODUCTS);
  const overrides = parseContracts(env.VITE_RITHMIC_CONTRACTS);
  const products = (listed.length > 0 ? listed : DEFAULT_PRODUCTS).map((p) => withManualContract(p, overrides, now));
  return {
    gateway: env.VITE_RITHMIC_GATEWAY?.trim() || RITHMIC_TEST_GATEWAY,
    appName: env.VITE_RITHMIC_APP_NAME?.trim() || "OpenCharts",
    appVersion: env.VITE_RITHMIC_APP_VERSION?.trim() || "0.3.0",
    templateVersion: "3.9",
    products,
  };
}
