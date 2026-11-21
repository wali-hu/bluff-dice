import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import { expect } from "chai";
import { ethers, fhevm } from "hardhat";

import { BluffDice } from "../types";
import {
  BID_TIMEOUT,
  DICE_PER_PLAYER,
  NO_SEAT,
  Phase,
  STAKE,
  createTable,
  PROOF_TIMEOUT,
  deployGame,
  fullTable,
  startWithProof,
} from "./helpers/fixtures";

describe("BluffDice: tables, bids, timeout", function () {
  let signers: HardhatEthersSigner[];
  let game: BluffDice;

  before(async function () {
    signers = await ethers.getSigners();
  });

  beforeEach(async function () {
    if (!fhevm.isMock) {
      console.warn("This hardhat test suite cannot run on Sepolia Testnet");
      this.skip();
    }
    game = await deployGame();
  });

  describe("constructor", function () {
    it("stores the bid timeout", async function () {
      expect(await game.BID_TIMEOUT()).to.eq(BID_TIMEOUT);
    });

    it("reverts on a zero bid timeout", async function () {
      const factory = await ethers.getContractFactory("BluffDice");
      await expect(factory.deploy(await game.TOKEN(), 0)).to.be.revertedWithCustomError(game, "InvalidBidTimeout");
    });

    it("reverts InvalidToken on a zero token address", async function () {
      const factory = await ethers.getContractFactory("BluffDice");
      await expect(factory.deploy(ethers.ZeroAddress, BID_TIMEOUT)).to.be.revertedWithCustomError(game, "InvalidToken");
    });
  });

  describe("createTable", function () {
    it("creates tables with increasing ids starting at 1 and seats the creator at seat 0", async function () {
      const [alice, bob] = signers;
      await expect(game.connect(alice).createTable(STAKE, 3))
        .to.emit(game, "TableCreated")
        .withArgs(1n, alice.address, STAKE, 3)
        .and.to.emit(game, "PlayerJoined")
        .withArgs(1n, alice.address, 0);
      await expect(game.connect(bob).createTable(STAKE, 2))
        .to.emit(game, "TableCreated")
        .withArgs(2n, bob.address, STAKE, 2);

      const t = await game.getTable(1n);
      expect(t.phase).to.eq(Phase.Joining);
      expect(t.maxPlayers).to.eq(3);
      expect(t.playerCount).to.eq(1);
      expect(t.stake).to.eq(STAKE);
      expect(t.round).to.eq(0);
      expect(t.turnSeat).to.eq(NO_SEAT);
      expect(t.bidderSeat).to.eq(NO_SEAT);
      expect(t.liarCallerSeat).to.eq(NO_SEAT);
      expect(t.loserSeat).to.eq(NO_SEAT);
      expect(t.players[0]).to.eq(alice.address);
      expect(await game.seatOf(1n, alice.address)).to.eq(0);
      expect(await game.nextTableId()).to.eq(3n);
    });

    for (const maxPlayers of [0, 1, 5]) {
      it(`reverts InvalidMaxPlayers for maxPlayers = ${maxPlayers}`, async function () {
        await expect(game.createTable(STAKE, maxPlayers))
          .to.be.revertedWithCustomError(game, "InvalidMaxPlayers")
          .withArgs(maxPlayers);
      });
    }

    it("reverts InvalidStake for a zero stake", async function () {
      await expect(game.createTable(0, 2)).to.be.revertedWithCustomError(game, "InvalidStake").withArgs(0, 2);
    });

    it("reverts InvalidStake when the stake does not split evenly between maxPlayers - 1 winners", async function () {
      await expect(game.createTable(601, 4)).to.be.revertedWithCustomError(game, "InvalidStake").withArgs(601, 4);
      await expect(game.createTable(601, 3)).to.be.revertedWithCustomError(game, "InvalidStake").withArgs(601, 3);
      await expect(game.createTable(601, 2)).to.not.be.reverted; // n - 1 = 1 always divides
      await expect(game.createTable(603, 4)).to.not.be.reverted;
    });
  });

  describe("joinTable", function () {
    it("seats players in order and emits PlayerJoined", async function () {
      const [alice, bob, carol] = signers;
      const tableId = await createTable(game, alice, 4);
      await expect(game.connect(bob).joinTable(tableId))
        .to.emit(game, "PlayerJoined")
        .withArgs(tableId, bob.address, 1);
      await expect(game.connect(carol).joinTable(tableId))
        .to.emit(game, "PlayerJoined")
        .withArgs(tableId, carol.address, 2);
      const t = await game.getTable(tableId);
      expect(t.playerCount).to.eq(3);
      expect(t.phase).to.eq(Phase.Joining);
    });

    it("reverts for an unknown table", async function () {
      await expect(game.joinTable(42n)).to.be.revertedWithCustomError(game, "TableNotFound").withArgs(42n);
      await expect(game.joinTable(0n)).to.be.revertedWithCustomError(game, "TableNotFound").withArgs(0n);
    });

    it("reverts AlreadySeated on a double join", async function () {
      const [alice] = signers;
      const tableId = await createTable(game, alice, 3);
      await expect(game.connect(alice).joinTable(tableId))
        .to.be.revertedWithCustomError(game, "AlreadySeated")
        .withArgs(tableId, alice.address);
    });

    it("reverts WrongPhase once the table is full (already Bidding)", async function () {
      const { tableId } = await fullTable(game, signers.slice(0, 2));
      await expect(game.connect(signers[2]).joinTable(tableId))
        .to.be.revertedWithCustomError(game, "WrongPhase")
        .withArgs(tableId, Phase.Joining, Phase.Bidding);
    });

    for (const n of [2, 3, 4]) {
      it(`the filling join of a ${n}-player table requests the paid check; startGame then starts the game`, async function () {
        const players = signers.slice(0, n);
        const tableId = await createTable(game, players[0], n);
        for (const p of players.slice(1, -1)) await game.connect(p).joinTable(tableId);

        // Phase C: the filling join no longer rolls dice, it makes the paid flags public.
        const fill = await game.connect(players[n - 1]).joinTable(tableId);
        await fill.wait();
        const filledAt = BigInt(await time.latest());
        await expect(fill)
          .to.emit(game, "PaidCheckRequested")
          .withArgs(tableId, filledAt + PROOF_TIMEOUT)
          .and.not.to.emit(game, "GameStarted");
        expect((await game.getTable(tableId)).phase).to.eq(Phase.AwaitingPaidProof);

        const receipt = await startWithProof(game, tableId);
        const now = BigInt(await time.latest());
        const started = receipt.logs.map((l) => game.interface.parseLog(l)).find((e) => e?.name === "GameStarted");
        expect(started?.args).to.deep.eq([tableId, 1n, 0n, now + BID_TIMEOUT]);

        const t = await game.getTable(tableId);
        expect(t.phase).to.eq(Phase.Bidding);
        expect(t.round).to.eq(1);
        expect(t.turnSeat).to.eq(0);
        expect(t.deadline).to.eq(now + BID_TIMEOUT);
        expect(t.playerCount).to.eq(n);
      });
    }

    it("returns zero dice handles for every seated player before the table fills", async function () {
      const [alice, bob] = signers;
      const tableId = await createTable(game, alice, 3);
      await game.connect(bob).joinTable(tableId);
      for (const p of [alice, bob]) {
        const dice = await game.diceOf(tableId, p.address);
        expect(dice).to.have.length(DICE_PER_PLAYER);
        for (const h of dice) expect(h).to.eq(ethers.ZeroHash);
      }
    });
  });

  describe("leaveTable", function () {
    it("frees the seat, which the next joiner takes; the game still starts when full", async function () {
      const [alice, bob, carol, dave] = signers;
      const tableId = await createTable(game, alice, 3);
      await game.connect(bob).joinTable(tableId);

      await expect(game.connect(bob).leaveTable(tableId)).to.emit(game, "PlayerLeft").withArgs(tableId, bob.address, 1);
      expect(await game.seatOf(tableId, bob.address)).to.eq(NO_SEAT);
      expect((await game.getTable(tableId)).playerCount).to.eq(1);

      await expect(game.connect(carol).joinTable(tableId))
        .to.emit(game, "PlayerJoined")
        .withArgs(tableId, carol.address, 1);
      await expect(game.connect(dave).joinTable(tableId)).to.emit(game, "PaidCheckRequested");
    });

    it("lets the creator leave; seat 0 reopens and its new owner bids first", async function () {
      const [alice, bob, carol] = signers;
      const tableId = await createTable(game, alice, 3);
      await game.connect(bob).joinTable(tableId);
      await game.connect(alice).leaveTable(tableId);
      await game.connect(carol).joinTable(tableId); // takes seat 0
      expect(await game.seatOf(tableId, carol.address)).to.eq(0);
      await game.connect(alice).joinTable(tableId); // fills the table at seat 2
      expect(await game.seatOf(tableId, alice.address)).to.eq(2);
      await startWithProof(game, tableId);
      const t = await game.getTable(tableId);
      expect(t.phase).to.eq(Phase.Bidding);
      expect(t.players[t.turnSeat]).to.eq(carol.address);
    });

    it("cancels the table when the last player leaves", async function () {
      const [alice] = signers;
      const tableId = await createTable(game, alice, 2);
      await expect(game.connect(alice).leaveTable(tableId))
        .to.emit(game, "PlayerLeft")
        .withArgs(tableId, alice.address, 0)
        .and.to.emit(game, "TableCancelled")
        .withArgs(tableId);
      expect((await game.getTable(tableId)).phase).to.eq(Phase.Cancelled);
      await expect(game.connect(signers[1]).joinTable(tableId))
        .to.be.revertedWithCustomError(game, "WrongPhase")
        .withArgs(tableId, Phase.Joining, Phase.Cancelled);
    });

    it("reverts NotPlayer for an address without a seat", async function () {
      const tableId = await createTable(game, signers[0], 2);
      await expect(game.connect(signers[1]).leaveTable(tableId))
        .to.be.revertedWithCustomError(game, "NotPlayer")
        .withArgs(tableId, signers[1].address);
    });

    it("reverts WrongPhase once the dice are rolled (no selective abort)", async function () {
      const { tableId } = await fullTable(game, signers.slice(0, 2));
      await expect(game.connect(signers[0]).leaveTable(tableId))
        .to.be.revertedWithCustomError(game, "WrongPhase")
        .withArgs(tableId, Phase.Joining, Phase.Bidding);
    });
  });

  describe("bid", function () {
    let players: HardhatEthersSigner[];
    let tableId: bigint;

    async function startTable(n: number) {
      players = signers.slice(0, n);
      ({ tableId } = await fullTable(game, players));
    }

    it("accepts the first bid from seat 0, moves the turn and resets the deadline", async function () {
      await startTable(3);
      await time.increase(100);
      const tx = game.connect(players[0]).bid(tableId, 2, 5);
      await (await tx).wait();
      const now = BigInt(await time.latest());
      await expect(tx)
        .to.emit(game, "BidPlaced")
        .withArgs(tableId, 1, players[0].address, 2, 5, 1, now + BID_TIMEOUT);

      const t = await game.getTable(tableId);
      expect(t.bidQuantity).to.eq(2);
      expect(t.bidFace).to.eq(5);
      expect(t.bidderSeat).to.eq(0);
      expect(t.turnSeat).to.eq(1);
      expect(t.deadline).to.eq(now + BID_TIMEOUT);
    });

    it("reverts NotYourTurn for a seated player out of turn", async function () {
      await startTable(3);
      await expect(game.connect(players[1]).bid(tableId, 1, 1))
        .to.be.revertedWithCustomError(game, "NotYourTurn")
        .withArgs(tableId, players[0].address, players[1].address);
    });

    it("reverts NotPlayer for an outsider", async function () {
      await startTable(2);
      const outsider = signers[9];
      await expect(game.connect(outsider).bid(tableId, 1, 1))
        .to.be.revertedWithCustomError(game, "NotPlayer")
        .withArgs(tableId, outsider.address);
    });

    it("reverts WrongPhase while the table is still Joining", async function () {
      const id = await createTable(game, signers[0], 3);
      await expect(game.connect(signers[0]).bid(id, 1, 1))
        .to.be.revertedWithCustomError(game, "WrongPhase")
        .withArgs(id, Phase.Bidding, Phase.Joining);
    });

    it("reverts InvalidFace for faces 0 and 7", async function () {
      await startTable(2);
      for (const face of [0, 7]) {
        await expect(game.connect(players[0]).bid(tableId, 1, face))
          .to.be.revertedWithCustomError(game, "InvalidFace")
          .withArgs(face);
      }
    });

    it("reverts InvalidQuantity for 0 and players * 5 + 1, accepts players * 5", async function () {
      await startTable(3);
      const max = 3 * DICE_PER_PLAYER;
      await expect(game.connect(players[0]).bid(tableId, 0, 3))
        .to.be.revertedWithCustomError(game, "InvalidQuantity")
        .withArgs(0, max);
      await expect(game.connect(players[0]).bid(tableId, max + 1, 3))
        .to.be.revertedWithCustomError(game, "InvalidQuantity")
        .withArgs(max + 1, max);
      await expect(game.connect(players[0]).bid(tableId, max, 3)).to.emit(game, "BidPlaced");
    });

    it("only accepts bids that raise the previous one", async function () {
      await startTable(2);
      const [a, b] = players;
      await game.connect(a).bid(tableId, 3, 4); // Q = 3, F = 4; b on turn

      for (const [q, f] of [
        [3, 4], // same bid
        [3, 3], // same quantity, lower face
        [2, 6], // lower quantity, higher face
      ]) {
        await expect(game.connect(b).bid(tableId, q, f))
          .to.be.revertedWithCustomError(game, "BidNotHigher")
          .withArgs(3, 4, q, f);
      }

      await expect(game.connect(b).bid(tableId, 3, 5)).to.emit(game, "BidPlaced"); // same Q, higher F
      await expect(game.connect(a).bid(tableId, 4, 1)).to.emit(game, "BidPlaced"); // higher Q, any F
    });

    for (const n of [3, 4]) {
      it(`wraps the turn from the last seat back to seat 0 (${n} players)`, async function () {
        await startTable(n);
        for (let seat = 0; seat < n; seat++) {
          await game.connect(players[seat]).bid(tableId, seat + 1, 2);
        }
        const t = await game.getTable(tableId);
        expect(t.turnSeat).to.eq(0);
        expect(t.bidderSeat).to.eq(n - 1);
      });
    }

    it("accepts a bid exactly at the deadline and reverts TurnExpired after it", async function () {
      await startTable(2);
      const { deadline } = await game.getTable(tableId);
      await time.setNextBlockTimestamp(deadline);
      await expect(game.connect(players[0]).bid(tableId, 1, 1)).to.emit(game, "BidPlaced");

      const next = (await game.getTable(tableId)).deadline;
      await time.setNextBlockTimestamp(next + 1n);
      await expect(game.connect(players[1]).bid(tableId, 2, 1))
        .to.be.revertedWithCustomError(game, "TurnExpired")
        .withArgs(tableId, next);
    });
  });

  describe("claimTurnTimeout", function () {
    it("reverts DeadlineNotPassed before and at the deadline", async function () {
      const { tableId } = await fullTable(game, signers.slice(0, 2));
      const { deadline } = await game.getTable(tableId);
      await expect(game.claimTurnTimeout(tableId))
        .to.be.revertedWithCustomError(game, "DeadlineNotPassed")
        .withArgs(tableId, deadline);
      await time.setNextBlockTimestamp(deadline);
      await expect(game.claimTurnTimeout(tableId))
        .to.be.revertedWithCustomError(game, "DeadlineNotPassed")
        .withArgs(tableId, deadline);
    });

    it("lets an outsider settle: the player on turn loses (very first turn, no bid yet)", async function () {
      const players = signers.slice(0, 3);
      const { tableId } = await fullTable(game, players);
      await time.increase(BID_TIMEOUT + 1n);
      await expect(game.connect(signers[9]).claimTurnTimeout(tableId))
        .to.emit(game, "TurnTimedOut")
        .withArgs(tableId, 1, players[0].address);

      const t = await game.getTable(tableId);
      expect(t.phase).to.eq(Phase.Settled);
      expect(t.loserSeat).to.eq(0);
      expect(t.turnSeat).to.eq(NO_SEAT);
    });

    it("the player on turn after some bids loses", async function () {
      const players = signers.slice(0, 3);
      const { tableId } = await fullTable(game, players);
      await game.connect(players[0]).bid(tableId, 2, 3);
      await game.connect(players[1]).bid(tableId, 2, 4);
      await time.increase(BID_TIMEOUT + 1n);
      await expect(game.claimTurnTimeout(tableId))
        .to.emit(game, "TurnTimedOut")
        .withArgs(tableId, 1, players[2].address);
      expect((await game.getTable(tableId)).loserSeat).to.eq(2);
    });

    it("after Settled, bid and claimTurnTimeout revert WrongPhase", async function () {
      const players = signers.slice(0, 2);
      const { tableId } = await fullTable(game, players);
      await time.increase(BID_TIMEOUT + 1n);
      await game.claimTurnTimeout(tableId);
      await expect(game.connect(players[0]).bid(tableId, 1, 1))
        .to.be.revertedWithCustomError(game, "WrongPhase")
        .withArgs(tableId, Phase.Bidding, Phase.Settled);
      await expect(game.claimTurnTimeout(tableId))
        .to.be.revertedWithCustomError(game, "WrongPhase")
        .withArgs(tableId, Phase.Bidding, Phase.Settled);
    });
  });

  describe("views", function () {
    it("getTable and seatOf revert TableNotFound for an unknown id", async function () {
      await expect(game.getTable(7n)).to.be.revertedWithCustomError(game, "TableNotFound").withArgs(7n);
      await expect(game.seatOf(7n, signers[0].address)).to.be.revertedWithCustomError(game, "TableNotFound");
    });
  });
});
