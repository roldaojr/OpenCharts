import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { safeStorage } from "../../lib/safe-storage.ts";
import { RITHMIC_GATEWAYS, RITHMIC_TEST_GATEWAY } from "../config.ts";

const listRithmicSystems = vi.fn(async (_url: string) => ["Rithmic Test"]);
vi.mock("../connection.ts", async (orig) => ({
  ...(await orig<typeof import("../connection.ts")>()),
  listRithmicSystems: (url: string) => listRithmicSystems(url),
}));

const { default: RithmicApp } = await import("../ui/RithmicApp.tsx");

const gatewaySelect = () => screen.getAllByRole("combobox")[0] as HTMLSelectElement;

describe("Rithmic sign-in gateway list", () => {
  beforeEach(() => {
    listRithmicSystems.mockClear();
    safeStorage.removeItem("rithmic:signin");
  });
  afterEach(() => {
    cleanup();
    safeStorage.removeItem("rithmic:signin");
  });

  it("offers the published gateways with Test selected", async () => {
    render(<RithmicApp />);
    const select = gatewaySelect();
    expect(select.options).toHaveLength(RITHMIC_GATEWAYS.length);
    expect([...select.options].map((o) => o.text)).toContain("Sao Paulo");
    expect(select.value).toBe(RITHMIC_TEST_GATEWAY);
    await waitFor(() => expect(listRithmicSystems).toHaveBeenCalledWith(RITHMIC_TEST_GATEWAY));
  });

  it("reloads the system list when another gateway is picked", async () => {
    render(<RithmicApp />);
    await waitFor(() => expect(listRithmicSystems).toHaveBeenCalledTimes(1));
    const chicago = RITHMIC_GATEWAYS.find((g) => g.name === "Chicago")!.url;
    await act(async () => {
      fireEvent.change(gatewaySelect(), { target: { value: chicago } });
    });
    expect(gatewaySelect().value).toBe(chicago);
    expect(listRithmicSystems).toHaveBeenLastCalledWith(chicago);
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
