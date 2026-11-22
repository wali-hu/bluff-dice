import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { expect } from "chai";
import { Wallet } from "ethers";
import { ethers, fhevm } from "hardhat";

import { BluffChips, BluffChips__factory, BluffDice, BluffDice__factory } from "../types";
import {
  BID_TIMEOUT,
  FOREVER,
  Phase,
  STAKE,
  countFace,
  decryptAll,
  paidProof,
  revealProof,
  startWithProof,
} from "./helpers/fixtures";

/**
 * Phase D step 0: can FRESH wallets, each with one faucet claim, sit at one table without `DuplicatePaidHandle`?
 *
 * Handles are deterministic (no nonce), so two pulls collide only when both balances hold nothing but public
 * values. A faucet claim gives every wallet a unique balance handle (each mint chains on the token's supply
 * handle), so faucet wallets never collide. Two public-only balance classes do:
 *   class 1: uninitialized balance (a never-funded wallet);
 *   class 2: the trivial 0 the token writes when a never-funded wallet's pull fails (a dropped never-funded
 *            joiner gets no refund, so every such wallet ends with the same balance handle).
 * Control for class 1 (two never-funded wallets at one table): BluffDiceStake.ts "duplicate paid handles".
 *
 * Every test deploys its own token + game and uses wallets created here (ETH sent by a real transfer).
 */
