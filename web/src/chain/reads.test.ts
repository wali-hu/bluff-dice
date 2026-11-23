import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { PublicClient } from "viem";
import { afterEach, describe, expect, it } from "vitest";

import { isLagError, NO_SEAT, Phase, readBlockNumber, withLagRetry } from "./reads";
import { getPinnedBlock, pinReadsTo, resetPinnedBlockForTests } from "./readPin";

const source = readFileSync(fileURLToPath(new URL("../../../contracts/BluffDice.sol", import.meta.url)), "utf8");

describe("Phase", () => {
  it("matches enum Phase in BluffDice.sol, in order", () => {
    const body = /enum Phase \{([^}]+)\}/.exec(source)?.[1] ?? "";
    const names = body
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    expect(names).toEqual(Object.keys(Phase));
    names.forEach((name, i) => expect(Phase[name as keyof typeof Phase]).toBe(i));
  });

  it("NO_SEAT matches the contract", () => {
    expect(source).toContain("NO_SEAT = type(uint8).max");
    expect(NO_SEAT).toBe(255);
  });
});

describe("RPC lag", () => {
  it("recognises lag errors", () => {
    expect(isLagError(new Error("header not found"))).toBe(true);
    expect(isLagError(new Error("block range extends beyond current head block"))).toBe(true);
    expect(isLagError(new Error("pruned history unavailable"))).toBe(true);
    expect(isLagError(new Error("execution reverted"))).toBe(false);
  });

  it("retries lag errors, then succeeds", async () => {
    let calls = 0;
    const value = await withLagRetry(async () => {
      calls++;
      if (calls < 3) throw new Error("header not found");
      return "ok";
    }, [0, 0, 0]);
    expect(value).toBe("ok");
    expect(calls).toBe(3);
  });

  it("does not retry other errors", async () => {
    let calls = 0;
    await expect(
      withLagRetry(async () => {
        calls++;
        throw new Error("execution reverted");
      }, [0, 0]),
    ).rejects.toThrow("execution reverted");
    expect(calls).toBe(1);
  });

  it("gives up after the last delay", async () => {
    await expect(withLagRetry(() => Promise.reject(new Error("unknown block")), [0])).rejects.toThrow("unknown block");
  });
});

describe("read pinning", () => {
  afterEach(() => resetPinnedBlockForTests());
  const client = (head: bigint) => ({ getBlockNumber: async () => head }) as unknown as PublicClient;

  it("reads latest when nothing is pinned", async () => {
    expect(await readBlockNumber(client(100n))).toBeUndefined();
  });

  it("reads at max(head, pinned block)", async () => {
    pinReadsTo(105n);
    expect(await readBlockNumber(client(100n))).toBe(105n);
    expect(await readBlockNumber(client(110n))).toBe(110n);
  });

  it("the pin never moves backwards", () => {
    pinReadsTo(10n);
    pinReadsTo(5n);
    expect(getPinnedBlock()).toBe(10n);
  });
});
