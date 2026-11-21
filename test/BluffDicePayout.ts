import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import { expect } from "chai";
import { ContractTransactionReceipt } from "ethers";
import { ethers, fhevm } from "hardhat";

import { BluffChips, BluffDice, BluffDice__factory, ReentrantTokenMock } from "../types";
import {
  BID_TIMEOUT,
  FAUCET_AMOUNT,
  FOREVER,
  PROOF_TIMEOUT,
  Phase,
  STAKE,
  balanceOfAny,
  chipBalance,
  countFace,
  createTable,
  decryptAll,
  deployAll,
  fullTable,
  playToLiar,
  revealProof,
  startWithProof,
} from "./helpers/fixtures";

/** `(stake / (n - 1)) * n`: what every non-loser receives. */
function share(n: number): bigint {
  return (STAKE / BigInt(n - 1)) * BigInt(n);
}

function paidWinners(game: BluffDice, receipt: ContractTransactionReceipt): string[] {
  return receipt.logs
    .map((l) => game.interface.parseLog(l))
    .filter((e) => e?.name === "WinningsPaid")
    .map((e) => e!.args.winner as string);
}

/**
 * Payouts (Liar and turn timeout), refunds when a revealed round is cancelled, conservation of the escrow, and
 * the reentrancy guard. Every player starts with FAUCET_AMOUNT chips; balances are user-decrypted as the player.
 */
