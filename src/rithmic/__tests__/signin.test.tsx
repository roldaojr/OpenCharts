import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { safeStorage } from "../../lib/safe-storage.ts";
import { RITHMIC_GATEWAYS } from "../config.ts";

const TEST_GATEWAY = RITHMIC_GATEWAYS.find((g) => g.name === "Test")!.url;
const CHICAGO = RITHMIC_GATEWAYS.find((g) => g.name === "Chicago")!.url;

// The Test gateway serves only "Rithmic Test"; the others also Paper Trading.
const listRithmicSystems = vi.fn(async (url: string) =>
  url === TEST_GATEWAY ? ["Rithmic Test"] : ["Rithmic 01", "Rithmic Paper Trading"],
);
vi.mock("../connection.ts", async (orig) => ({
  ...(await orig<typeof import("../connection.ts")>()),
  listRithmicSystems: (url: string) => listRithmicSystems(url),
}));

// Pin the build-time defaults so the local .env does not leak into the test.
vi.mock("../config.ts", async (orig) => {
  const real = await orig<typeof import("../config.ts")>();
  return {
    ...real,
    getRithmicConfig: () => real.getRithmicConfig({ VITE_RITHMIC_SYSTEM_NAME: "Rithmic Paper Trading" }),
  };
});

const { default: RithmicApp } = await import("../ui/RithmicApp.tsx");

const gatewaySelect = () => screen.getAllByRole("combobox")[0] as HTMLSelectElement;
const systemSelect = () => screen.getAllByRole("combobox")[1] as HTMLSelectElement;

describe("Rithmic sign-in gateway list", () => {
  beforeEach(() => {
    listRithmicSystems.mockClear();
    safeStorage.removeItem("rithmic:signin");
  });
  afterEach(() => {
    cleanup();
    safeStorage.removeItem("rithmic:signin");
  });

  it("offers the published gateways with Chicago and the configured system selected", async () => {
    render(<RithmicApp />);
    const select = gatewaySelect();
    expect(select.options).toHaveLength(RITHMIC_GATEWAYS.length);
    expect([...select.options].map((o) => o.text)).toContain("Sao Paulo");
    expect(select.value).toBe(CHICAGO);
    await waitFor(() => expect(listRithmicSystems).toHaveBeenCalledWith(CHICAGO));
    await waitFor(() => expect([...systemSelect().options].map((o) => o.text)).toEqual(["Rithmic 01", "Rithmic Paper Trading"]));
    expect(systemSelect().value).toBe("Rithmic Paper Trading");
  });

  it("reloads the system list when another gateway is picked", async () => {
    render(<RithmicApp />);
    await waitFor(() => expect(listRithmicSystems).toHaveBeenCalledTimes(1));
    await act(async () => {
      fireEvent.change(gatewaySelect(), { target: { value: TEST_GATEWAY } });
    });
    expect(gatewaySelect().value).toBe(TEST_GATEWAY);
    expect(listRithmicSystems).toHaveBeenLastCalledWith(TEST_GATEWAY);
    // No Paper Trading on Test: the first listed system is picked.
    await waitFor(() => expect(systemSelect().value).toBe("Rithmic Test"));

    await act(async () => {
      fireEvent.change(gatewaySelect(), { target: { value: CHICAGO } });
    });
    await waitFor(() => expect(systemSelect().value).toBe("Rithmic Paper Trading"));
  });

  it("keeps a remembered gateway outside the list as a Custom option", async () => {
    const custom = "wss://relay.example:8443";
    safeStorage.setItem("rithmic:signin", JSON.stringify({ gateway: custom, systemName: "X", user: "u" }));
    render(<RithmicApp />);
    const select = gatewaySelect();
    expect(select.options).toHaveLength(RITHMIC_GATEWAYS.length + 1);
    expect(select.options[0]!.text).toBe(`Custom (${custom})`);
    expect(select.value).toBe(custom);
    await waitFor(() => expect(listRithmicSystems).toHaveBeenCalledWith(custom));
  });
});
