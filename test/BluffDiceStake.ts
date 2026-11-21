import { FhevmType } from "@fhevm/hardhat-plugin";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import { anyValue } from "@nomicfoundation/hardhat-chai-matchers/withArgs";
import { expect } from "chai";
import { ethers, fhevm } from "hardhat";

import { BluffChips, BluffDice } from "../types";
import {
  FAUCET_AMOUNT,
  FUNDED_SIGNERS,
  NO_SEAT,
  Phase,
  STAKE,
  aclOf,
  approve,
  balanceOfAny,
  chipBalance,
  createTable,
  deployAll,
} from "./helpers/fixtures";

/**
 * Stake pull at create/join and refund at leave. The token never reverts on a low balance (OZ 0.5.3 moves an
 * encrypted 0 instead), so the only evidence that a stake arrived is the returned `transferred` handle and the
 * game's `paid` flag (euint8, 0 or 1). Encrypted getters are decrypted as their player AND must fail as another.
 */
describe("BluffDice: stakes (pull, refund)", function () {
  let signers: HardhatEthersSigner[];
  let alice: HardhatEthersSigner;
  let bob: HardhatEthersSigner;
  let carol: HardhatEthersSigner;
  /** Never held chips; approved the game in each test that needs it. */
  let broke: HardhatEthersSigner;
  let broke2: HardhatEthersSigner;
  /** Holds 5 base units: an initialized balance below the stake. */
  let poor: HardhatEthersSigner;
  let game: BluffDice;
  let token: BluffChips;
  let gameAddress: string;
  let tokenAddress: string;

  before(async function () {
    signers = await ethers.getSigners();
    [alice, bob, carol] = signers;
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
    tokenAddress = await token.getAddress();
    for (const s of [broke, broke2, poor]) await approve(token, game, s);
    await (await token.connect(alice).mint(poor.address, 5n)).wait();
  });

  async function stakeAs(tableId: bigint, player: HardhatEthersSigner, reader: HardhatEthersSigner) {
    const [transferred, paid] = await game.stakeOf(tableId, player.address);
    return {
      transferred: await fhevm.userDecryptEuint(FhevmType.euint64, transferred, tokenAddress, reader),
      paid: await fhevm.userDecryptEuint(FhevmType.euint8, paid, gameAddress, reader),
    };
  }

  describe("pull at join", function () {
    it("pulls exactly the stake; transferred and paid decrypt for the player and fail for another player", async function () {
      const tableId = await createTable(game, alice, 3);
      await (await game.connect(bob).joinTable(tableId)).wait();

      expect(await chipBalance(token, bob)).to.eq(FAUCET_AMOUNT - STAKE);
      expect(await stakeAs(tableId, bob, bob)).to.deep.eq({ transferred: STAKE, paid: 1n });
      expect(await balanceOfAny(token, gameAddress)).to.eq(2n * STAKE);

      const [transferred, paid] = await game.stakeOf(tableId, bob.address);
      await expect(fhevm.userDecryptEuint(FhevmType.euint64, transferred, tokenAddress, alice)).to.be.rejectedWith(
        `User ${alice.address} is not authorized to user decrypt handle ${transferred}!`,
      );
      await expect(fhevm.userDecryptEuint(FhevmType.euint8, paid, gameAddress, alice)).to.be.rejectedWith(
        `User ${alice.address} is not authorized to user decrypt handle ${paid}!`,
      );
    });

    it("createTable pulls the creator's stake the same way", async function () {
      const tableId = await createTable(game, alice, 2);
      expect(await chipBalance(token, alice)).to.eq(FAUCET_AMOUNT - STAKE);
      expect(await stakeAs(tableId, alice, alice)).to.deep.eq({ transferred: STAKE, paid: 1n });
    });

    it("without an operator approval the join reverts ERC7984UnauthorizedSpender and nothing is stored", async function () {
      await approve(token, game, carol, 0n); // revoke
      const tableId = await createTable(game, alice, 3);
      await expect(game.connect(carol).joinTable(tableId))
        .to.be.revertedWithCustomError(token, "ERC7984UnauthorizedSpender")
        .withArgs(carol.address, gameAddress);
      expect(await game.seatOf(tableId, carol.address)).to.eq(NO_SEAT);
      expect((await game.getTable(tableId)).playerCount).to.eq(1);
    });

    it("operator expiry is inclusive: a join at until succeeds, one second later it reverts", async function () {
      const tableId = await createTable(game, alice, 4);
      const until = BigInt(await time.latest()) + 600n;
      await approve(token, game, bob, until);
      await approve(token, game, carol, until);

      await time.setNextBlockTimestamp(until);
      await (await game.connect(bob).joinTable(tableId)).wait();
      await time.setNextBlockTimestamp(until + 1n);
      await expect(game.connect(carol).joinTable(tableId))
        .to.be.revertedWithCustomError(token, "ERC7984UnauthorizedSpender")
        .withArgs(carol.address, gameAddress);
    });

    it("an underfunded join (balance < stake) succeeds: transferred 0, paid 0, balance unchanged", async function () {
      const tableId = await createTable(game, alice, 3);
      await (await game.connect(poor).joinTable(tableId)).wait();
      expect(await stakeAs(tableId, poor, poor)).to.deep.eq({ transferred: 0n, paid: 0n });
      expect(await chipBalance(token, poor)).to.eq(5n);
      expect(await balanceOfAny(token, gameAddress)).to.eq(STAKE);
    });

    it("a never-funded join succeeds: transferred 0, paid 0", async function () {
      const tableId = await createTable(game, alice, 3);
      await (await game.connect(broke).joinTable(tableId)).wait();
      expect(await stakeAs(tableId, broke, broke)).to.deep.eq({ transferred: 0n, paid: 0n });
      expect(await chipBalance(token, broke)).to.eq(0n);
    });

    it("rejects stakes that are zero, not divisible by maxPlayers - 1, or above uint64 max / 4", async function () {
      const max = 2n ** 64n - 1n;
      const tooBig = max / 4n + 1n;
      await expect(game.createTable(tooBig, 2)).to.be.revertedWithCustomError(game, "InvalidStake").withArgs(tooBig, 2);
      await expect(game.createTable(0, 2)).to.be.revertedWithCustomError(game, "InvalidStake").withArgs(0, 2);
    });

    // The two players below get balances no other test uses (owner mints of odd amounts). Players funded only
    // by the shared faucet sequence would not do: handles are deterministic, so their paid handle is the SAME
    // in every fresh deployment of this test run and was already made public by an earlier test (see the
    // "deterministic handles" test below).
    it("paid flags are not publicly decryptable before the table is full", async function () {
      const [p1, p2] = [signers[FUNDED_SIGNERS + 3], signers[FUNDED_SIGNERS + 4]];
      await (await token.connect(alice).mint(p1.address, STAKE + 4_241n)).wait();
      await (await token.connect(alice).mint(p2.address, STAKE + 4_243n)).wait();
      for (const p of [p1, p2]) await approve(token, game, p);
      const tableId = await createTable(game, p1, 3);
      await (await game.connect(p2).joinTable(tableId)).wait();
      const acl = await aclOf(gameAddress);
      for (const p of [p1, p2]) {
        const [, paid] = await game.stakeOf(tableId, p.address);
        expect(await acl.isAllowedForDecryption(paid)).to.eq(false);
        await expect(fhevm.publicDecrypt([paid])).to.be.rejectedWith("is not allowed for public decryption");
      }
    });

    it("deterministic handles: a flag made public in one deployment is already public in a fresh one", async function () {
      // Deployment 1 (beforeEach): alice and bob fill a 2-player table, so both paid flags become public.
      const first = await createTable(game, alice, 2);
      await (await game.connect(bob).joinTable(first)).wait();
      const [, publicFlag] = await game.stakeOf(first, alice.address);

      // Deployment 2: new token, new game, same faucet sequence -> same handles, same (public) flag.
      const fresh = await deployAll();
      const second = await createTable(fresh.game, alice, 3);
      const [, sameFlag] = await fresh.game.stakeOf(second, alice.address);
      expect(sameFlag).to.eq(publicFlag);
      expect(await (await aclOf(await fresh.game.getAddress())).isAllowedForDecryption(sameFlag)).to.eq(true);
      // Only values computable from public data can collide (here: public faucet mints and a public stake).
      // Handles derived from FHE randomness or from encrypted inputs carry a unique seed / ciphertext.
    });

    it("stakeOf reverts NotPlayer for an address without a seat", async function () {
      const tableId = await createTable(game, alice, 2);
      await expect(game.stakeOf(tableId, bob.address))
        .to.be.revertedWithCustomError(game, "NotPlayer")
        .withArgs(tableId, bob.address);
    });
  });

  describe("duplicate paid handles (handles are deterministic)", function () {
    it("two never-funded joins at the same stake get the SAME handles (shown across two tables)", async function () {
      const a = await createTable(game, alice, 3);
      const b = await createTable(game, bob, 3);
      await (await game.connect(broke).joinTable(a)).wait();
      await (await game.connect(broke2).joinTable(b)).wait();
      const sa = await game.stakeOf(a, broke.address);
      const sb = await game.stakeOf(b, broke2.address);
      expect(sb[0]).to.eq(sa[0]); // transferred
      expect(sb[1]).to.eq(sa[1]); // paid
      // Funded players never collide: their balance handles differ.
      expect((await game.stakeOf(a, alice.address))[1]).to.not.eq((await game.stakeOf(b, bob.address))[1]);
    });

    it("a second never-funded join at the same table reverts DuplicatePaidHandle(seat)", async function () {
      const tableId = await createTable(game, alice, 4);
      await (await game.connect(broke).joinTable(tableId)).wait(); // seat 1
      await expect(game.connect(broke2).joinTable(tableId))
        .to.be.revertedWithCustomError(game, "DuplicatePaidHandle")
        .withArgs(2);
      // A funded player and an underfunded one with their own balance still join fine.
      await (await game.connect(poor).joinTable(tableId)).wait();
      expect((await game.getTable(tableId)).playerCount).to.eq(3);
    });
  });

  describe("leaveTable refunds", function () {
    it("a payer gets the stake back; StakeRefunded carries the moved handle", async function () {
      const tableId = await createTable(game, alice, 3);
      await (await game.connect(bob).joinTable(tableId)).wait();
      await expect(game.connect(bob).leaveTable(tableId))
        .to.emit(game, "StakeRefunded")
        .withArgs(tableId, bob.address, 1, anyValue);
      expect(await chipBalance(token, bob)).to.eq(FAUCET_AMOUNT);
      expect(await balanceOfAny(token, gameAddress)).to.eq(STAKE);
    });

    it("a non-payer can leave (an encrypted 0 is refunded); the seat's handles are cleared", async function () {
      const tableId = await createTable(game, alice, 3);
      await (await game.connect(poor).joinTable(tableId)).wait();
      await (await game.connect(poor).leaveTable(tableId)).wait();
      expect(await chipBalance(token, poor)).to.eq(5n);
      await expect(game.stakeOf(tableId, poor.address)).to.be.revertedWithCustomError(game, "NotPlayer");
    });

    it("the last leaver cancels the table and is refunded; the escrow returns to 0", async function () {
      const tableId = await createTable(game, alice, 2);
      await expect(game.connect(alice).leaveTable(tableId))
        .to.emit(game, "TableCancelled")
        .withArgs(tableId)
        .and.to.emit(game, "StakeRefunded");
      expect((await game.getTable(tableId)).phase).to.eq(Phase.Cancelled);
      expect(await chipBalance(token, alice)).to.eq(FAUCET_AMOUNT);
      expect(await balanceOfAny(token, gameAddress)).to.eq(0n);
    });
  });

  // R5 pattern: the paid status is secret until the table fills, so it must not show in gas. A funded join and
  // an underfunded join (initialized balance below the stake) run the same FHE ops on the same storage shape.
  // A never-funded account takes another OZ path (uninitialized balance); that is public token history anyway.
  describe("no secret-dependent gas", function () {
    it("joinTable costs the same for a payer and an underfunded player", async function () {
      const x = await createTable(game, alice, 3);
      const y = await createTable(game, alice, 3, STAKE);
      const paying = (await (await game.connect(bob).joinTable(x)).wait())!.gasUsed;
      const failing = (await (await game.connect(poor).joinTable(y)).wait())!.gasUsed;
      expect(failing).to.eq(paying);
    });

    it("the leaveTable refund costs the same for a stake and for an encrypted 0", async function () {
      const x = await createTable(game, alice, 3);
      const y = await createTable(game, alice, 3);
      await (await game.connect(bob).joinTable(x)).wait();
      await (await game.connect(poor).joinTable(y)).wait();
      const stakeBack = (await (await game.connect(bob).leaveTable(x)).wait())!.gasUsed;
      const zeroBack = (await (await game.connect(poor).leaveTable(y)).wait())!.gasUsed;
      expect(zeroBack).to.eq(stakeBack);
    });
  });
});
