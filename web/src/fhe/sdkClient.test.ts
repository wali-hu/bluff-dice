import type { Hex } from "viem";
import { describe, expect, it } from "vitest";

import { BLUFF_CHIPS_ADDRESS, BLUFF_DICE_ADDRESS } from "@/contracts/addresses";

import { FHE_ASSETS } from "./assets";
import { createSdkClient, ZERO_HANDLE } from "./sdkClient";
import { fakeFetchAsset, fakeSdk } from "./testing";

const H1 = `0x${"AB".repeat(32)}` as Hex;
const H2 = `0x${"cd".repeat(32)}` as Hex;
const ABI_ENCODED = `0x${"00".repeat(31)}03${"00".repeat(31)}05` as Hex;
const PROOF = `0x07${"11".repeat(65 * 7)}` as Hex;

function make(overrides: Parameters<typeof fakeSdk>[0] = {}) {
  const { sdk, calls } = fakeSdk(overrides);
  let loads = 0;
  const fhe = createSdkClient({
    rpcUrl: "https://rpc.example",
    loadSdk: async () => {
      loads++;
      return sdk;
    },
    fetchAsset: fakeFetchAsset,
  });
  return { fhe, calls, loads: () => loads };
}

describe("init", () => {
  it("passes the self-hosted WASM, key and CRS in the shapes createInstance expects, with an RPC URL", async () => {
    const { fhe, calls } = make();
    await fhe.init();
    const enc = (s: string) => new TextEncoder().encode(s);
    expect(calls.initSDK[0]).toEqual({
      tfheParams: enc(FHE_ASSETS.tfheWasm.url),
      kmsParams: enc(FHE_ASSETS.kmsWasm.url),
      thread: 0,
    });
    const config = calls.createInstance[0] ?? {};
    expect(config.network).toBe("https://rpc.example");
    expect(config.publicKey).toEqual({ data: enc(FHE_ASSETS.publicKey.url), id: FHE_ASSETS.publicKey.id });
    expect(config.publicParams).toEqual({
      2048: { publicParams: enc(FHE_ASSETS.crs2048.url), publicParamsId: FHE_ASSETS.crs2048.id },
    });
  });

  it("is idempotent (one cached instance)", async () => {
    const { fhe, calls, loads } = make();
    await Promise.all([fhe.init(), fhe.init()]);
    await fhe.init();
    expect(loads()).toBe(1);
    expect(calls.createInstance).toHaveLength(1);
  });
});

describe("publicDecrypt", () => {
  it("returns cleartexts and proof byte for byte, values as bigint keyed by the input handle", async () => {
    const { fhe, calls } = make({
      publicDecrypt: async () => ({
        clearValues: { [H1.toLowerCase()]: 3n, [H2]: true },
        abiEncodedClearValues: ABI_ENCODED,
        decryptionProof: PROOF,
      }),
    });
    const out = await fhe.publicDecrypt([H1, H2]);
    expect(out.abiEncoded).toBe(ABI_ENCODED);
    expect(out.proof).toBe(PROOF);
    expect(out.clear.get(H1)).toBe(3n);
    expect(out.clear.get(H2)).toBe(1n);
    expect(calls.publicDecrypt[0]?.[0]).toEqual([H1, H2]);
    const options = calls.publicDecrypt[0]?.[1] as { signal?: AbortSignal; onProgress?: unknown };
    expect(options.signal).toBeInstanceOf(AbortSignal);
    expect(typeof options.onProgress).toBe("function");
  });
});

describe("userDecrypt", () => {
  it("skips zero handles without calling the SDK (even when locked)", async () => {
    const { fhe, calls } = make();
    const out = await fhe.userDecrypt([{ handle: ZERO_HANDLE, contract: BLUFF_CHIPS_ADDRESS }]);
    expect(out.size).toBe(0);
    expect(calls.userDecrypt).toHaveLength(0);
  });

  it("needs an unlocked session for real handles", async () => {
    const { fhe } = make();
    await expect(fhe.userDecrypt([{ handle: H1, contract: BLUFF_DICE_ADDRESS }])).rejects.toMatchObject({
      kind: "locked",
    });
  });
});
