import { describe, expect, it } from "vitest";

import { SEPOLIA_CHAIN_ID } from "@/contracts/addresses";

import { balanceTooLow, currentStep, hasChips, nextFaucetAt, operatorReady, type OnboardingReads } from "./onboarding";

const ZERO_HANDLE = `0x${"00".repeat(32)}` as const;
const FUNDED = `0x${"12".repeat(32)}` as const;
const NOW = 1_764_000_000n;
const ready: OnboardingReads = {
  connected: true,
  chainId: SEPOLIA_CHAIN_ID,
  lastFaucet: NOW - 100n,
  balanceHandle: FUNDED,
  isOperator: true,
  operatorUntil: NOW + 500n,
  nowSeconds: NOW,
};

describe("onboarding steps (each skipped when already satisfied)", () => {
  it("walks connect -> network -> claim -> authorize -> join", () => {
    expect(currentStep({ ...ready, connected: false })).toBe("connect");
    expect(currentStep({ ...ready, chainId: 1 })).toBe("network");
    expect(currentStep({ ...ready, lastFaucet: 0n, balanceHandle: ZERO_HANDLE })).toBe("claim");
    expect(currentStep({ ...ready, isOperator: false, operatorUntil: undefined })).toBe("authorize");
    expect(currentStep(ready)).toBe("join");
  });

  it("waits for the reads before choosing", () => {
    expect(currentStep({ ...ready, lastFaucet: undefined })).toBe("loading");
    expect(currentStep({ ...ready, isOperator: undefined })).toBe("loading");
  });

  it("claim is done by a past claim OR a funded balance handle (owner-minted wallets)", () => {
    expect(hasChips({ lastFaucet: 0n, balanceHandle: FUNDED })).toBe(true);
    expect(hasChips({ lastFaucet: 5n, balanceHandle: ZERO_HANDLE })).toBe(true);
    expect(hasChips({ lastFaucet: 0n, balanceHandle: ZERO_HANDLE })).toBe(false);
  });

  it("authorize needs isOperator AND a recent grant with >= 120 s left", () => {
    expect(operatorReady({ isOperator: true, operatorUntil: NOW + 120n, nowSeconds: NOW })).toBe(true);
    expect(operatorReady({ isOperator: true, operatorUntil: NOW + 119n, nowSeconds: NOW })).toBe(false);
    expect(operatorReady({ isOperator: true, operatorUntil: undefined, nowSeconds: NOW })).toBe(false);
    expect(operatorReady({ isOperator: false, operatorUntil: NOW + 600n, nowSeconds: NOW })).toBe(false);
  });

  it("faucet cooldown and low balance", () => {
    expect(nextFaucetAt(0n, NOW)).toBeUndefined();
    expect(nextFaucetAt(NOW - 100n, NOW)).toBe(NOW - 100n + 86_400n);
    expect(nextFaucetAt(NOW - 90_000n, NOW)).toBeUndefined();
    expect(balanceTooLow(59_999_999n, 60_000_000n)).toBe(true);
    expect(balanceTooLow(60_000_000n, 60_000_000n)).toBe(false);
    expect(balanceTooLow(undefined, 60_000_000n)).toBe(false);
  });
});