describe("BluffDice: payouts, refunds and escrow", function () {
  let signers: HardhatEthersSigner[];
  let game: BluffDice;
  let token: BluffChips;
  let gameAddress: string;

  before(async function () {
    signers = await ethers.getSigners();
  });

  beforeEach(async function () {
    if (!fhevm.isMock) {
      console.warn("This hardhat test suite cannot run on Sepolia Testnet");
      this.skip();
    }
    ({ game, token } = await deployAll());
    gameAddress = await game.getAddress();
  });

  async function expectBalances(players: HardhatEthersSigner[], loserSeat: number) {
    const n = players.length;
    for (const [seat, p] of players.entries()) {
      const expected = FAUCET_AMOUNT - STAKE + (seat === loserSeat ? 0n : share(n));
      expect(await chipBalance(token, p), `seat ${seat}`).to.eq(expected);
    }
    expect(await balanceOfAny(token, gameAddress)).to.eq(0n);
  }

  for (const n of [2, 3, 4]) {
    for (const outcome of ["bid-true", "bid-false"] as const) {
      it(`${n} players, ${outcome}: the loser forfeits, every other seat gets n*stake/(n-1)`, async function () {
        const players = signers.slice(0, n);
        const { tableId } = await fullTable(game, players);
        const values = await decryptAll(game, tableId);
        const face = Number(values[0]);
        const count = countFace(values, face);
        const quantity = outcome === "bid-true" ? count : count + 1;
        await playToLiar(game, tableId, players, quantity, face); // seat 0 bids, seat 1 calls

        const r = await revealProof(game, tableId);
        const receipt = (await (
          await game.connect(signers[9]).finalizeReveal(tableId, r.abiEncodedClearValues, r.decryptionProof)
        ).wait())!;
        const loserSeat = outcome === "bid-true" ? 1 : 0;
        expect((await game.getTable(tableId)).loserSeat).to.eq(loserSeat);
        expect(paidWinners(game, receipt)).to.deep.eq(players.filter((_, s) => s !== loserSeat).map((p) => p.address));
        await expect(receipt.hash)
          .to.emit(game, "WinningsPaid")
          .withArgs(tableId, 1, players[loserSeat === 0 ? 1 : 0].address, share(n));
        await expectBalances(players, loserSeat);
      });
    }
  }

  it("a winner's new balance decrypts for the winner only", async function () {
    const players = signers.slice(0, 2);
    const { tableId } = await fullTable(game, players);
    await time.increase(BID_TIMEOUT + 1n);
    await (await game.claimTurnTimeout(tableId)).wait(); // seat 0 was on turn: seat 1 wins
    const h = await token.confidentialBalanceOf(players[1].address);
    await expect(chipBalance(token, players[1], players[0])).to.be.rejectedWith(
      `User ${players[0].address} is not authorized to user decrypt handle ${h}!`,
    );
  });

  it("turn timeout: the player on turn loses, the others are paid the same share", async function () {
    const players = signers.slice(0, 3);
    const { tableId } = await fullTable(game, players);
    await (await game.connect(players[0]).bid(tableId, 1, 1)).wait(); // seat 1 is now on turn
    await time.increase(BID_TIMEOUT + 1n);
    const receipt = (await (await game.connect(signers[9]).claimTurnTimeout(tableId)).wait())!;
    expect(paidWinners(game, receipt)).to.deep.eq([players[0].address, players[2].address]);
    await expectBalances(players, 1);
  });

  it("cancel in AwaitingReveal refunds every stake; the dice stay public", async function () {
    const players = signers.slice(0, 4);
    const { tableId } = await fullTable(game, players);
    await playToLiar(game, tableId, players, 1, 1);
    await time.increase(PROOF_TIMEOUT + 1n);
    await (await game.cancel(tableId)).wait();
    for (const p of players) expect(await chipBalance(token, p)).to.eq(FAUCET_AMOUNT);
    expect(await balanceOfAny(token, gameAddress)).to.eq(0n);
    const [die] = await game.revealHandles(tableId);
    await expect(fhevm.publicDecrypt([die])).to.not.be.rejected;
  });

  it("conservation: with three tables at once the escrow equals the live stakes; it ends at 0", async function () {
    const settled = await fullTable(game, signers.slice(0, 2));
    const cancelled = await createTable(game, signers[2], 2);
    await (await game.connect(signers[3]).joinTable(cancelled)).wait(); // AwaitingPaidProof
    const live = await fullTable(game, signers.slice(4, 7));
    expect(await balanceOfAny(token, gameAddress)).to.eq(7n * STAKE);

    await time.increase(PROOF_TIMEOUT + 1n);
    await (await game.claimTurnTimeout(settled.tableId)).wait();
    await (await game.cancel(cancelled)).wait();
    expect(await balanceOfAny(token, gameAddress)).to.eq(3n * STAKE);

    await (await game.claimTurnTimeout(live.tableId)).wait();
    expect(await balanceOfAny(token, gameAddress)).to.eq(0n);
  });

  it("no second payout: after settlement finalizeReveal, claimTurnTimeout and cancel revert; balances unchanged", async function () {
    const players = signers.slice(0, 2);
    const { tableId } = await fullTable(game, players);
    await playToLiar(game, tableId, players, 1, 1);
    const r = await revealProof(game, tableId);
    await (await game.finalizeReveal(tableId, r.abiEncodedClearValues, r.decryptionProof)).wait();
    const before = [await chipBalance(token, players[0]), await chipBalance(token, players[1])];

    await expect(game.finalizeReveal(tableId, r.abiEncodedClearValues, r.decryptionProof))
      .to.be.revertedWithCustomError(game, "WrongPhase")
      .withArgs(tableId, Phase.AwaitingReveal, Phase.Settled);
    await expect(game.claimTurnTimeout(tableId))
      .to.be.revertedWithCustomError(game, "WrongPhase")
      .withArgs(tableId, Phase.Bidding, Phase.Settled);
    await time.increase(PROOF_TIMEOUT + 1n);
    await expect(game.cancel(tableId))
      .to.be.revertedWithCustomError(game, "NotCancellable")
      .withArgs(tableId, Phase.Settled);
    expect([await chipBalance(token, players[0]), await chipBalance(token, players[1])]).to.deep.eq(before);
  });

  describe("reentrancy guard (hostile token)", function () {
    let hostile: ReentrantTokenMock;
    let victim: BluffDice;
    let players: HardhatEthersSigner[];

    beforeEach(async function () {
      players = signers.slice(0, 2);
      hostile = (await (await ethers.getContractFactory("ReentrantTokenMock")).deploy()) as ReentrantTokenMock;
      await hostile.waitForDeployment();
      const factory = (await ethers.getContractFactory("BluffDice")) as BluffDice__factory;
      victim = (await factory.deploy(await hostile.getAddress(), BID_TIMEOUT)) as BluffDice;
      await victim.waitForDeployment();
      for (const p of players) {
        await (await hostile.mint(p.address, 1_000_000n)).wait();
        await (await hostile.connect(p).setOperator(await victim.getAddress(), FOREVER)).wait();
      }
    });

    async function arm(fn: "joinTable" | "leaveTable" | "claimTurnTimeout" | "cancel", tableId: bigint) {
      await (await hostile.arm(await victim.getAddress(), victim.interface.encodeFunctionData(fn, [tableId]))).wait();
    }

    it("a callback from the token during a pull (joinTable) or a refund (leaveTable) reverts ReentrancyGuardReentrantCall", async function () {
      const tableId = await createTable(victim, players[0], 2);
      await arm("joinTable", tableId);
      await expect(victim.connect(players[1]).joinTable(tableId)).to.be.revertedWithCustomError(
        victim,
        "ReentrancyGuardReentrantCall",
      );
      await arm("leaveTable", tableId);
      await expect(victim.connect(players[0]).leaveTable(tableId)).to.be.revertedWithCustomError(
        victim,
        "ReentrancyGuardReentrantCall",
      );
    });

    it("a callback during a payout (claimTurnTimeout) or the refunds of cancel reverts ReentrancyGuardReentrantCall", async function () {
      const { tableId } = await fullTable(victim, players);
      await time.increase(BID_TIMEOUT + 1n);
      await arm("claimTurnTimeout", tableId);
      await expect(victim.claimTurnTimeout(tableId)).to.be.revertedWithCustomError(
        victim,
        "ReentrancyGuardReentrantCall",
      );
      await (await hostile.disarm()).wait(); // the reverted call left the mock armed

      const other = await createTable(victim, players[0], 2);
      await (await victim.connect(players[1]).joinTable(other)).wait();
      await time.increase(PROOF_TIMEOUT + 1n);
      await arm("cancel", other);
      await expect(victim.cancel(other)).to.be.revertedWithCustomError(victim, "ReentrancyGuardReentrantCall");
    });

    it("control: the same token unarmed plays a whole round", async function () {
      const tableId = await createTable(victim, players[0], 2);
      await (await victim.connect(players[1]).joinTable(tableId)).wait();
      await startWithProof(victim, tableId);
      await time.increase(BID_TIMEOUT + 1n);
      await (await victim.claimTurnTimeout(tableId)).wait();
      expect((await victim.getTable(tableId)).phase).to.eq(Phase.Settled);
    });
  });
});
