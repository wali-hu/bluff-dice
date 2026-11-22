import fs from "node:fs";

import { expect } from "chai";
import { Wallet } from "ethers";
import hre, { ethers, fhevm } from "hardhat";

import { cancelAfterDeadline, finalizeTable, playRound } from "../scripts/lib/play";
import {
  Ctx,
  TxRow,
  assertNoSecret,
  buildProof,
  checkSigners,
  countNewSlotsMock,
  freshActor,
  kmsDomain,
  kmsVerifier,
  log,
  redact,
  redactedError,
  makeCtx,
  parseProof,
  publicDecryptDigest,
  publicDecryptRetry,
  runJson,
} from "../scripts/lib/round";
import { verifyRound } from "../scripts/lib/verify";
import { BluffChips__factory, BluffDice__factory } from "../types";
import { BID_TIMEOUT, Phase } from "./helpers/fixtures";

/**
 * The Phase D round runner (`scripts/lib/play.ts`), run in mock before it ever touches Sepolia: fresh wallets funded
 * by real ETH transfers, explicit fees, the forced Liar outcomes, the timeout leak check, cancel + refunds, a leave,
 * the never-funded duplicate check, an injected relayer "not ready", the sweep, and verify-round on every table.
 *
 * Set MOCK_GAS_OUT=<file> to write every mined row (mock gas + new storage slots) for the Phase D gas table.
 */
