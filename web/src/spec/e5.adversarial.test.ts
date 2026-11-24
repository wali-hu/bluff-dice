/**
 * E5 adversarial tests (spec-first VERIFY step 2): attacks from the EVM / FHEVM checklists that apply to the E5
 * table view. Every test is a must-fail case: the attack must not lead to a wrong action, a wrong value on screen,
 * an early decrypt or a modified proof. The contracts are unchanged in E5; their own adversarial suites (ACL,
 * reveal proofs, reentrancy, timeouts) live in test/ and are not repeated here.
 */
import type { Address, Hex } from "viem";
import { describe, expect, it, vi } from "vitest";

import { decodeGameLogs } from "@/chain/logs";
import { NO_SEAT, Phase } from "@/chain/reads";
import { BLUFF_DICE_ADDRESS } from "@/contracts/addresses";
import * as bidRules from "@/lib/bidRules";
import { ALICE, BOB, gameEventLog } from "@/lib/fixtures";
import * as tableView from "@/lib/tableView";
import * as timeline from "@/lib/timeline";

/* eslint-disable @typescript-eslint/no-explicit-any */
const tv = tableView as any;
const br = bidRules as any;
const tl = timeline as any;
const H = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as Hex;

describe("E5 adversarial", () => {
  // EVM #6 state machine + #1 access control: no write action in a phase where the contract would refuse it.
  it("ADV-1: no bid, LIAR!, timeout, deal or reveal in Joining, Settled or Cancelled, for anyone", () => {
    for (const phase of [Phase.Joining, Phase.Settled, Phase.Cancelled]) {
      for (const mySeat of [0, 1, NO_SEAT]) {
        const a = tv.tableActions({
          phase,
          mySeat,
          turnSeat: 0,
          playerCount: 2,
          bidQuantity: 2,
          bidFace: 3,
          deadline: 100n,
          nowSeconds: 5000n,
          canWrite: true,
          pendingTx: false,
        });
        expect([a.bid, a.liar, a.claimTimeout, a.deal, a.reveal], `phase ${phase} seat ${mySeat}`).toEqual([
          false,
          false,
          false,
          false,
          false,
        ]);
      }
    }
  });

  // EVM #4 bounds: values far outside uint8 / the table never pass as a legal bid.
  it("ADV-2: absurd bid values are rejected by the app rule", () => {
    const ctx = { playerCount: 4, prevQuantity: 0, prevFace: 0 };
    expect(br.checkBid(ctx, 255, 1)).toBe("InvalidQuantity");
    expect(br.checkBid(ctx, 1_000_000, 1)).toBe("InvalidQuantity");
    expect(br.checkBid(ctx, -1, 1)).not.toBe("ok");
    expect(br.checkBid(ctx, 1, 255)).toBe("InvalidFace");
    expect(br.checkBid(ctx, 1.5, 2)).not.toBe("ok");
  });

  // FHEVM #3 early public reveal: the app never asks the KMS for dice before the contract made them public.
  it("ADV-3: a reveal push during Bidding never public-decrypts and never sends", async () => {
    const { runPush } = (await import("@/lib/push")) as any;
    const d = {
      readPhase: vi.fn(async () => Phase.Bidding),
      readHandles: vi.fn(async () => [H(1), H(2)]),
      publicDecrypt: vi.fn(async () => ({ abiEncoded: "0x" as Hex, proof: "0x" as Hex })),
      send: vi.fn(async () => ({ ok: true as const })),
    };
    const out = await runPush({ kind: "reveal", tableId: 3n, ...d });
    expect(out.result).not.toBe("pushed");
    expect(d.publicDecrypt).not.toHaveBeenCalled();
    expect(d.readHandles).not.toHaveBeenCalled();
    expect(d.send).not.toHaveBeenCalled();
  });

  // FHEVM #6 reveal proofs: the KMS bytes reach the contract exactly as returned, whatever they look like.
  it("ADV-4: odd-looking KMS bytes are passed through untouched (no re-encoding, no trimming)", async () => {
    const { runPush } = (await import("@/lib/push")) as any;
    const weirdClear = ("0x" + "0".repeat(126) + "06") as Hex;
    const weirdProof = ("0x07" + "AbCd".repeat(40) + "01") as Hex; // mixed case, extraData tail
    const send = vi.fn(async () => ({ ok: true as const }));
    await runPush({
      kind: "deal",
      tableId: 3n,
      readPhase: async () => Phase.AwaitingPaidProof,
      readHandles: async () => [H(1), H(2)],
      publicDecrypt: async () => ({ abiEncoded: weirdClear, proof: weirdProof }),
      send,
    });
    const args = (send.mock.calls[0] as any[])[0].args;
    expect(args[1]).toBe(weirdClear);
    expect(args[2]).toBe(weirdProof);
  });

  // Bounds: an empty handle list (a misread view) must not become a startGame with nothing to check.
  it("ADV-5: an empty handle list never reaches the KMS or the contract", async () => {
    const { runPush } = (await import("@/lib/push")) as any;
    const d = {
      readPhase: vi.fn(async () => Phase.AwaitingPaidProof),
      readHandles: vi.fn(async () => [] as Hex[]),
      publicDecrypt: vi.fn(async () => ({ abiEncoded: "0x" as Hex, proof: "0x" as Hex })),
      send: vi.fn(async () => ({ ok: true as const })),
    };
    const out = await runPush({ kind: "deal", tableId: 3n, ...d });
    expect(out.result).not.toBe("pushed");
    expect(d.publicDecrypt).not.toHaveBeenCalled();
    expect(d.send).not.toHaveBeenCalled();
  });

  // Log spoofing: a BidPlaced-shaped event from another contract (a lying RPC or a copycat) is not history.
  it("ADV-6: a BidPlaced event from another contract address is ignored", () => {
    const real = gameEventLog(
      "BidPlaced",
      { tableId: 7n, round: 1, bidder: ALICE, quantity: 1, face: 2, nextSeat: 1, deadline: 0n },
      10n,
    );
    const fake = {
      ...gameEventLog(
        "BidPlaced",
        { tableId: 7n, round: 1, bidder: BOB, quantity: 9, face: 6, nextSeat: 0, deadline: 0n },
        11n,
      ),
      address: "0x9999999999999999999999999999999999999999" as Address,
    };
    const t = tl.buildTimeline(decodeGameLogs([real, fake]), 7n, 1);
    expect(t.bids.map((b: any) => b.bidder)).toEqual([ALICE]);
  });

  // FHEVM #2 / R2: a partial or oversized decrypt result never shows a partial hand.
  it("ADV-7: a decrypt that returns only some handles shows no dice", () => {
    const handles = [H(1), H(2), H(3), H(4), H(5)];
    const partial = new Map<string, bigint>([
      [H(1), 1n],
      [H(2), 2n],
      [H(3), 3n],
    ]);
    expect(tv.ownDiceView({ seated: true, handles, values: partial }).kind).not.toBe("faces");
  });

  it("ADV-8: own-dice decrypt items never point at another contract", () => {
    const items = tv.ownDiceDecryptItems({ viewerSeat: 0, handles: [H(1)], contract: BLUFF_DICE_ADDRESS });
    expect(items.every((i: any) => i.contract === BLUFF_DICE_ADDRESS)).toBe(true);
  });

  // Liveness without a fake clock: an unset deadline (0) shows no ring rather than an already-expired one.
  it("ADV-9: an unset deadline shows no countdown", () => {
    expect(tv.deadlineRing(Phase.Bidding, 0n, 5000n)).toBeNull();
  });
});
