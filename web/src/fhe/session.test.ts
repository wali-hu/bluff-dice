// @vitest-environment jsdom
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BLUFF_CHIPS_ADDRESS, BLUFF_DICE_ADDRESS } from "@/contracts/addresses";

import type { TypedDataSigner } from "./client";
import { containsSecret } from "./safeLog";
import { createSdkClient } from "./sdkClient";
import { currentSession, installAutoLock, lock, unlockedUser } from "./session";
import { FAKE_PRIVATE_KEY, fakeFetchAsset, fakeSdk } from "./testing";

// A throwaway key generated per run (no key material in the repository).
const account = privateKeyToAccount(generatePrivateKey());
let signedWith: Parameters<TypedDataSigner>[0] | undefined;
const sign: TypedDataSigner = (typedData) => {
  signedWith = typedData;
  return account.signTypedData(typedData as never);
};

let indexedDbTouched = false;

beforeEach(() => {
  lock();
  localStorage.clear();
  sessionStorage.clear();
  indexedDbTouched = false;
  Object.defineProperty(globalThis, "indexedDB", {
    configurable: true,
    get() {
      indexedDbTouched = true;
      return undefined;
    },
  });
});

afterEach(() => vi.restoreAllMocks());

function client() {
  const { sdk, calls } = fakeSdk({ userDecrypt: async () => ({}) });
  return {
    fhe: createSdkClient({ rpcUrl: "https://rpc.example", loadSdk: async () => sdk, fetchAsset: fakeFetchAsset }),
    calls,
  };
}

describe("session (memory only)", () => {
  it("unlock keeps keypair + signature out of every browser storage", async () => {
    const setLocal = vi.spyOn(Storage.prototype, "setItem");
    const { fhe } = client();
    await fhe.unlock(account.address, sign, { walletChainId: 11155111 });

    expect(unlockedUser()).toBe(account.address);
    expect(setLocal).not.toHaveBeenCalled();
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
    expect(indexedDbTouched).toBe(false);
    expect(document.cookie).toBe("");
    expect(window.location.href).not.toContain(FAKE_PRIVATE_KEY);
  });

  it("signs the exact permit: [BluffDice, BluffChips], 1 day, no EIP712Domain", async () => {
    const { fhe } = client();
    await fhe.unlock(account.address, sign, { walletChainId: 11155111 });
    expect(signedWith?.message.contractAddresses).toEqual([BLUFF_DICE_ADDRESS, BLUFF_CHIPS_ADDRESS]);
    expect(signedWith?.message.durationDays).toBe(1n);
    expect(Object.keys(signedWith?.types ?? {})).toEqual(["UserDecryptRequestVerification"]);
  });

  it("lock() clears the session and the secret guard", async () => {
    const { fhe } = client();
    await fhe.unlock(account.address, sign, { walletChainId: 11155111 });
    const signature = currentSession()?.signature ?? "";
    expect(containsSecret(`x ${signature} y`)).toBe(true);
    fhe.lock();
    expect(currentSession()).toBeNull();
    expect(unlockedUser()).toBeNull();
    expect(containsSecret(`x ${signature} y`)).toBe(false);
    await expect(
      fhe.userDecrypt([{ handle: `0x${"11".repeat(32)}`, contract: BLUFF_CHIPS_ADDRESS }]),
    ).rejects.toMatchObject({
      kind: "locked",
    });
  });

  it("pagehide locks", async () => {
    const target = new EventTarget();
    installAutoLock(target as unknown as Window);
    const { fhe } = client();
    await fhe.unlock(account.address, sign, { walletChainId: 11155111 });
    target.dispatchEvent(new Event("pagehide"));
    expect(currentSession()).toBeNull();
  });

  it("refuses to ask for a signature on another chain", async () => {
    const { fhe } = client();
    const spy = vi.fn(sign);
    await expect(fhe.unlock(account.address, spy, { walletChainId: 1 })).rejects.toMatchObject({ kind: "wrongChain" });
    expect(spy).not.toHaveBeenCalled();
  });

  it("rejects a signature from another address", async () => {
    const { fhe } = client();
    const other = privateKeyToAccount(generatePrivateKey());
    await expect(
      fhe.unlock(account.address, (td) => other.signTypedData(td as never), { walletChainId: 11155111 }),
    ).rejects.toMatchObject({ kind: "badSignature" });
    expect(currentSession()).toBeNull();
  });

  it("expires after 1 day", async () => {
    const { fhe } = client();
    await fhe.unlock(account.address, sign, { walletChainId: 11155111 });
    const start = currentSession()?.startTimestamp ?? 0;
    expect(currentSession(start + 86_399)).not.toBeNull();
    expect(currentSession(start + 86_400)).toBeNull();
  });
});
