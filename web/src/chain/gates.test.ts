import { describe, expect, it } from "vitest";

import { SEPOLIA_CHAIN_ID } from "@/contracts/addresses";

import { gateStatus, MIN_ETH_WEI, type GateInput } from "./gates";

const ready: GateInput = {
  mounted: true,
  hasWallet: true,
  connection: "connected",
  chainId: SEPOLIA_CHAIN_ID,
  balanceWei: MIN_ETH_WEI,
};

describe("gateStatus", () => {
  it("is 'checking' before mount and while reconnecting (no flash of the wrong banner)", () => {
    expect(gateStatus({ ...ready, mounted: false })).toBe("checking");
    expect(gateStatus({ ...ready, connection: "reconnecting" })).toBe("checking");
  });

  it("orders the problems the way a player fixes them", () => {
    expect(gateStatus({ ...ready, connection: "disconnected", hasWallet: false })).toBe("noWallet");
    expect(gateStatus({ ...ready, connection: "disconnected" })).toBe("disconnected");
    expect(gateStatus({ ...ready, chainId: 1, balanceWei: 0n })).toBe("wrongChain");
    expect(gateStatus({ ...ready, balanceWei: 0n })).toBe("noEth");
    expect(gateStatus({ ...ready, balanceWei: MIN_ETH_WEI - 1n })).toBe("lowEth");
    expect(gateStatus(ready)).toBe("ready");
  });

  it("waits for the balance before deciding", () => {
    expect(gateStatus({ ...ready, balanceWei: undefined })).toBe("checking");
  });
});
