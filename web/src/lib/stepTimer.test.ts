import { describe, expect, it } from "vitest";

import { createStepTimer } from "./stepTimer";

describe("step timer", () => {
  it("records ms per step, the total to seated and prompt counts", () => {
    let t = 1_000;
    const timer = createStepTimer(() => t);
    timer.enter("connect");
    timer.prompt("connect");
    t += 4_000;
    timer.enter("claim");
    timer.enter("claim"); // repeat is a no-op
    timer.prompt("transaction");
    t += 15_000;
    timer.enter("authorize");
    timer.prompt("transaction");
    t += 12_000;
    timer.enter("join");
    timer.prompt("transaction");
    timer.prompt("signature");
    t += 20_000;
    timer.seated();
    timer.prompt("signature"); // the unlock signature after the seat still counts (K)
    timer.finish();
    timer.prompt("transaction"); // after finish: ignored
    const snap = timer.snapshot();
    expect(snap.steps).toEqual([
      { step: "connect", ms: 4_000 },
      { step: "claim", ms: 15_000 },
      { step: "authorize", ms: 12_000 },
      { step: "join", ms: 20_000 },
    ]);
    expect(timer.totalMs()).toBe(51_000);
    expect(timer.snapshot().prompts).toEqual({ connect: 1, switchNetwork: 0, transaction: 3, signature: 2 });
  });

  it("does not stop before it started, and notifies subscribers", () => {
    const timer = createStepTimer(() => 0);
    let calls = 0;
    timer.subscribe(() => calls++);
    timer.seated();
    expect(timer.totalMs()).toBeNull();
    timer.enter("connect");
    timer.note("x");
    timer.note("x");
    expect(calls).toBe(2);
    expect(timer.snapshot().notes).toEqual(["x"]);
  });
});
