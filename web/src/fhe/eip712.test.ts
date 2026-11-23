import { describe, expect, it } from "vitest";

import { BLUFF_CHIPS_ADDRESS, BLUFF_DICE_ADDRESS } from "@/contracts/addresses";

import { toWalletTypedData, type SdkUserDecryptEip712 } from "./eip712";
import { fakeSdk } from "./testing";

async function sdkEip(contracts: string[] = [BLUFF_DICE_ADDRESS, BLUFF_CHIPS_ADDRESS], days = 1) {
  const { sdk } = fakeSdk();
  const instance = await sdk.createInstance({} as never);
  return instance.createEIP712("ab".repeat(40), contracts, 1_764_000_000, days) as unknown as SdkUserDecryptEip712;
}

describe("toWalletTypedData", () => {
  it("removes EIP712Domain and converts uint256 strings to bigint", async () => {
    const out = toWalletTypedData(await sdkEip());
    expect(Object.keys(out.types)).toEqual(["UserDecryptRequestVerification"]);
    expect(out.message.startTimestamp).toBe(1_764_000_000n);
    expect(out.message.durationDays).toBe(1n);
    expect(out.domain.chainId).toBe(11155111);
    expect(out.message.contractAddresses).toEqual([BLUFF_DICE_ADDRESS, BLUFF_CHIPS_ADDRESS]);
    expect(out.message.publicKey.startsWith("0x")).toBe(true);
    expect(out.message.extraData).toBe("0x00");
  });

  it("refuses the wrong contract order", async () => {
    expect(() => toWalletTypedData(sdkEipSync([BLUFF_CHIPS_ADDRESS, BLUFF_DICE_ADDRESS]))).toThrow(
      /BluffDice, BluffChips/,
    );
  });

  it("refuses another duration or chain", async () => {
    const eip = await sdkEip();
    expect(() => toWalletTypedData({ ...eip, message: { ...eip.message, durationDays: "2" } })).toThrow(/1 day/);
    expect(() => toWalletTypedData({ ...eip, domain: { ...eip.domain, chainId: 1n } })).toThrow(/not Sepolia/);
  });
});

function sdkEipSync(contracts: string[]): SdkUserDecryptEip712 {
  return {
    types: { UserDecryptRequestVerification: [] },
    primaryType: "UserDecryptRequestVerification",
    domain: { name: "Decryption", version: "1", chainId: 11155111n, verifyingContract: "0x00" },
    message: {
      publicKey: "0x",
      contractAddresses: contracts,
      startTimestamp: "1",
      durationDays: "1",
      extraData: "0x00",
    },
  };
}