describe("Scripted rounds (Phase D runner, mock)", function () {
  this.timeout(300_000);
  let ctx: Ctx;
  const allRows: TxRow[] = [];

  beforeEach(async function () {
    if (!fhevm.isMock) {
      console.warn("This hardhat test suite cannot run on Sepolia Testnet");
      this.skip();
    }
    const [deployer] = await ethers.getSigners();
    const token = await new BluffChips__factory(deployer).deploy(deployer.address);
    const game = await new BluffDice__factory(deployer).deploy(await token.getAddress(), BID_TIMEOUT);
    ctx = await makeCtx(
      hre,
      { game: await game.getAddress(), token: await token.getAddress() },
      { costCapWei: ethers.parseEther("10") },
    );
  });

  afterEach(function () {
    if (ctx) allRows.push(...ctx.rows);
  });

  after(async function () {
    if (!process.env.MOCK_GAS_OUT) return;
    // Mock gas plus the new storage slots of each transaction (for the inferred EIP-8037 state gas column).
    const out: (TxRow & { newSlots: number })[] = [];
    for (const r of allRows)
      out.push({ ...r, newSlots: r.fn === "transfer" ? 0 : await countNewSlotsMock(hre, r.hash) });
    fs.writeFileSync(process.env.MOCK_GAS_OUT, JSON.stringify(out, null, 2));
  });

  /**
   * Swept down to dust: the sweep uses gasLimit = eth_estimateGas (not a fixed 21,000, because a 7702-delegated
   * deployer runs code on receive), so unused gas stays behind. EDR estimates 25,201 for a 21,000 transfer.
   */
  async function expectSweptToDust(): Promise<void> {
    const dust = ethers.parseEther("0.00001");
    for (const a of ctx.fresh) expect(await ethers.provider.getBalance(a.address), `${a.name} swept`).to.be.lt(dust);
  }

  it("2p, caller loses (bid true); survives one injected relayer not_ready", async function () {
    ctx.faults.notReady = 1;
    const r = await playRound(ctx, { id: "M1", players: 2, outcome: "caller-loses" });
    expect(ctx.faults.notReady).to.eq(0);
    expect(r.status).to.eq("settled");
    expect(r.loserSeat).to.eq(0); // 2p: seat 0 calls Liar on seat 1's true bid
    expect(r.verify?.ok).to.eq(true);
    expect((await ctx.game.getTable(r.tableId)).phase).to.eq(Phase.Settled);
    await expectSweptToDust();
  });

  it("4p, bidder loses (bid false), with a leaver, a never-funded join and the duplicate staticCall", async function () {
    const r = await playRound(ctx, { id: "M2", players: 4, outcome: "bidder-loses", extras: true });
    expect(r.loserSeat).to.eq(1);
    expect(r.duplicateCheck).to.match(/DuplicatePaidHandle/);
    expect(r.verify?.ok).to.eq(true);
    const labels = ctx.rows.map((x) => x.label);
    for (const l of [
      "mint",
      "leaveTable",
      "joinTable (never-funded)",
      "leaveTable (never-funded)",
      "joinTable (filling)",
    ]) {
      expect(labels).to.include(l);
    }
    await expectSweptToDust();
  });

  it("4p, caller loses", async function () {
    const r = await playRound(ctx, { id: "M4", players: 4, outcome: "caller-loses" });
    expect(r.loserSeat).to.eq(2);
    expect(r.verify?.ok).to.eq(true);
  });

  it("2p turn timeout: no die is ever public (ACL + SDK layers), revealHandles reverts LiarNotCalled", async function () {
    const r = await playRound(ctx, { id: "M3", players: 2, outcome: "timeout" });
    expect(r.status).to.eq("timed-out");
    expect(r.loserSeat).to.eq(0);
    expect(r.dice).to.eq(undefined);
    expect(r.leakChecks?.onChain).to.match(/0 of 10 dice public/);
    expect(r.leakChecks?.sdk).to.match(/not allowed for public decryption/);
    expect(r.leakChecks?.revealHandles).to.match(/LiarNotCalled/);
    expect(r.verify?.kind).to.eq("timeout");
    expect(r.verify?.ok).to.eq(true);
  });

  it("2p cancel: nobody starts, anyone cancels after the proof deadline, refunds match the token's handles", async function () {
    const r = await playRound(ctx, { id: "M0", players: 2, outcome: "cancel" });
    expect(r.status).to.eq("awaiting-cancel");
    await expectSweptToDust();
    await cancelAfterDeadline(ctx, r.tableId);
    const v = await verifyRound(ctx, r.tableId);
    expect(v.kind).to.eq("cancelled");
    expect(v.ok, v.lines.join("\n")).to.eq(true);
  });

  it("4p turn timeout (the shape of Sepolia tables R2a / R4a): 20 dice, none public, 3 winners paid", async function () {
    const r = await playRound(ctx, { id: "M7", players: 4, outcome: "timeout" });
    expect(r.loserSeat).to.eq(0);
    expect(r.leakChecks?.onChain).to.match(/0 of 20 dice public/);
    expect(r.verify?.ok).to.eq(true);
  });

  it("4p cancel from AwaitingPaidProof (the shape of Sepolia table R2b): 4 refunds", async function () {
    const r = await playRound(ctx, { id: "M8", players: 4, outcome: "cancel" });
    await cancelAfterDeadline(ctx, r.tableId);
    const v = await verifyRound(ctx, r.tableId);
    expect(v.kind).to.eq("cancelled");
    expect(v.ok, v.lines.join("\n")).to.eq(true);
  });

  it("startGame pushed by someone else while the runner waits (probe path), finalize by finalizeTable", async function () {
    // Same as R1 on Sepolia: the runner pauses after the fill and before the reveal; another caller pushes both.
    const run = playRound(ctx, {
      id: "M1b",
      players: 2,
      outcome: "caller-loses",
      pauseAfterFill: true,
      externalFinalize: true,
    });
    const pusher = await makeCtx(hre, { game: await ctx.game.getAddress(), token: await ctx.token.getAddress() });
    const tableId = 1n;
    for (;;) {
      const t = await ctx.game.nextTableId();
      if (t > tableId && Number((await ctx.game.getTable(tableId)).phase) === Phase.AwaitingPaidProof) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    await finalizeTable(pusher, tableId);
    for (;;) {
      if (Number((await ctx.game.getTable(tableId)).phase) === Phase.AwaitingReveal) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    await finalizeTable(pusher, tableId);
    const r = await run;
    expect(r.verify?.ok).to.eq(true);
  });

  it("finalizeTable: DRY_RUN sends nothing; it never cancels; a Cancelled table is left alone", async function () {
    const r = await playRound(ctx, { id: "M5", players: 2, outcome: "cancel" });
    const before = ctx.rows.length;
    expect(await finalizeTable(ctx, r.tableId, { dryRun: true })).to.eq(undefined);
    expect(ctx.rows.length).to.eq(before);
    expect((await ctx.game.getTable(r.tableId)).phase).to.eq(Phase.AwaitingPaidProof);
    await cancelAfterDeadline(ctx, r.tableId);
    expect(await finalizeTable(ctx, r.tableId)).to.eq(undefined);
    expect((await ctx.game.getTable(r.tableId)).phase).to.eq(Phase.Cancelled);
  });

  it("proof parsing and off-chain EIP-712 recovery agree with the KMSVerifier", async function () {
    const r = await playRound(ctx, { id: "M6", players: 2, outcome: "cancel" });
    const handles = [...(await ctx.game.paidHandles(r.tableId))];
    const d = await publicDecryptRetry(ctx, handles);
    const p = parseProof(d.decryptionProof);
    const kms = await kmsVerifier(ctx);
    const known = [...(await kms.getKmsSigners())].map(String);
    const threshold = Number(await kms.getThreshold());
    const digest = publicDecryptDigest(await kmsDomain(kms), handles, d.abiEncodedClearValues, p.extraData);
    expect(checkSigners(digest, p.signatures, known, threshold).verdict).to.eq("accepted");
    expect(buildProof(p.signatures, p.extraData)).to.eq(d.decryptionProof);
    expect(
      await kms.verifyDecryptionEIP712KMSSignatures.staticCall(handles, d.abiEncodedClearValues, d.decryptionProof),
    ).to.eq(true);
  });

  describe("secrets never reach the logger or the run JSON", function () {
    it("runJson rejects keys outside the allow-list", function () {
      expect(() => runJson({ round: "x", privateKey: "0x01" })).to.throw(/not allowed/);
      expect(() => runJson({ txs: [{ hash: "0x", mnemonic: "a b c" }] })).to.throw(/not allowed/);
      expect(() => runJson({ players: [{ address: "0x", key: "0x" }] })).to.throw(/not allowed/);
    });

    it("runJson rejects non-plain objects (a wallet object never serializes)", function () {
      const a = freshActor(ctx, "x");
      expect(() => runJson({ notes: a.signer as unknown as Record<string, unknown> })).to.throw(/not plain data/);
    });

    it("a fresh wallet's key in any allowed field is refused; in a log line or an error it is redacted", function () {
      const a = freshActor(ctx, "y");
      const key = (a.signer as Wallet).privateKey;
      expect(() => runJson({ notes: `oops ${key}` })).to.throw(/private key/);
      expect(() => runJson({ result: { nested: [key.toUpperCase().replace("0X", "")] } })).to.throw(/private key/);
      // log() never throws (a throwing logger could abort a sweep and strand funds): it redacts.
      expect(() => log(`k=${key}`)).to.not.throw();
      const red = redact(`k=${key} K=${key.toUpperCase().slice(2)}`);
      expect(red).to.eq("k=[redacted] K=[redacted]");
      // Redaction happens before truncation, so a cut key cannot slip through.
      expect(redactedError(new Error(`sdk said ${key}`)).message.slice(0, 20)).to.not.include(key.slice(2, 12));
      expect(() => assertNoSecret(a.address)).to.not.throw();
    });
  });
});
