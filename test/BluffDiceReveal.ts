import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import { expect } from "chai";
import { ethers, fhevm, network } from "hardhat";

import { BluffDice } from "../types";
import {
  BID_TIMEOUT,
  DICE_PER_PLAYER,
  NO_SEAT,
  PROOF_TIMEOUT,
  Phase,
  aclOf,
  clearValuesInOrder,
  countFace,
  decryptAll,
  deployGame,
  fullTable,
  playToLiar,
  revealProof,
} from "./helpers/fixtures";

/**
 * "Liar", the public reveal and `finalizeReveal`, with real mock KMS proofs.
 *
 * Dice are random and cannot be forced. A test that needs a given outcome first reads every die with the
 * mock-only debugger (ACL bypass), then chooses the bid. Every full round is also recounted off-chain from
 * the `publicDecrypt` clear values alone: that recount is what `scripts/verify-round.ts` will do on Sepolia.
 */

type Outcome = "bid-true" | "bid-false";

/** Bid on a face that shows at least once. "bid-true": Q = count (tie -> true). "bid-false": Q = count + 1. */
function chooseBid(values: bigint[], outcome: Outcome): { quantity: number; face: number; count: number } {
  let face = 1;
  for (let f = 2; f <= 6; ++f) if (countFace(values, f) > countFace(values, face)) face = f;
  const count = countFace(values, face);
  if (outcome === "bid-false" && count === values.length) throw new Error("all dice equal: cannot bid count + 1");
  return { quantity: outcome === "bid-true" ? count : count + 1, face, count };
}

