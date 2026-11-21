import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import { expect } from "chai";
import { ethers, fhevm } from "hardhat";

import { BluffChips, BluffDice } from "../types";
import {
  BID_TIMEOUT,
  FAUCET_AMOUNT,
  FUNDED_SIGNERS,
  KMS_ERRORS,
  NO_SEAT,
  PROOF_TIMEOUT,
  Phase,
  STAKE,
  aclOf,
  approve,
  balanceOfAny,
  chipBalance,
  clearValuesInOrder,
  createTable,
  decryptDiceAs,
  deployAll,
  fullTable,
  joinWords,
  paidProof,
  playToLiar,
  startWithProof,
  word,
  words,
} from "./helpers/fixtures";

/**
 * The paid check: when a table fills, every seat's paid flag (euint8, 0 or 1) becomes publicly decryptable;
 * `startGame` verifies the KMS proof against the handles in STORAGE, then either rolls the dice (all paid) or
 * drops the non-payers (seats reopen, the table goes back to Joining).
 */
describe("BluffDice: paid check and startGame", function () {
  let signers: HardhatEthersSigner[];
  let alice: HardhatEthersSigner;
  let bob: HardhatEthersSigner;
  let carol: HardhatEthersSigner;
  let dave: HardhatEthersSigner;
  let outsider: HardhatEthersSigner;
  /** Never held chips (approved). */
  let broke: HardhatEthersSigner;
  let broke2: HardhatEthersSigner;
  /** Initialized balance of 5, below the stake (approved). */
  let poor: HardhatEthersSigner;
  let game: BluffDice;
  let token: BluffChips;
  let gameAddress: string;

  before(async function () {
    signers = await ethers.getSigners();
    [alice, bob, carol, dave] = signers;
    outsider = signers[9];
    broke = signers[FUNDED_SIGNERS];
    broke2 = signers[FUNDED_SIGNERS + 1];
    poor = signers[FUNDED_SIGNERS + 2];
  });

  beforeEach(async function () {
    if (!fhevm.isMock) {
      console.warn("This hardhat test suite cannot run on Sepolia Testnet");
      this.skip();
    }
    ({ game, token } = await deployAll());
    gameAddress = await game.getAddress();
    for (const s of [broke, broke2, poor]) await approve(token, game, s);
    await (await token.connect(alice).mint(poor.address, 5n)).wait();
  });

  /** Seats `players` in order (players[0] creates); the last join fills the table. */
  async function filledTable(players: HardhatEthersSigner[]): Promise<bigint> {
    const tableId = await createTable(game, players[0], players.length);
    for (const p of players.slice(1)) await (await game.connect(p).joinTable(tableId)).wait();
    return tableId;
  }

  describe("filling join", function () {
    for (const n of [2, 3, 4]) {
      it(`${n} players: AwaitingPaidProof, 1 h deadline, every paid flag public, no dice yet`, async function () {
        const players = signers.slice(0, n);
        const tableId = await createTable(game, players[0], n);
        for (const p of players.slice(1, -1)) await game.connect(p).joinTable(tableId);
        const fill = await game.connect(players[n - 1]).joinTable(tableId);
        await fill.wait();
        const deadline = BigInt(await time.latest()) + PROOF_TIMEOUT;
        await expect(fill).to.emit(game, "PaidCheckRequested").withArgs(tableId, deadline);

        const t = await game.getTable(tableId);
        expect(t.phase).to.eq(Phase.AwaitingPaidProof);
        expect(t.deadline).to.eq(deadline);

        const acl = await aclOf(gameAddress);
        const handles = await game.paidHandles(tableId);
        expect(handles).to.have.length(n);
        for (const [seat, p] of players.entries()) {
          const [, paid] = await game.stakeOf(tableId, p.address);
          expect(handles[seat]).to.eq(paid);
          expect(await acl.isAllowedForDecryption(paid)).to.eq(true);
          for (const die of await game.diceOf(tableId, p.address)) expect(die).to.eq(ethers.ZeroHash);
        }
      });
    }

    it("paidHandles reverts PaidCheckNotRequested in Joining and on a table its last leaver cancelled", async function () {
      const tableId = await createTable(game, alice, 3);
      await expect(game.paidHandles(tableId))
        .to.be.revertedWithCustomError(game, "PaidCheckNotRequested")
        .withArgs(tableId);
      await (await game.connect(alice).leaveTable(tableId)).wait();
      await expect(game.paidHandles(tableId))
        .to.be.revertedWithCustomError(game, "PaidCheckNotRequested")
        .withArgs(tableId);
    });

    it("in AwaitingPaidProof joinTable, leaveTable, bid and callLiar revert WrongPhase", async function () {
      const tableId = await filledTable([alice, bob]);
      const wrong = (expected: Phase) => [tableId, expected, Phase.AwaitingPaidProof] as const;
      await expect(game.connect(carol).joinTable(tableId))
        .to.be.revertedWithCustomError(game, "WrongPhase")
        .withArgs(...wrong(Phase.Joining));
      await expect(game.connect(bob).leaveTable(tableId))
        .to.be.revertedWithCustomError(game, "WrongPhase")
        .withArgs(...wrong(Phase.Joining));
      await expect(game.connect(alice).bid(tableId, 1, 1))
        .to.be.revertedWithCustomError(game, "WrongPhase")
        .withArgs(...wrong(Phase.Bidding));
      await expect(game.connect(alice).callLiar(tableId))
        .to.be.revertedWithCustomError(game, "WrongPhase")
        .withArgs(...wrong(Phase.Bidding));
    });
  });

  describe("startGame, everyone paid", function () {
    for (const n of [2, 3, 4]) {
      it(`${n} players: an outsider submits the proof; dice are rolled and owner-only; Bidding`, async function () {
        const players = signers.slice(0, n);
        const tableId = await filledTable(players);
        const receipt = await startWithProof(game, tableId, {}, outsider);
        const now = BigInt(await time.latest());
        const names = receipt.logs.map((l) => game.interface.parseLog(l)?.name);
        expect(names).to.include("GameStarted");
        expect(names).to.not.include("PlayerDropped");

        const t = await game.getTable(tableId);
        expect(t.phase).to.eq(Phase.Bidding);
        expect(t.deadline).to.eq(now + BID_TIMEOUT);
        const values = await decryptDiceAs(game, tableId, players[0], players[0]);
        for (const v of values) expect(v >= 1n && v <= 6n).to.eq(true);
        const [die] = await game.diceOf(tableId, players[0].address);
        await expect(decryptDiceAs(game, tableId, players[0], players[1])).to.be.rejectedWith(
          `User ${players[1].address} is not authorized to user decrypt handle ${die}!`,
        );
        expect(await balanceOfAny(token, gameAddress)).to.eq(BigInt(n) * STAKE);
      });
    }

    it("the publicly decrypted flags are euint8 words 0/1 (euint -> bigint in the SDK; ebool would be boolean)", async function () {
      const tableId = await filledTable([alice, bob, poor]);
      const p = await paidProof(game, tableId);
      const values = clearValuesInOrder(p.handles, p.clearValues);
      expect(values).to.deep.eq([1n, 1n, 0n]);
      expect(words(p.abiEncodedClearValues)).to.deep.eq([word(1), word(1), word(0)]);
    });
  });

  describe("startGame, non-payers dropped", function () {
    for (const brokeSeat of [0, 1, 2]) {
      it(`3 players, non-payer at seat ${brokeSeat}: dropped, seat reopens, payers keep seat and escrow`, async function () {
        const order = [alice, bob];
        order.splice(brokeSeat, 0, broke);
        const tableId = await filledTable(order);
        expect(await game.seatOf(tableId, broke.address)).to.eq(brokeSeat);

        const receipt = await startWithProof(game, tableId);
        const dropped = receipt.logs
          .map((l) => game.interface.parseLog(l))
          .filter((e) => e?.name === "PlayerDropped")
          .map((e) => [...e!.args]);
        expect(dropped).to.deep.eq([[tableId, broke.address, BigInt(brokeSeat)]]);

        const t = await game.getTable(tableId);
        expect(t.phase).to.eq(Phase.Joining);
        expect(t.playerCount).to.eq(2);
        expect(t.deadline).to.eq(0);
        expect(t.players[brokeSeat]).to.eq(ethers.ZeroAddress);
        expect(await game.seatOf(tableId, broke.address)).to.eq(NO_SEAT);
        expect(await game.dropped(tableId, broke.address)).to.eq(true);
        for (const p of [alice, bob]) {
          expect(await game.seatOf(tableId, p.address)).to.not.eq(NO_SEAT);
          for (const die of await game.diceOf(tableId, p.address)) expect(die).to.eq(ethers.ZeroHash);
        }
        expect(await balanceOfAny(token, gameAddress)).to.eq(2n * STAKE);
        await expect(game.paidHandles(tableId)).to.be.revertedWithCustomError(game, "PaidCheckNotRequested");
      });
    }

    it("refill with a FUNDED player: new list, the old proof -> KMSInvalidSigner, the new proof starts the game", async function () {
      const tableId = await filledTable([alice, bob, poor]);
      const old = await paidProof(game, tableId);
      await game.startGame(tableId, old.abiEncodedClearValues, old.decryptionProof);
      await (await game.connect(carol).joinTable(tableId)).wait(); // takes the reopened seat 2

      expect(await game.paidHandles(tableId)).to.not.deep.eq(old.handles);
      await expect(game.startGame(tableId, old.abiEncodedClearValues, old.decryptionProof))
        .to.be.revertedWithCustomError(KMS_ERRORS, "KMSInvalidSigner")
        .withArgs(ethers.isAddress);
      await startWithProof(game, tableId);
      expect((await game.getTable(tableId)).phase).to.eq(Phase.Bidding);
    });

    it("refill with ANOTHER never-funded player: same handle list, the old proof is valid again and drops them (true values only)", async function () {
      const tableId = await filledTable([alice, bob, broke]);
      const old = await paidProof(game, tableId);
      await game.startGame(tableId, old.abiEncodedClearValues, old.decryptionProof);
      await (await game.connect(broke2).joinTable(tableId)).wait();

      // Deterministic handles: a never-funded refiller recreates exactly the old list.
      expect([...(await game.paidHandles(tableId))]).to.deep.eq(old.handles);
      await expect(game.connect(outsider).startGame(tableId, old.abiEncodedClearValues, old.decryptionProof))
        .to.emit(game, "PlayerDropped")
        .withArgs(tableId, broke2.address, 2);
      expect((await game.getTable(tableId)).phase).to.eq(Phase.Joining);
    });

    it("a dropped address cannot rejoin the same table, but can join another one", async function () {
      const tableId = await filledTable([alice, bob, broke]);
      await startWithProof(game, tableId);
      await expect(game.connect(broke).joinTable(tableId))
        .to.be.revertedWithCustomError(game, "DroppedFromTable")
        .withArgs(tableId, broke.address);
      const other = await createTable(game, carol, 2);
      await (await game.connect(broke).joinTable(other)).wait();
      expect(await game.seatOf(other, broke.address)).to.eq(1);
    });

    it("when nobody paid, every seat is dropped and the table is Cancelled", async function () {
      const tableId = await filledTable([poor, broke]);
      await expect(startWithProof(game, tableId)).to.not.be.reverted;
      const t = await game.getTable(tableId);
      expect(t.phase).to.eq(Phase.Cancelled);
      expect(t.playerCount).to.eq(0);
      await expect(game.paidHandles(tableId)).to.be.revertedWithCustomError(game, "PaidCheckNotRequested");
      expect(await chipBalance(token, poor)).to.eq(5n);
    });
  });

  describe("proofs that must be rejected (the table stays in AwaitingPaidProof)", function () {
    async function expectUnchanged(tableId: bigint) {
      const t = await game.getTable(tableId);
      expect(t.phase).to.eq(Phase.AwaitingPaidProof);
      expect(t.playerCount).to.eq(3);
    }

    it("tampered 0 -> 1, another table's proof, a same-length dice proof, wrong length, empty proof; then a valid proof works once", async function () {
      const tableId = await filledTable([alice, bob, broke]);
      const valid = await paidProof(game, tableId);

      // The cheater's dream: the non-payer's 0 rewritten as 1.
      const ws = words(valid.abiEncodedClearValues);
      expect(ws[2]).to.eq(word(0));
      ws[2] = word(1);
      const forged = joinWords(ws);
      expect(forged).to.not.eq(valid.abiEncodedClearValues);
      await expect(game.startGame(tableId, forged, valid.decryptionProof))
        .to.be.revertedWithCustomError(KMS_ERRORS, "KMSInvalidSigner")
        .withArgs(ethers.isAddress);
      await expectUnchanged(tableId);

      // A valid paid proof of another 3-player table (everyone paid there: all words 1).
      const other = await filledTable([carol, dave, signers[4]]);
      const otherProof = await paidProof(game, other);
      await expect(game.startGame(tableId, otherProof.abiEncodedClearValues, otherProof.decryptionProof))
        .to.be.revertedWithCustomError(KMS_ERRORS, "KMSInvalidSigner")
        .withArgs(ethers.isAddress);
      await expectUnchanged(tableId);

      // A valid proof of the same length for other handles: 3 public dice of a table after Liar.
      const players = signers.slice(5, 7);
      const { tableId: diceTable } = await fullTable(game, players);
      await playToLiar(game, diceTable, players, 1, 1);
      const dice = (await game.revealHandles(diceTable)).slice(0, 3);
      const diceProof = await fhevm.publicDecrypt([...dice]);
      await expect(game.startGame(tableId, diceProof.abiEncodedClearValues, diceProof.decryptionProof))
        .to.be.revertedWithCustomError(KMS_ERRORS, "KMSInvalidSigner")
        .withArgs(ethers.isAddress);
      await expectUnchanged(tableId);

      const short = joinWords(words(valid.abiEncodedClearValues).slice(0, 2));
      await expect(game.startGame(tableId, short, valid.decryptionProof))
        .to.be.revertedWithCustomError(game, "InvalidCleartextsLength")
        .withArgs(96, 64);
      await expect(game.startGame(tableId, valid.abiEncodedClearValues, "0x")).to.be.revertedWithCustomError(
        KMS_ERRORS,
        "EmptyDecryptionProof",
      );
      await expectUnchanged(tableId);

      await expect(game.startGame(tableId, valid.abiEncodedClearValues, valid.decryptionProof)).to.emit(
        game,
        "PlayerDropped",
      );
      await expect(game.startGame(tableId, valid.abiEncodedClearValues, valid.decryptionProof))
        .to.be.revertedWithCustomError(game, "WrongPhase")
        .withArgs(tableId, Phase.AwaitingPaidProof, Phase.Joining);
    });
  });

  describe("cancel in AwaitingPaidProof", function () {
    it("reverts DeadlineNotPassed before and at the deadline; after it, every seat gets its own transferred back", async function () {
      const tableId = await filledTable([alice, bob, poor]);
      const { deadline } = await game.getTable(tableId);
      await expect(game.cancel(tableId)).to.be.revertedWithCustomError(game, "DeadlineNotPassed");
      await time.setNextBlockTimestamp(deadline);
      await expect(game.cancel(tableId))
        .to.be.revertedWithCustomError(game, "DeadlineNotPassed")
        .withArgs(tableId, deadline);

      const receipt = (await (await game.connect(outsider).cancel(tableId)).wait())!;
      const refunds = receipt.logs
        .map((l) => game.interface.parseLog(l))
        .filter((e) => e?.name === "StakeRefunded")
        .map((e) => e!.args.player);
      expect(refunds).to.deep.eq([alice.address, bob.address, poor.address]);
      expect((await game.getTable(tableId)).phase).to.eq(Phase.Cancelled);
      expect(await chipBalance(token, alice)).to.eq(FAUCET_AMOUNT);
      expect(await chipBalance(token, bob)).to.eq(FAUCET_AMOUNT);
      expect(await chipBalance(token, poor)).to.eq(5n);
      expect(await balanceOfAny(token, gameAddress)).to.eq(0n);
      // The paid check of a cancelled table stays verifiable.
      expect(await game.paidHandles(tableId)).to.have.length(3);
    });

    it("accepts a late paid proof: after the deadline, startGame still works until someone cancels", async function () {
      const tableId = await filledTable([alice, bob]);
      await time.increase(PROOF_TIMEOUT + 10n);
      await startWithProof(game, tableId);
      expect((await game.getTable(tableId)).phase).to.eq(Phase.Bidding);
      await expect(game.cancel(tableId))
        .to.be.revertedWithCustomError(game, "NotCancellable")
        .withArgs(tableId, Phase.Bidding);
    });
  });
});
