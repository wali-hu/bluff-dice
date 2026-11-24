/**
 * E5 invariants (spec-first VERIFY step 3): seeded random inputs, fixed seed so a failure is reproducible.
 * Invariants in words:
 *  INV-1 (E5-R4) a bid the app accepts is strictly higher than the previous bid in (quantity, face) order and
 *        within 1..playerCount*5 x 1..6.
 *  INV-2 (E5-R5) the picker's start is accepted, and no smaller (quantity, face) pair is accepted.
 *  INV-3 (E5-R5) legalFaces(q) is exactly the faces checkBid accepts at quantity q.
 *  INV-4 (E5-R10) the ring never shows negative time and expires exactly at the deadline.
 *  INV-5 (E5-R6/R7) nobody is offered a bid and a timeout claim at the same moment.
 */
import { describe, expect, it } from "vitest";

import { NO_SEAT, Phase } from "@/chain/reads";
import { checkBid, legalFaces, smallestLegalBid } from "@/lib/bidRules";
import { deadlineRing, tableActions } from "@/lib/tableView";

const SEED = 0x5eed_e5;
const RUNS = 5_000;
/** Thousands of assertions per test: well over vitest's 5 s default. */
const TIMEOUT_MS = 60_000;

/** mulberry32: small, fast, deterministic. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("E5 invariants", () => {
  it(
    `INV-1..3: bid rule properties hold on ${RUNS} random tables (seed ${SEED.toString(16)})`,
    () => {
      const r = rng(SEED);
      const int = (lo: number, hi: number) => lo + Math.floor(r() * (hi - lo + 1));
      for (let i = 0; i < RUNS; i++) {
        const playerCount = int(2, 4);
        const max = playerCount * 5;
        const hasPrev = r() < 0.8;
        const ctx = { playerCount, prevQuantity: hasPrev ? int(1, max) : 0, prevFace: hasPrev ? int(1, 6) : 0 };
        const q = int(-1, max + 2);
        const f = int(-1, 8);
        const res = checkBid(ctx, q, f);
        if (res === "ok") {
          expect(q >= 1 && q <= max && f >= 1 && f <= 6).toBe(true);
          expect(q > ctx.prevQuantity || (q === ctx.prevQuantity && f > ctx.prevFace)).toBe(true);
        }
        const start = smallestLegalBid(ctx);
        if (start) {
          expect(checkBid(ctx, start.quantity, start.face)).toBe("ok");
          for (let qq = 1; qq <= start.quantity; qq++) {
            for (let ff = 1; ff <= 6; ff++) {
              const smaller = qq < start.quantity || ff < start.face;
              if (smaller)
                expect(checkBid(ctx, qq, ff), `${qq}x${ff} below ${start.quantity}x${start.face}`).not.toBe("ok");
            }
          }
        } else {
          expect(ctx.prevQuantity === max && ctx.prevFace === 6).toBe(true);
        }
        const qq = int(1, max);
        const expected = [1, 2, 3, 4, 5, 6].filter((ff) => checkBid(ctx, qq, ff) === "ok");
        expect(legalFaces(ctx, qq)).toEqual(expected);
      }
    },
    TIMEOUT_MS,
  );

  it(
    `INV-4..5: ring and actions on ${RUNS} random clocks (seed ${(SEED + 1).toString(16)})`,
    () => {
      const r = rng(SEED + 1);
      for (let i = 0; i < RUNS; i++) {
        const deadline = BigInt(1 + Math.floor(r() * 10_000));
        const now = BigInt(Math.floor(r() * 20_000));
        const ring = deadlineRing(Phase.Bidding, deadline, now);
        expect(ring).not.toBeNull();
        expect(ring!.secondsLeft).toBeGreaterThanOrEqual(0);
        expect(ring!.label).not.toMatch(/-\d/);
        if (now >= deadline) expect(ring!.label).toBe("Time's up");
        const seats = [0, 1, 2, 3, NO_SEAT];
        const a = tableActions({
          phase: Phase.Bidding,
          mySeat: seats[Math.floor(r() * seats.length)] ?? NO_SEAT,
          turnSeat: Math.floor(r() * 4),
          playerCount: 4,
          bidQuantity: Math.floor(r() * 21),
          bidFace: Math.floor(r() * 7),
          deadline,
          nowSeconds: now,
          canWrite: r() < 0.9,
          pendingTx: r() < 0.2,
        });
        expect(a.bid && a.claimTimeout).toBe(false);
      }
    },
    TIMEOUT_MS,
  );
});
