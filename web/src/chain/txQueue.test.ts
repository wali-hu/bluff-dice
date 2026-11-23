import { describe, expect, it } from "vitest";

import type { TxError } from "@/lib/errors";

import {
  allowsBackToBackWrites,
  busyReason,
  gasWithMargin,
  initialTxState,
  isBusy,
  isEip7702Delegated,
  txReducer,
  type TxEvent,
  type TxState,
} from "./txQueue";

const HASH = `0x${"ab".repeat(32)}` as const;
const run = (events: TxEvent[], from: TxState = initialTxState) => events.reduce(txReducer, from);
const err = (kind: TxError["kind"]): TxError =>
  kind === "unknown" ? { kind, message: "m", detail: "d" } : ({ kind, message: "m" } as TxError);

describe("txReducer", () => {
  it("walks the happy path", () => {
    const steps: TxEvent[] = [
      { type: "start", label: "Join table" },
      { type: "simulated" },
      { type: "estimated", gas: 100n },
      { type: "submitted", hash: HASH },
      { type: "mined", blockNumber: 42n, success: true },
    ];
    const statuses = steps.map((_, i) => run(steps.slice(0, i + 1)).status);
    expect(statuses).toEqual(["simulating", "estimating", "awaitingWallet", "pending", "confirmed"]);
    expect(run(steps)).toMatchObject({ status: "confirmed", hash: HASH, blockNumber: 42n });
  });

  it("is a mutex: a second start while busy is ignored", () => {
    const busy = run([{ type: "start", label: "A" }, { type: "simulated" }]);
    expect(isBusy(busy)).toBe(true);
    expect(txReducer(busy, { type: "start", label: "B" })).toBe(busy);
    expect(busyReason(busy)).toContain('"A"');
  });

  it("allows a new write after a terminal state", () => {
    const done = run([
      { type: "start", label: "A" },
      { type: "simulated" },
      { type: "estimated", gas: 1n },
      { type: "submitted", hash: HASH },
      { type: "mined", blockNumber: 1n, success: true },
    ]);
    expect(isBusy(done)).toBe(false);
    expect(txReducer(done, { type: "start", label: "B" })).toEqual({ status: "simulating", label: "B" });
  });

  it("user rejection returns to idle", () => {
    const state = run([{ type: "start", label: "A" }, { type: "simulated" }, { type: "estimated", gas: 1n }]);
    expect(txReducer(state, { type: "failed", error: err("rejected") })).toEqual({ status: "idle" });
  });

  it("EIP-7702 in-flight limit -> blocked, which holds the mutex until reset", () => {
    const blocked = run([
      { type: "start", label: "A" },
      { type: "simulated" },
      { type: "estimated", gas: 1n },
      { type: "failed", error: err("inFlightLimit") },
    ]);
    expect(blocked.status).toBe("blocked");
    expect(isBusy(blocked)).toBe(true);
    expect(txReducer(blocked, { type: "start", label: "B" })).toBe(blocked);
    expect(txReducer(blocked, { type: "reset" })).toEqual({ status: "idle" });
  });

  it("a contract error during simulation -> reverted with the decoded error", () => {
    const error = err("contract");
    const state = run([
      { type: "start", label: "A" },
      { type: "failed", error },
    ]);
    expect(state).toEqual({ status: "reverted", label: "A", hash: undefined, error });
  });

  it("a mined revert keeps the hash", () => {
    const state = run([
      { type: "start", label: "A" },
      { type: "simulated" },
      { type: "estimated", gas: 1n },
      { type: "submitted", hash: HASH },
      { type: "mined", blockNumber: 9n, success: false },
    ]);
    expect(state).toMatchObject({ status: "reverted", hash: HASH, error: { kind: "revertedOnchain" } });
  });

  it("reset never cancels a running write", () => {
    const pending = run([
      { type: "start", label: "A" },
      { type: "simulated" },
      { type: "estimated", gas: 1n },
      { type: "submitted", hash: HASH },
    ]);
    expect(txReducer(pending, { type: "reset" })).toBe(pending);
  });

  it("ignores out-of-order events", () => {
    expect(txReducer(initialTxState, { type: "submitted", hash: HASH })).toBe(initialTxState);
    expect(txReducer(initialTxState, { type: "failed", error: err("unknown") })).toBe(initialTxState);
  });
});

describe("gas rule", () => {
  it("adds 20% and rounds up", () => {
    expect(gasWithMargin(100n)).toBe(120n);
    expect(gasWithMargin(101n)).toBe(122n);
    expect(gasWithMargin(4_642_991n)).toBe(5_571_590n);
  });

  it("never clamps to 2^24 (Glamsterdam state gas)", () => {
    expect(gasWithMargin(27_126_267n)).toBe(32_551_521n);
    expect(gasWithMargin(16_777_216n)).toBeGreaterThan(16_777_216n);
  });

  it("rejects a non-positive estimate", () => {
    expect(() => gasWithMargin(0n)).toThrow();
  });
});

describe("EIP-7702 rule", () => {
  const delegated = `0xef0100${"12".repeat(20)}` as const;

  it("detects the delegation designator", () => {
    expect(isEip7702Delegated(delegated)).toBe(true);
    expect(isEip7702Delegated(delegated.toUpperCase().replace("0XEF", "0xef") as `0x${string}`)).toBe(true);
    expect(isEip7702Delegated("0x")).toBe(false);
    expect(isEip7702Delegated(undefined)).toBe(false);
    expect(isEip7702Delegated(`0xef0100${"12".repeat(19)}`)).toBe(false);
    expect(isEip7702Delegated("0x6080604052")).toBe(false);
  });

  it("allows back-to-back writes only for plain EOAs", () => {
    expect(allowsBackToBackWrites("0x")).toBe(true);
    expect(allowsBackToBackWrites(undefined)).toBe(true);
    expect(allowsBackToBackWrites(delegated)).toBe(false);
    expect(allowsBackToBackWrites("0x6080604052")).toBe(false);
  });
});
