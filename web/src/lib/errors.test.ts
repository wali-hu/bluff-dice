import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { encodeErrorResult, toFunctionSelector, UserRejectedRequestError } from "viem";
import { describe, expect, it } from "vitest";

import { BLUFF_DICE_ADDRESS } from "@/contracts/addresses";

import {
  combinedErrorsAbi,
  decodeRevertData,
  describeContractError,
  ERROR_MESSAGES,
  toTxError,
  type ContractErrorName,
  type DescribeContext,
} from "./errors";

const utc: DescribeContext = {
  formatTime: (s) =>
    new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: "UTC" }).format(
      new Date(Number(s) * 1000),
    ),
};

function zeroArgs(name: ContractErrorName): unknown[] {
  const item = combinedErrorsAbi.find((e) => e.name === name);
  return (item?.inputs ?? []).map((input) =>
    input.type.startsWith("uint") ? 1n : input.type === "address" ? BLUFF_DICE_ADDRESS : `0x${"00".repeat(32)}`,
  );
}

describe("error messages", () => {
  it("map every error of the combined ABI (fails when the ABI gains an unmapped error)", () => {
    const names = combinedErrorsAbi.map((e) => e.name);
    for (const name of names) expect(ERROR_MESSAGES, name).toHaveProperty(name);
    expect(Object.keys(ERROR_MESSAGES).sort()).toEqual([...names].sort());
  });

  it("give a non-empty message for every error with sample arguments", () => {
    for (const { name } of combinedErrorsAbi) {
      const result = describeContractError(name, zeroArgs(name), utc);
      expect(result.kind).toBe("contract");
      if (result.kind === "contract") expect(result.message.length, name).toBeGreaterThan(10);
    }
  });

  it("covers the expected sources", () => {
    const names = new Set(combinedErrorsAbi.map((e) => e.name));
    for (const name of [
      "WrongPhase",
      "FaucetCooldown",
      "ERC7984UnauthorizedSpender",
      "ReentrancyGuardReentrantCall",
      "KMSInvalidSigner",
      "UnsupportedExtraDataVersion",
    ]) {
      expect(names.has(name as ContractErrorName), name).toBe(true);
    }
  });

  it("keeps the Sepolia KMSVerifier v0.4.0 selector observed live (0x2139cc2c)", () => {
    expect(toFunctionSelector("UnsupportedExtraDataVersion(uint8)")).toBe("0x2139cc2c");
  });

  const ozSource = fileURLToPath(
    new URL("../../../node_modules/@openzeppelin/confidential-contracts/token/ERC7984/ERC7984.sol", import.meta.url),
  );
  it.skipIf(!existsSync(ozSource))("includes every error declared by the installed OZ ERC7984 0.5.3", () => {
    const declared = [...readFileSync(ozSource, "utf8").matchAll(/error (\w+)\(/g)].map((m) => m[1]);
    expect(declared.length).toBeGreaterThan(0);
    const names = new Set<string>(combinedErrorsAbi.map((e) => e.name));
    for (const name of declared) expect(names.has(name as string), name).toBe(true);
  });
});

describe("decoding", () => {
  it("FaucetCooldown -> next claim time", () => {
    const data = encodeErrorResult({ abi: combinedErrorsAbi, errorName: "FaucetCooldown", args: [1_764_000_120n] });
    const result = decodeRevertData(data, utc);
    expect(result).toMatchObject({ kind: "contract", name: "FaucetCooldown", silent: false });
    expect(result?.message).toBe("Next free chips at 16:02.");
  });

  it("WrongPhase is a silent refresh", () => {
    const data = encodeErrorResult({ abi: combinedErrorsAbi, errorName: "WrongPhase", args: [1n, 1, 2] });
    expect(decodeRevertData(data, utc)).toMatchObject({ name: "WrongPhase", silent: true });
  });

  it("BidNotHigher names the bid to beat", () => {
    const data = encodeErrorResult({ abi: combinedErrorsAbi, errorName: "BidNotHigher", args: [3, 5, 3, 4] });
    expect(decodeRevertData(data, utc)?.message).toContain("3 × 5");
  });

  it("unknown selectors return null", () => {
    expect(decodeRevertData("0xdeadbeef")).toBeNull();
  });
});

describe("toTxError", () => {
  it("user rejection", () => {
    expect(toTxError(new UserRejectedRequestError(new Error("User rejected the request.")))).toMatchObject({
      kind: "rejected",
    });
  });

  it("EIP-7702 in-flight limit", () => {
    expect(toTxError(new Error("in-flight transaction limit reached for delegated accounts"))).toMatchObject({
      kind: "inFlightLimit",
    });
  });

  it("insufficient funds", () => {
    expect(toTxError(new Error("insufficient funds for gas * price + value"))).toMatchObject({
      kind: "insufficientFunds",
    });
  });

  it("anything else", () => {
    expect(toTxError(new Error("socket hang up"))).toMatchObject({ kind: "unknown" });
  });
});
