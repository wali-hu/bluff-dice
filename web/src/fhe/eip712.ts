import type { Address, Hex } from "viem";

import { BLUFF_CHIPS_ADDRESS, BLUFF_DICE_ADDRESS, SEPOLIA_CHAIN_ID } from "@/contracts/addresses";

import { FheError } from "./errors";

/** Contracts of every permit, in this order (SPEC R2 + R3-6): game first, chip token second. */
export const PERMIT_CONTRACTS: readonly Address[] = [BLUFF_DICE_ADDRESS, BLUFF_CHIPS_ADDRESS];
/** Permit lifetime in days (the shortest the KMS accepts). */
export const PERMIT_DURATION_DAYS = 1;

/** Shape returned by 0.4.1 `instance.createEIP712` (installed web.d.ts `KmsUserDecryptEIP712Type`). */
export interface SdkUserDecryptEip712 {
  readonly types: {
    readonly EIP712Domain?: readonly { readonly name: string; readonly type: string }[];
    readonly UserDecryptRequestVerification: readonly { readonly name: string; readonly type: string }[];
  };
  readonly primaryType: "UserDecryptRequestVerification";
  readonly domain: {
    readonly name: string;
    readonly version: string;
    readonly chainId: bigint | number | string;
    readonly verifyingContract: string;
  };
  readonly message: {
    readonly publicKey: string;
    readonly contractAddresses: readonly string[];
    readonly startTimestamp: string;
    readonly durationDays: string;
    readonly extraData: string;
  };
}

/** The typed data handed to wagmi / viem `signTypedData`. */
export interface WalletTypedData {
  readonly domain: { name: string; version: string; chainId: number; verifyingContract: Address };
  readonly types: { UserDecryptRequestVerification: { name: string; type: string }[] };
  readonly primaryType: "UserDecryptRequestVerification";
  readonly message: {
    publicKey: Hex;
    contractAddresses: Address[];
    startTimestamp: bigint;
    durationDays: bigint;
    extraData: Hex;
  };
}

function sameAddresses(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((x, i) => x.toLowerCase() === (b[i] ?? "").toLowerCase());
}

function asHex(value: string): Hex {
  return (value.startsWith("0x") ? value : `0x${value}`) as Hex;
}

/**
 * Converts the SDK's EIP-712 to what the wallet signs: `EIP712Domain` removed from `types` (viem derives it from
 * the domain), uint256 string fields -> bigint, chainId -> number. Refuses anything but our exact permit: Sepolia,
 * contracts [BluffDice, BluffChips] in that order, 1 day.
 */
export function toWalletTypedData(eip: SdkUserDecryptEip712): WalletTypedData {
  const chainId = Number(eip.domain.chainId);
  if (chainId !== SEPOLIA_CHAIN_ID) throw new FheError("wrongChain", `Permit chainId ${chainId} is not Sepolia`);
  if (!sameAddresses(eip.message.contractAddresses, PERMIT_CONTRACTS)) {
    throw new FheError("unknown", "Permit contracts must be [BluffDice, BluffChips]");
  }
  const durationDays = BigInt(eip.message.durationDays);
  if (durationDays !== BigInt(PERMIT_DURATION_DAYS)) throw new FheError("unknown", "Permit must last exactly 1 day");
  return {
    domain: {
      name: eip.domain.name,
      version: eip.domain.version,
      chainId,
      verifyingContract: eip.domain.verifyingContract as Address,
    },
    types: { UserDecryptRequestVerification: eip.types.UserDecryptRequestVerification.map((f) => ({ ...f })) },
    primaryType: "UserDecryptRequestVerification",
    message: {
      publicKey: asHex(eip.message.publicKey),
      contractAddresses: eip.message.contractAddresses.map((a) => a as Address),
      startTimestamp: BigInt(eip.message.startTimestamp),
      durationDays,
      extraData: asHex(eip.message.extraData),
    },
  };
}
