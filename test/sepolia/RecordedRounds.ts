import fs from "node:fs";

import { expect } from "chai";
import hre, { ethers, fhevm } from "hardhat";

import { FIXTURE_FILE, Fixture } from "../../scripts/lib/fixture";
import { decodeRevert, kmsVerifier, makeCtx, words } from "../../scripts/lib/round";
import { verifyRound } from "../../scripts/lib/verify";

/**
 * Re-verifies every Phase D Sepolia round from public chain data. Costs 0 ETH and needs only a read RPC:
 *
 *   npx hardhat vars set SEPOLIA_RPC_URL
 *   npm run test:sepolia
 *
 * The tables are Settled or Cancelled, so the KMS checks call the KMSVerifier directly (a game call would return
 * our own WrongPhase first). The fixture check at the bottom also runs in mock: it guards what gets committed.
 */
const fixture = JSON.parse(fs.readFileSync(FIXTURE_FILE, "utf8")) as Fixture;

describe("Recorded Sepolia rounds (Phase D, read-only)", function () {
  this.timeout(600_000);

  describe("on Sepolia", function () {
    before(async function () {
      if (fhevm.isMock) {
        console.warn("This suite reads Sepolia: run it with --network sepolia");
        this.skip();
      }
      await fhevm.initializeCLIApi();
    });

    for (const t of fixture.tables) {
      it(`${t.id} (table ${t.tableId}, ${t.players}p, ${t.outcome.split(" ")[0]}): verify-round passes`, async function () {
        const ctx = await makeCtx(hre, { game: fixture.game, token: fixture.token });
        const report = await verifyRound(ctx, BigInt(t.tableId), { fromBlock: t.fromBlock });
        expect(report.ok, report.lines.join("\n")).to.eq(true);
        expect(report.checks.length).to.be.greaterThan(0);
      });
    }

    it("every recorded tx hash exists on Sepolia and was sent to the game, the token, or created a contract", async function () {
      const allowed = new Set([fixture.game.toLowerCase(), fixture.token.toLowerCase()]);
      const hashes = [...fixture.deployTxs, ...fixture.tables.flatMap((t) => t.txs)].map((x) => x.hash);
      for (const h of hashes) {
        const tx = await ethers.provider.getTransaction(h);
        expect(tx, `${h} not found`).to.not.eq(null);
        if (tx!.to !== null) expect(allowed.has(tx!.to.toLowerCase()), `${h} goes to ${tx!.to}`).to.eq(true);
      }
    });

    it("KMSVerifier, called directly: R1's reveal proof is accepted, a tampered value is rejected", async function () {
      const ctx = await makeCtx(hre, { game: fixture.game, token: fixture.token });
      const r1 = fixture.tables.find((t) => t.id === "R1")!;
      const hash = r1.txs.find((x) => x.label.startsWith("finalizeReveal"))!.hash;
      const tx = (await ethers.provider.getTransaction(hash))!;
      const call = ctx.game.interface.parseTransaction({ data: tx.data })!;
      const handles = [...(await ctx.game.revealHandles(BigInt(r1.tableId)))].map(String);
      const cleartexts = String(call.args.cleartexts);
      const proof = String(call.args.proof);
      const kms = await kmsVerifier(ctx);
      expect(await kms.verifyDecryptionEIP712KMSSignatures.staticCall(handles, cleartexts, proof)).to.eq(true);

      const ws = words(cleartexts);
      const tampered = ethers.concat([ethers.zeroPadValue(ethers.toBeHex(BigInt(ws[0]) ^ 1n), 32), ...ws.slice(1)]);
      let why = "accepted";
      try {
        await kms.verifyDecryptionEIP712KMSSignatures.staticCall(handles, tampered, proof);
      } catch (e) {
        why = decodeRevert(ctx, e);
      }
      expect(why).to.match(/^KMSInvalidSigner/);
    });
  });

  describe("committed fixture holds public data only", function () {
    it("only allowed keys; every hex string is a 20-byte address or a 32-byte tx hash", function () {
      expect(Object.keys(fixture).sort()).to.deep.eq(
        ["bidTimeout", "chainId", "deployBlock", "deployTxs", "game", "tables", "token"].sort(),
      );
      expect(fixture.chainId).to.eq(11155111);
      const hexes = JSON.stringify(fixture).match(/0x[0-9a-fA-F]+/g) ?? [];
      for (const h of hexes) expect([42, 66], h).to.include(h.length);
      const addresses = hexes.filter((h) => h.length === 42);
      expect(new Set(addresses.map((a) => a.toLowerCase()))).to.deep.eq(
        new Set([fixture.game.toLowerCase(), fixture.token.toLowerCase()]),
      );
      for (const t of fixture.tables) {
        expect(Object.keys(t).sort()).to.deep.eq(["fromBlock", "id", "outcome", "players", "tableId", "txs"]);
        for (const x of t.txs) expect(Object.keys(x).sort()).to.deep.eq(["hash", "label"]);
      }
    });
  });
});