describe("BluffDice: Liar and reveal", function () {
  let signers: HardhatEthersSigner[];
  let outsider: HardhatEthersSigner;
  let game: BluffDice;
  let gameAddress: string;

  before(async function () {
    signers = await ethers.getSigners();
    outsider = signers[9];
  });

  beforeEach(async function () {
    if (!fhevm.isMock) {
      console.warn("This hardhat test suite cannot run on Sepolia Testnet");
      this.skip();
    }
    game = await deployGame();
    gameAddress = await game.getAddress();
  });

  /** Full table of `n` players, a bid with a known outcome by seat 0, "Liar" by seat 1. */
  async function liarTable(n: number, outcome: Outcome, players = signers.slice(0, n)) {
    const { tableId } = await fullTable(game, players);
    const values = await decryptAll(game, tableId);
    const { quantity, face, count } = chooseBid(values, outcome);
    await playToLiar(game, tableId, players, quantity, face);
    return { tableId, players, values, quantity, face, count };
  }

  describe("callLiar", function () {
    it("moves the table to AwaitingReveal with a 1 h proof deadline and emits LiarCalled", async function () {
      const players = signers.slice(0, 2);
      const { tableId } = await fullTable(game, players);
      await game.connect(players[0]).bid(tableId, 3, 4);

      const tx = await game.connect(players[1]).callLiar(tableId);
      await tx.wait();
      const now = BigInt(await time.latest());
      await expect(tx)
        .to.emit(game, "LiarCalled")
        .withArgs(tableId, 1, players[1].address, players[0].address, 3, 4, now + PROOF_TIMEOUT);

      const t = await game.getTable(tableId);
      expect(t.phase).to.eq(Phase.AwaitingReveal);
      expect(t.liarCallerSeat).to.eq(1);
      expect(t.bidderSeat).to.eq(0);
      expect(t.turnSeat).to.eq(NO_SEAT);
      expect(t.deadline).to.eq(now + PROOF_TIMEOUT);
      expect(t.loserSeat).to.eq(NO_SEAT);
    });

    it("reverts NoBidToChallenge before the first bid", async function () {
      const players = signers.slice(0, 2);
      const { tableId } = await fullTable(game, players);
      await expect(game.connect(players[0]).callLiar(tableId))
        .to.be.revertedWithCustomError(game, "NoBidToChallenge")
        .withArgs(tableId);
    });

    it("reverts NotYourTurn for a seated player out of turn and NotPlayer for an outsider", async function () {
      const players = signers.slice(0, 3);
      const { tableId } = await fullTable(game, players);
      await game.connect(players[0]).bid(tableId, 1, 2);
      await expect(game.connect(players[2]).callLiar(tableId))
        .to.be.revertedWithCustomError(game, "NotYourTurn")
        .withArgs(tableId, players[1].address, players[2].address);
      await expect(game.connect(outsider).callLiar(tableId))
        .to.be.revertedWithCustomError(game, "NotPlayer")
        .withArgs(tableId, outsider.address);
    });

    it("reverts TurnExpired after the turn deadline", async function () {
      const players = signers.slice(0, 2);
      const { tableId } = await fullTable(game, players);
      await game.connect(players[0]).bid(tableId, 1, 2);
      const { deadline } = await game.getTable(tableId);
      await time.setNextBlockTimestamp(deadline + 1n);
      await expect(game.connect(players[1]).callLiar(tableId))
        .to.be.revertedWithCustomError(game, "TurnExpired")
        .withArgs(tableId, deadline);
    });

    it("reverts WrongPhase while Joining and after a timeout settled the table", async function () {
      const players = signers.slice(0, 2);
      const tableId = await game.nextTableId();
      await game.connect(players[0]).createTable(600, 2);
      await expect(game.connect(players[0]).callLiar(tableId))
        .to.be.revertedWithCustomError(game, "WrongPhase")
        .withArgs(tableId, Phase.Bidding, Phase.Joining);

      await game.connect(players[1]).joinTable(tableId);
      await time.increase(BID_TIMEOUT + 1n);
      await game.claimTurnTimeout(tableId);
      await expect(game.connect(players[0]).callLiar(tableId))
        .to.be.revertedWithCustomError(game, "WrongPhase")
        .withArgs(tableId, Phase.Bidding, Phase.Settled);
    });

    it("in AwaitingReveal, bid, claimTurnTimeout and a second callLiar revert WrongPhase", async function () {
      const { tableId, players } = await liarTable(2, "bid-true");
      await time.increase(BID_TIMEOUT + 1n);
      const wrong = [tableId, Phase.Bidding, Phase.AwaitingReveal] as const;
      await expect(game.connect(players[0]).bid(tableId, 10, 6))
        .to.be.revertedWithCustomError(game, "WrongPhase")
        .withArgs(...wrong);
      await expect(game.claimTurnTimeout(tableId))
        .to.be.revertedWithCustomError(game, "WrongPhase")
        .withArgs(...wrong);
      await expect(game.connect(players[1]).callLiar(tableId))
        .to.be.revertedWithCustomError(game, "WrongPhase")
        .withArgs(...wrong);
    });

    it("callLiar exactly at the turn deadline succeeds; in the same second a table with the same deadline cannot be timed out", async function () {
      const a = signers.slice(0, 2);
      const b = signers.slice(2, 4);
      const { tableId: tableA } = await fullTable(game, a);
      const { tableId: tableB } = await fullTable(game, b);

      // Both opening bids in one block, so both tables get the same turn deadline D.
      await network.provider.send("evm_setAutomine", [false]);
      try {
        await game.connect(a[0]).bid(tableA, 1, 1, { gasLimit: 300_000 });
        await game.connect(b[0]).bid(tableB, 1, 1, { gasLimit: 300_000 });
        await network.provider.send("evm_mine");
      } finally {
        await network.provider.send("evm_setAutomine", [true]);
      }
      const deadline = (await game.getTable(tableA)).deadline;
      expect((await game.getTable(tableB)).deadline).to.eq(deadline);

      // One block at timestamp D: callLiar on A, claimTurnTimeout on B.
      let liarHash = "";
      let timeoutHash = "";
      await network.provider.send("evm_setAutomine", [false]);
      try {
        await time.setNextBlockTimestamp(deadline);
        liarHash = (await game.connect(a[1]).callLiar(tableA, { gasLimit: 2_000_000 })).hash;
        timeoutHash = (await game.connect(outsider).claimTurnTimeout(tableB, { gasLimit: 300_000 })).hash;
        await network.provider.send("evm_mine");
      } finally {
        await network.provider.send("evm_setAutomine", [true]);
      }
      const liarReceipt = await ethers.provider.getTransactionReceipt(liarHash);
      const timeoutReceipt = await ethers.provider.getTransactionReceipt(timeoutHash);
      expect(liarReceipt!.blockNumber).to.eq(timeoutReceipt!.blockNumber);
      expect((await ethers.provider.getBlock(liarReceipt!.blockNumber))!.timestamp).to.eq(Number(deadline));
      expect(liarReceipt!.status).to.eq(1);
      expect(timeoutReceipt!.status).to.eq(0);
      expect((await game.getTable(tableA)).phase).to.eq(Phase.AwaitingReveal);
      expect((await game.getTable(tableB)).phase).to.eq(Phase.Bidding);
      // Replay the failed call in the context of that block to name the revert.
      await expect(game.connect(outsider).claimTurnTimeout.staticCall(tableB, { blockTag: liarReceipt!.blockNumber }))
        .to.be.revertedWithCustomError(game, "DeadlineNotPassed")
        .withArgs(tableB, deadline);
    });

    for (const n of [2, 3, 4]) {
      it(`${n} players: no die is public before Liar; after it all ${n * 5} are, and anyone can publicDecrypt them`, async function () {
        const players = signers.slice(0, n);
        const { tableId } = await fullTable(game, players);
        const acl = await aclOf(gameAddress);
        const [firstDie] = await game.diceOf(tableId, players[0].address);
        await expect(fhevm.publicDecrypt([firstDie])).to.be.rejectedWith("is not allowed for public decryption");

        const truth = await decryptAll(game, tableId);
        await playToLiar(game, tableId, players, 1, 1);

        const handles = [...(await game.revealHandles(tableId))];
        expect(handles).to.have.length(n * DICE_PER_PLAYER);
        for (const h of handles) expect(await acl.isAllowedForDecryption(h)).to.eq(true);
        // publicDecrypt needs no signer and no ACL entry for the reader: an outsider gets the same values.
        const r = await fhevm.publicDecrypt(handles);
        expect(clearValuesInOrder(handles, r.clearValues)).to.deep.eq(truth);
        // Public decryption does not grant user-decryption rights to an outsider.
        for (const h of handles) expect(await acl.persistAllowed(h, outsider.address)).to.eq(false);
      });
    }
  });

  describe("revealHandles", function () {
    it("reverts LiarNotCalled during Bidding", async function () {
      const { tableId } = await fullTable(game, signers.slice(0, 2));
      await expect(game.revealHandles(tableId)).to.be.revertedWithCustomError(game, "LiarNotCalled").withArgs(tableId);
    });

    it("reverts LiarNotCalled after a turn timeout, whose dice stay private", async function () {
      const players = signers.slice(0, 3);
      const { tableId } = await fullTable(game, players);
      await game.connect(players[0]).bid(tableId, 2, 2);
      await time.increase(BID_TIMEOUT + 1n);
      await game.claimTurnTimeout(tableId);

      await expect(game.revealHandles(tableId)).to.be.revertedWithCustomError(game, "LiarNotCalled").withArgs(tableId);
      const acl = await aclOf(gameAddress);
      for (const p of players) {
        for (const die of await game.diceOf(tableId, p.address)) {
          expect(await acl.isAllowedForDecryption(die)).to.eq(false);
        }
      }
      const [die] = await game.diceOf(tableId, players[1].address);
      await expect(fhevm.publicDecrypt([die])).to.be.rejectedWith("is not allowed for public decryption");
    });

    it("reverts TableNotFound for an unknown table", async function () {
      await expect(game.revealHandles(99n)).to.be.revertedWithCustomError(game, "TableNotFound").withArgs(99n);
    });

    for (const n of [2, 3, 4]) {
      it(`${n} players: equals diceOf(seat 0) ++ ... ++ diceOf(seat ${n - 1}), length ${n * 5}`, async function () {
        const players = signers.slice(0, n);
        const { tableId } = await fullTable(game, players);
        await playToLiar(game, tableId, players, 1, 1);

        const expected: string[] = [];
        for (const p of players) expected.push(...(await game.diceOf(tableId, p.address)));
        expect([...(await game.revealHandles(tableId))]).to.deep.eq(expected);
      });
    }

    it("stays readable after the round is Settled (verify panel)", async function () {
      const { tableId } = await liarTable(2, "bid-true");
      const before = [...(await game.revealHandles(tableId))];
      const r = await revealProof(game, tableId);
      await game.connect(outsider).finalizeReveal(tableId, r.abiEncodedClearValues, r.decryptionProof);
      expect((await game.getTable(tableId)).phase).to.eq(Phase.Settled);
      expect([...(await game.revealHandles(tableId))]).to.deep.eq(before);
    });
  });

  describe("finalizeReveal: full rounds", function () {
    for (const n of [2, 3, 4]) {
      for (const outcome of ["bid-true", "bid-false"] as const) {
        const loserRole = outcome === "bid-true" ? "caller" : "bidder";
        it(`${n} players, ${outcome === "bid-true" ? "count == Q (bid true)" : "count == Q - 1 (bid false)"}: the ${loserRole} loses`, async function () {
          const { tableId, players, values, quantity, face, count } = await liarTable(n, outcome);
          const r = await revealProof(game, tableId);

          // Off-chain recount from public data only (what scripts/verify-round.ts will do).
          const publicValues = clearValuesInOrder(r.handles, r.clearValues);
          expect(publicValues).to.deep.eq(values);
          const recount = countFace(publicValues, face);
          expect(recount).to.eq(count);
          const expectedLoserSeat = recount >= quantity ? 1 : 0; // caller = seat 1, bidder = seat 0
          expect(expectedLoserSeat).to.eq(outcome === "bid-true" ? 1 : 0);

          await expect(game.connect(outsider).finalizeReveal(tableId, r.abiEncodedClearValues, r.decryptionProof))
            .to.emit(game, "RoundRevealed")
            .withArgs(tableId, 1, players[expectedLoserSeat].address, recount, quantity, face)
            .and.to.emit(game, "PublicDecryptionVerified")
            .withArgs(r.handles, r.abiEncodedClearValues);

          const t = await game.getTable(tableId);
          expect(t.phase).to.eq(Phase.Settled);
          expect(t.revealedCount).to.eq(recount);
          expect(t.loserSeat).to.eq(expectedLoserSeat);
          expect(t.turnSeat).to.eq(NO_SEAT);
        });
      }
    }

    it("is permissionless: an outsider's submission gives the same result as a player's", async function () {
      const players = signers.slice(0, 3);
      const A = await liarTable(3, "bid-false", players);
      const rA = await revealProof(game, A.tableId);
      await game.connect(players[2]).finalizeReveal(A.tableId, rA.abiEncodedClearValues, rA.decryptionProof);

      const B = await liarTable(3, "bid-false", players);
      const rB = await revealProof(game, B.tableId);
      await game.connect(outsider).finalizeReveal(B.tableId, rB.abiEncodedClearValues, rB.decryptionProof);

      for (const x of [A, B]) {
        const t = await game.getTable(x.tableId);
        expect(t.loserSeat).to.eq(0);
        expect(t.revealedCount).to.eq(x.count);
      }
    });

    it("4 players: the two players outside the challenge never lose", async function () {
      for (const outcome of ["bid-true", "bid-false"] as const) {
        const { tableId } = await liarTable(4, outcome);
        const r = await revealProof(game, tableId);
        await game.finalizeReveal(tableId, r.abiEncodedClearValues, r.decryptionProof);
        const { loserSeat } = await game.getTable(tableId);
        expect([0n, 1n]).to.include(loserSeat);
        expect(loserSeat).to.not.eq(2n);
        expect(loserSeat).to.not.eq(3n);
      }
    });

    it("reverts WrongPhase in Joining, Bidding and timeout-Settled, and TableNotFound for an unknown id", async function () {
      const players = signers.slice(0, 2);
      const proof = await (async () => {
        const { tableId } = await liarTable(2, "bid-true");
        return revealProof(game, tableId);
      })();
      const args = [proof.abiEncodedClearValues, proof.decryptionProof] as const;

      const joining = await game.nextTableId();
      await game.connect(players[0]).createTable(600, 2);
      await expect(game.finalizeReveal(joining, ...args))
        .to.be.revertedWithCustomError(game, "WrongPhase")
        .withArgs(joining, Phase.AwaitingReveal, Phase.Joining);

      await game.connect(players[1]).joinTable(joining);
      await expect(game.finalizeReveal(joining, ...args))
        .to.be.revertedWithCustomError(game, "WrongPhase")
        .withArgs(joining, Phase.AwaitingReveal, Phase.Bidding);

      await time.increase(BID_TIMEOUT + 1n);
      await game.claimTurnTimeout(joining);
      await expect(game.finalizeReveal(joining, ...args))
        .to.be.revertedWithCustomError(game, "WrongPhase")
        .withArgs(joining, Phase.AwaitingReveal, Phase.Settled);

      await expect(game.finalizeReveal(1234n, ...args))
        .to.be.revertedWithCustomError(game, "TableNotFound")
        .withArgs(1234n);
    });
  });

  describe("cancel", function () {
    it("reverts DeadlineNotPassed before and at the proof deadline; after it anyone cancels", async function () {
      const { tableId } = await liarTable(2, "bid-true");
      const { deadline } = await game.getTable(tableId);
      await expect(game.connect(outsider).cancel(tableId))
        .to.be.revertedWithCustomError(game, "DeadlineNotPassed")
        .withArgs(tableId, deadline);
      await time.setNextBlockTimestamp(deadline);
      await expect(game.connect(outsider).cancel(tableId))
        .to.be.revertedWithCustomError(game, "DeadlineNotPassed")
        .withArgs(tableId, deadline);

      await expect(game.connect(outsider).cancel(tableId)).to.emit(game, "TableCancelled").withArgs(tableId);
      const t = await game.getTable(tableId);
      expect(t.phase).to.eq(Phase.Cancelled);
      expect(t.loserSeat).to.eq(NO_SEAT);
    });

    it("reverts NotCancellable in Joining, Bidding and Settled, and TableNotFound for an unknown id", async function () {
      const players = signers.slice(0, 2);
      const tableId = await game.nextTableId();
      await game.connect(players[0]).createTable(600, 2);
      await expect(game.cancel(tableId))
        .to.be.revertedWithCustomError(game, "NotCancellable")
        .withArgs(tableId, Phase.Joining);

      await game.connect(players[1]).joinTable(tableId);
      await time.increase(BID_TIMEOUT + 1n);
      await expect(game.cancel(tableId))
        .to.be.revertedWithCustomError(game, "NotCancellable")
        .withArgs(tableId, Phase.Bidding);

      await game.claimTurnTimeout(tableId);
      await expect(game.cancel(tableId))
        .to.be.revertedWithCustomError(game, "NotCancellable")
        .withArgs(tableId, Phase.Settled);

      await expect(game.cancel(77n)).to.be.revertedWithCustomError(game, "TableNotFound").withArgs(77n);
    });

    it("accepts a late proof: after the deadline, finalizeReveal still settles until someone cancels", async function () {
      const { tableId, count } = await liarTable(3, "bid-true");
      await time.increase(PROOF_TIMEOUT + 60n);
      const r = await revealProof(game, tableId);
      await expect(game.finalizeReveal(tableId, r.abiEncodedClearValues, r.decryptionProof)).to.emit(
        game,
        "RoundRevealed",
      );
      const t = await game.getTable(tableId);
      expect(t.phase).to.eq(Phase.Settled);
      expect(t.revealedCount).to.eq(count);
      expect(t.loserSeat).to.eq(1);
    });

    it("finalizeReveal after cancel reverts WrongPhase; cancel after finalizeReveal reverts NotCancellable", async function () {
      const cancelled = await liarTable(2, "bid-true");
      const settled = await liarTable(2, "bid-true");
      const rC = await revealProof(game, cancelled.tableId);
      const rS = await revealProof(game, settled.tableId);

      await time.increase(PROOF_TIMEOUT + 1n);
      await game.cancel(cancelled.tableId);
      await expect(game.finalizeReveal(cancelled.tableId, rC.abiEncodedClearValues, rC.decryptionProof))
        .to.be.revertedWithCustomError(game, "WrongPhase")
        .withArgs(cancelled.tableId, Phase.AwaitingReveal, Phase.Cancelled);

      await game.finalizeReveal(settled.tableId, rS.abiEncodedClearValues, rS.decryptionProof);
      await expect(game.cancel(settled.tableId))
        .to.be.revertedWithCustomError(game, "NotCancellable")
        .withArgs(settled.tableId, Phase.Settled);
    });

    it("after cancel every die stays publicly decryptable (no revoke) and revealHandles stays readable", async function () {
      const { tableId, values } = await liarTable(3, "bid-false");
      await time.increase(PROOF_TIMEOUT + 1n);
      await game.cancel(tableId);

      const handles = [...(await game.revealHandles(tableId))];
      const acl = await aclOf(gameAddress);
      for (const h of handles) expect(await acl.isAllowedForDecryption(h)).to.eq(true);
      const r = await fhevm.publicDecrypt(handles);
      expect(clearValuesInOrder(handles, r.clearValues)).to.deep.eq(values);
    });
  });
});