describe("BluffDice: fresh wallets (Phase D step 0)", function () {
  let owner: HardhatEthersSigner;
  let token: BluffChips;
  let game: BluffDice;
  let gameAddress: string;

  beforeEach(async function () {
    if (!fhevm.isMock) {
      console.warn("This hardhat test suite cannot run on Sepolia Testnet");
      this.skip();
    }
    [owner] = await ethers.getSigners();
    token = await new BluffChips__factory(owner).deploy(owner.address);
    game = await new BluffDice__factory(owner).deploy(await token.getAddress(), BID_TIMEOUT);
    gameAddress = await game.getAddress();
  });

  /** A new wallet with 1 ETH (real transfer), no chips, no approval. */
  async function freshWallet(): Promise<Wallet> {
    const w = new Wallet(ethers.hexlify(ethers.randomBytes(32)), ethers.provider);
    await (await owner.sendTransaction({ to: w.address, value: ethers.parseEther("1") })).wait();
    return w;
  }

  async function claimAndApprove(w: Wallet, claim: boolean = true): Promise<void> {
    if (claim) await (await token.connect(w).faucet()).wait();
    await (await token.connect(w).setOperator(gameAddress, FOREVER)).wait();
  }

  /** Creates a table with `players[0]` and joins the rest in order. Returns the table id. */
  async function seat(players: Wallet[], stake: bigint = STAKE): Promise<bigint> {
    const tableId = await game.nextTableId();
    await (await game.connect(players[0]).createTable(stake, players.length)).wait();
    for (const p of players.slice(1)) await (await game.connect(p).joinTable(tableId)).wait();
    return tableId;
  }

  async function expectStartsWithEveryonePaid(tableId: bigint, n: number): Promise<void> {
    const handles = [...(await game.paidHandles(tableId))];
    expect(new Set(handles).size, "paid handles distinct").to.eq(n);
    const proof = await paidProof(game, tableId);
    expect(Object.values(proof.clearValues)).to.deep.eq(Array(n).fill(1n));
    await startWithProof(game, tableId);
    expect((await game.getTable(tableId)).phase).to.eq(Phase.Bidding);
  }

  /** Bids the true count of face 1 from seat 0, seat 1 calls Liar, anyone finalizes. */
  async function finishRound(tableId: bigint, players: Wallet[]): Promise<void> {
    const count = countFace(await decryptAll(game, tableId), 1);
    await (await game.connect(players[0]).bid(tableId, Math.max(count, 1), 1)).wait();
    await (await game.connect(players[1]).callLiar(tableId)).wait();
    const r = await revealProof(game, tableId);
    await (await game.finalizeReveal(tableId, r.abiEncodedClearValues, r.decryptionProof)).wait();
    expect((await game.getTable(tableId)).phase).to.eq(Phase.Settled);
  }

  it("2 fresh wallets with one faucet claim each fill a 2p table: distinct paid handles, game starts", async function () {
    const players = [await freshWallet(), await freshWallet()];
    for (const p of players) await claimAndApprove(p);
    const tableId = await seat(players);
    await expectStartsWithEveryonePaid(tableId, 2);
  });

  it("4 fresh wallets (one is the token's very first minter) fill a 4p table", async function () {
    const players: Wallet[] = [];
    for (let i = 0; i < 4; ++i) players.push(await freshWallet());
    // players[0]'s faucet is the token's first mint ever (fresh token, nothing minted before).
    for (const p of players) await claimAndApprove(p);
    const tableId = await seat(players);
    await expectStartsWithEveryonePaid(tableId, 4);
  });

  it("the same 4 wallets join a new table after a finished round without a collision", async function () {
    const players: Wallet[] = [];
    for (let i = 0; i < 4; ++i) players.push(await freshWallet());
    for (const p of players) await claimAndApprove(p);
    const first = await seat(players);
    await expectStartsWithEveryonePaid(first, 4);
    await finishRound(first, players);
    // Winners got paid, the loser lost the stake: every balance moved. All still hold >= STAKE.
    const second = await seat(players);
    await expectStartsWithEveryonePaid(second, 4);
  });

  it("two DROPPED never-funded wallets collide at a new table (trivial-0 class): DuplicatePaidHandle", async function () {
    const funded = [await freshWallet(), await freshWallet(), await freshWallet()];
    for (const f of funded) await claimAndApprove(f);
    const broke = [await freshWallet(), await freshWallet()];
    for (const b of broke) await claimAndApprove(b, false);

    // Each never-funded wallet is dropped from its own table (two at one table would already collide).
    for (let i = 0; i < 2; ++i) {
      const tableId = await seat([funded[i], broke[i]]);
      await startWithProof(game, tableId);
      expect(await game.dropped(tableId, broke[i].address)).to.eq(true);
    }
    // Both balances are now the same trivially encrypted 0 handle.
    const [b0, b1] = [
      await token.confidentialBalanceOf(broke[0].address),
      await token.confidentialBalanceOf(broke[1].address),
    ];
    expect(b0).to.not.eq(ethers.ZeroHash);
    expect(b0).to.eq(b1);

    const tableId = await game.nextTableId();
    await (await game.connect(funded[2]).createTable(STAKE, 3)).wait();
    await (await game.connect(broke[0]).joinTable(tableId)).wait();
    await expect(game.connect(broke[1]).joinTable(tableId))
      .to.be.revertedWithCustomError(game, "DuplicatePaidHandle")
      .withArgs(2);
  });

  it("one never-funded and one dropped never-funded wallet at one table do not collide (different classes)", async function () {
    const funded = [await freshWallet(), await freshWallet()];
    for (const f of funded) await claimAndApprove(f);
    const dropped = await freshWallet();
    const neverFunded = await freshWallet();
    await claimAndApprove(dropped, false);
    await claimAndApprove(neverFunded, false);

    const first = await seat([funded[0], dropped]);
    await startWithProof(game, first);
    expect(await game.dropped(first, dropped.address)).to.eq(true);
    expect(await token.confidentialBalanceOf(neverFunded.address)).to.eq(ethers.ZeroHash);

    const tableId = await seat([funded[1], dropped, neverFunded]);
    const handles = [...(await game.paidHandles(tableId))];
    expect(new Set(handles).size).to.eq(3);
    // Both pay nothing: the paid check drops them and the table goes back to Joining.
    await startWithProof(game, tableId);
    const t = await game.getTable(tableId);
    expect(t.phase).to.eq(Phase.Joining);
    expect(t.playerCount).to.eq(1);
  });
});
