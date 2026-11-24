/**
 * Extra tests from the independent E5 review (spec-first VERIFY step 5). They sit ON TOP of the approved spec
 * tests (never in place of them) and pin the reviewer's findings that are fixed in code.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { renderToStaticMarkup } from "react-dom/server";
import type { Hex } from "viem";
import { describe, expect, it, vi } from "vitest";

import { NO_SEAT, Phase } from "@/chain/reads";
import { DeadlineRing } from "@/components/DeadlineRing";
import * as errors from "@/lib/errors";
import { ALICE } from "@/lib/fixtures";
import * as push from "@/lib/push";
import * as tableView from "@/lib/tableView";

/* eslint-disable @typescript-eslint/no-explicit-any */
const tv = tableView as any;
const er = errors as any;
const pu = push as any;
const H = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as Hex;
const ZERO_HANDLE = `0x${"0".repeat(64)}` as Hex;

describe("E5 review fixes", () => {
  it('RV-1 (E5-R10, SHOULD): the ring component shows the spec text "Time\'s up"', () => {
    const html = renderToStaticMarkup(<DeadlineRing phase={Phase.Bidding} deadline={1000n} nowSeconds={1000n} />);
    expect(html).toContain("Time&#x27;s up");
  });

  it("RV-2 (E5-R7, SHOULD): DeadlineNotPassed is soft (not a failure state)", () => {
    expect(er.describeContractError("DeadlineNotPassed", [1n, 1000n]).soft).toBe(true);
    expect(er.describeContractError("BidNotHigher", [3, 4, 3, 4]).soft).not.toBe(true);
  });

  it("RV-3 (E5-R16, SHOULD): the phase is re-read right before sending, after the KMS decrypt", async () => {
    const phases = [Phase.AwaitingPaidProof, Phase.Bidding];
    const d = {
      readPhase: vi.fn(async () => phases.shift() ?? Phase.Bidding),
      readHandles: vi.fn(async () => [H(1), H(2)]),
      publicDecrypt: vi.fn(async () => ({ abiEncoded: "0x01" as Hex, proof: "0x02" as Hex })),
      send: vi.fn(async () => ({ ok: true as const })),
    };
    const out = await pu.runPush({ kind: "deal", tableId: 1n, ...d });
    expect(d.readPhase).toHaveBeenCalledTimes(2);
    expect(d.send).not.toHaveBeenCalled();
    expect(out.result).toBe("alreadyPushed");
  });

  it("RV-4 (E5-R2, SHOULD): dice count as dealt only when all five handles are set", () => {
    expect(tv.diceDealt([H(1), H(2), H(3), H(4), H(5)])).toBe(true);
    expect(tv.diceDealt([H(1), H(2), ZERO_HANDLE, H(4), H(5)])).toBe(false);
    expect(tv.diceDealt([H(1), H(2)])).toBe(false);
    expect(tv.diceDealt(undefined)).toBe(false);
  });

  it("RV-5 (E5-R16, NIT): deal reads paidHandles, reveal reads revealHandles", () => {
    expect(pu.pushHandleView("deal")).toBe("paidHandles");
    expect(pu.pushHandleView("reveal")).toBe("revealHandles");
  });

  it("RV-6 (E5-R16, NIT): every wallet failure is reported in its own words", async () => {
    const base = {
      readPhase: async () => Phase.AwaitingPaidProof,
      readHandles: async () => [H(1)],
      publicDecrypt: async () => ({ abiEncoded: "0x01" as Hex, proof: "0x02" as Hex }),
    };
    for (const error of [
      { kind: "insufficientFunds", message: "Not enough Sepolia ETH to pay for gas. Get some from a faucet." },
      { kind: "inFlightLimit", message: "Your wallet already has a pending transaction." },
      { kind: "rejected", message: "You cancelled in the wallet. Nothing was sent." },
    ]) {
      const out = await pu.runPush({ kind: "deal", tableId: 1n, ...base, send: async () => ({ ok: false, error }) });
      expect(out).toEqual({ result: "failed", message: error.message });
    }
    const unknown = await pu.runPush({
      kind: "deal",
      tableId: 1n,
      ...base,
      send: async () => ({ ok: false, error: null }),
    });
    expect(unknown.result).toBe("failed");
    expect(unknown.message).not.toMatch(/another transaction/i); // a null error is not evidence of a pending tx
  });

  it("RV-7 (E5-R2/R15, NIT): the own-dice cache is per account AND per round", () => {
    expect(tv.ownDiceQueryKey(7n, ALICE, 1)).not.toEqual(tv.ownDiceQueryKey(7n, ALICE, 2));
  });

  it("RV-8 (E5-R6, NIT): no action before the clock is known (first render)", () => {
    const a = tv.tableActions({
      phase: Phase.Bidding,
      mySeat: 0,
      turnSeat: 0,
      playerCount: 2,
      bidQuantity: 2,
      bidFace: 3,
      deadline: 1000n,
      nowSeconds: 0n,
      canWrite: true,
      pendingTx: false,
    });
    expect([a.bid, a.liar, a.claimTimeout]).toEqual([false, false, false]);
    expect(tv.tableActions({ ...a, phase: Phase.Bidding, mySeat: NO_SEAT }).bid).toBeFalsy();
  });

  it("RV-9 (E5-R15, weak-test answer): no query persister or storage cache library is installed", () => {
    const pkg = JSON.parse(readFileSync(fileURLToPath(new URL("../../package.json", import.meta.url)), "utf8"));
    const deps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
    expect(deps.filter((d) => /persist|storage|idb|localforage/i.test(d))).toEqual([]);
  });
});
