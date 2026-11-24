import { UserRejectedRequestError } from "viem";
import { describe, expect, it } from "vitest";

import {
  atomicStatusOf,
  classifyBatchError,
  connectFlow,
  CONNECT_AND_SWITCH,
  decideSeatPath,
  initialPlayRun,
  planSeat,
  playReducer,
  progressOf,
  resumeStep,
  type PlayEvent,
  type SeatTarget,
  seatSituation,
} from "./playNow";
import { DEFAULT_PLAYERS, DEFAULT_STAKE } from "./stakes";

const JOIN: SeatTarget = { kind: "join", tableId: 7n, viaBot: false };
const CREATE: SeatTarget = { kind: "create", stake: DEFAULT_STAKE, players: DEFAULT_PLAYERS };

describe("planSeat (only the steps still needed, in order)", () => {
  const kinds = (input: Parameters<typeof planSeat>[0]) => {
    const plan = planSeat(input);
    return plan.ok ? plan.calls.map((c) => c.kind) : plan.reason;
  };

  it.each([
    [false, false, false, JOIN, ["faucet", "authorize", "join"]],
    [false, false, true, JOIN, ["faucet", "join"]],
    [true, false, false, JOIN, ["authorize", "join"]],
    [true, false, true, JOIN, ["join"]],
    [false, false, false, CREATE, ["faucet", "authorize", "create"]],
    [true, true, false, CREATE, ["authorize", "create"]], // claimed: the cooldown does not matter
    [true, false, true, CREATE, ["create"]],
  ] as const)(
    "claimed=%s cooldown=%s operatorValid=%s %o -> %o",
    (claimed, inCooldown, operatorValid, target, expected) => {
      expect(kinds({ claimed, inCooldown, operatorValid, target })).toEqual(expected);
    },
  );

  it("refuses to seat a player with no chips while the faucet cools down", () => {
    expect(planSeat({ claimed: false, inCooldown: true, operatorValid: true, target: JOIN })).toEqual({
      ok: false,
      reason: "noChips",
    });
  });

  it("carries the target and the steps the batch covers", () => {
    const plan = planSeat({ claimed: false, inCooldown: false, operatorValid: false, target: CREATE });
    expect(plan.ok && plan.calls.at(-1)).toEqual({ kind: "create", stake: 60_000_000n, players: 2 });
    expect(plan.ok && plan.steps).toEqual(["claim", "authorize", "seat"]);
  });
});

describe("decideSeatPath (EIP-5792 capability)", () => {
  it.each([
    [3, "supported", false, "batch"],
    [3, "ready", false, "batchWithUpgrade"],
    [3, "unsupported", false, "sequential"],
    [3, "missing", false, "sequential"],
    [3, "error", false, "sequential"],
    [2, "supported", true, "sequential"], // "Do it one by one"
    [1, "supported", false, "single"],
    [1, "unsupported", false, "single"],
  ] as const)("%i calls, atomic=%s, oneByOne=%s -> %s", (n, atomic, preferSequential, expected) => {
    expect(decideSeatPath(n, atomic, preferSequential)).toBe(expected);
  });

  it("reads atomic.status defensively", () => {
    expect(atomicStatusOf({ atomic: { status: "supported" } })).toBe("supported");
    expect(atomicStatusOf({ atomic: { status: "ready" } })).toBe("ready");
    expect(atomicStatusOf({ atomic: { status: "unsupported" } })).toBe("unsupported");
    expect(atomicStatusOf({ atomic: { status: "weird" } })).toBe("missing");
    expect(atomicStatusOf({})).toBe("missing");
    expect(atomicStatusOf(undefined)).toBe("missing");
  });
});

describe("classifyBatchError", () => {
  it("4001 is a rejection, also when wrapped or only named", () => {
    expect(classifyBatchError({ code: 4001 }, false)).toEqual({ kind: "rejected" });
    expect(classifyBatchError(new UserRejectedRequestError(new Error("no")), false)).toEqual({ kind: "rejected" });
    expect(classifyBatchError({ cause: { cause: { code: 4001 } } }, true)).toEqual({ kind: "rejected" });
  });

  it("anything else before submission falls back to one by one (e.g. Base's 5750, unsupported method)", () => {
    expect(classifyBatchError({ code: 5750, message: "upgrade rejected" }, false).kind).toBe("fallback");
    expect(classifyBatchError(new Error("Method not supported"), false)).toMatchObject({
      kind: "fallback",
      detail: "Error: Method not supported",
    });
  });

  it("after submission it is a failure with Try again", () => {
    expect(classifyBatchError(new Error("timed out"), true).kind).toBe("failed");
  });
});

