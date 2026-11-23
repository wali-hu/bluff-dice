/** Test doubles for the relayer SDK module (no network, no WASM). Used by unit tests only. */
import type { Hex } from "viem";

import type { RelayerSdkModule } from "./loader";

export const FAKE_PUBLIC_KEY = "a1".repeat(40);
export const FAKE_PRIVATE_KEY = "b2".repeat(40);

export interface FakeCalls {
  initSDK: unknown[];
  createInstance: Record<string, unknown>[];
  userDecrypt: unknown[][];
  publicDecrypt: unknown[][];
}

export function fakeSdk(
  overrides: {
    userDecrypt?: (...args: unknown[]) => Promise<Record<string, bigint | boolean>>;
    publicDecrypt?: (handles: string[]) => Promise<{
      clearValues: Record<string, bigint | boolean>;
      abiEncodedClearValues: Hex;
      decryptionProof: Hex;
    }>;
  } = {},
): { sdk: RelayerSdkModule; calls: FakeCalls } {
  const calls: FakeCalls = { initSDK: [], createInstance: [], userDecrypt: [], publicDecrypt: [] };
  const instance = {
    generateKeypair: () => ({ publicKey: FAKE_PUBLIC_KEY, privateKey: FAKE_PRIVATE_KEY }),
    createEIP712: (publicKey: string, contractAddresses: string[], startTimestamp: number, durationDays: number) => ({
      types: {
        EIP712Domain: [
          { name: "name", type: "string" },
          { name: "version", type: "string" },
          { name: "chainId", type: "uint256" },
          { name: "verifyingContract", type: "address" },
        ],
        UserDecryptRequestVerification: [
          { name: "publicKey", type: "bytes" },
          { name: "contractAddresses", type: "address[]" },
          { name: "startTimestamp", type: "uint256" },
          { name: "durationDays", type: "uint256" },
          { name: "extraData", type: "bytes" },
        ],
      },
      primaryType: "UserDecryptRequestVerification",
      domain: {
        name: "Decryption",
        version: "1",
        chainId: 11155111n,
        verifyingContract: "0x5D8BD78e2ea6bbE41f26dFe9fdaEAa349e077478",
      },
      message: {
        publicKey: `0x${publicKey}`,
        contractAddresses,
        startTimestamp: String(startTimestamp),
        durationDays: String(durationDays),
        extraData: "0x00",
      },
    }),
    userDecrypt: async (...args: unknown[]) => {
      calls.userDecrypt.push(args);
      return overrides.userDecrypt ? overrides.userDecrypt(...args) : {};
    },
    publicDecrypt: async (handles: string[], ...rest: unknown[]) => {
      calls.publicDecrypt.push([handles, ...rest]);
      if (!overrides.publicDecrypt) throw new Error("no publicDecrypt fake");
      return overrides.publicDecrypt(handles);
    },
  };
  const sdk = {
    initSDK: async (params: unknown) => {
      calls.initSDK.push(params);
      return true;
    },
    createInstance: async (config: Record<string, unknown>) => {
      calls.createInstance.push(config);
      return instance;
    },
    SepoliaConfig: { relayerUrl: "https://relayer.testnet.zama.org", chainId: 11155111 },
  } as unknown as RelayerSdkModule;
  return { sdk, calls };
}

/** fetchAsset double: returns bytes tagged with the asset URL (the real one checks sha256). */
export async function fakeFetchAsset(asset: { url: string }): Promise<Uint8Array> {
  return new TextEncoder().encode(asset.url);
}