describe("progress state machine", () => {
  const apply = (events: PlayEvent[]) => events.reduce(playReducer, initialPlayRun);

  it("shows skipped steps as done", () => {
    const progress = progressOf({ connect: true, network: true, claim: true, authorize: true }, initialPlayRun);
    expect(progress).toEqual({
      connect: "done",
      network: "done",
      claim: "done",
      authorize: "done",
      seat: "todo",
      sign: "todo",
    });
  });

  it("a batch marks several steps active at once", () => {
    const run = apply([{ type: "start" }, { type: "active", steps: ["claim", "authorize", "seat"], status: "x" }]);
    const p = progressOf({ connect: true, network: true }, run);
    expect([p.claim, p.authorize, p.seat, p.sign]).toEqual(["active", "active", "active", "todo"]);
  });

  it("a rejection stops at that step; Try again resumes there and never redoes finished steps", () => {
    const failed = apply([
      { type: "start" },
      { type: "active", steps: ["claim"], status: "x" },
      { type: "done", steps: ["claim"] },
      { type: "active", steps: ["authorize"], status: "y" },
      { type: "failed", step: "authorize", message: "cancelled" },
    ]);
    const done = { connect: true, network: true };
    expect(progressOf(done, failed).claim).toBe("done");
    expect(progressOf(done, failed).authorize).toBe("failed");
    expect(resumeStep(done, failed)).toBe("authorize");
    expect(failed.running).toBe(false);

    const resumed = playReducer(failed, { type: "start" });
    expect(resumed.failed).toBeNull();
    expect(resumed.completed).toEqual(["claim"]);
    expect(resumeStep(done, resumed)).toBe("authorize");
  });

  it("'Do it one by one' is remembered for the next run", () => {
    const run = apply([{ type: "failed", step: "seat", message: "no" }, { type: "oneByOne" }, { type: "start" }]);
    expect(run.preferSequential).toBe(true);
  });

  it("finished: nothing active, nothing to resume", () => {
    const all = { connect: true, network: true, claim: true, authorize: true, seat: true, sign: true };
    expect(resumeStep(all, apply([{ type: "finished" }]))).toBeNull();
  });
});

describe("connect + switch in one action", () => {
  const base = { connecting: false, switching: false, connected: false, onSepolia: false, error: null };
  it("walks pending -> switching -> ready, and maps 4001", () => {
    expect(connectFlow({ ...base, connecting: true })).toEqual({ kind: "pending", message: CONNECT_AND_SWITCH });
    expect(connectFlow({ ...base, connected: true, switching: true }).kind).toBe("switching");
    expect(connectFlow({ ...base, connected: true, onSepolia: true })).toEqual({ kind: "ready" });
    expect(connectFlow({ ...base, error: new UserRejectedRequestError(new Error("no")) }).kind).toBe("rejected");
    expect(connectFlow({ ...base, error: new Error("boom") })).toEqual({ kind: "idle" });
  });
});

describe("seatSituation (one address may sit at several tables)", () => {
  it("is atTarget only for the requested table", () => {
    expect(seatSituation([11n, 10n], 11n)).toEqual({ kind: "atTarget", tableId: 11n });
  });

  it("reports a seat at another table instead of pretending to join the requested one", () => {
    expect(seatSituation([10n], 11n)).toEqual({ kind: "elsewhere", tableId: 10n });
  });

  it("without a requested table, any active seat is 'elsewhere' (Play now never redirects silently)", () => {
    expect(seatSituation([10n], undefined)).toEqual({ kind: "elsewhere", tableId: 10n });
  });

  it("is free with no active seat", () => {
    expect(seatSituation([], 11n)).toEqual({ kind: "free" });
    expect(seatSituation([], undefined)).toEqual({ kind: "free" });
  });

  it("the seatedElsewhere stop is cleared by the next start", () => {
    const stopped = playReducer({ ...initialPlayRun, running: true }, { type: "seatedElsewhere", tableId: 10n });
    expect(stopped).toMatchObject({ running: false, seatedElsewhere: 10n });
    expect(playReducer(stopped, { type: "start" }).seatedElsewhere).toBeNull();
  });
});
