import { expect } from "chai";
import { ethers, fhevm } from "hardhat";

import { BluffDice } from "../types";
import { TX_GAS_CAP, createTable, deployGame, fullTable, revealProof } from "./helpers/fixtures";

/**
 * Cost of the game start (the filling join rolls every die) for 2, 3 and 4 players.
 *
 * - The filling join is sent with gasLimit = 16,777,216 (EIP-7825 per-transaction cap, enforced on Sepolia
 *   since Fusaka), so an overrun fails here whatever the local hardfork enforces.
 * - Stop threshold from the Phase A plan: above ~11M gas for 4 players, report before switching to 3 dice
 *   (wallets pad estimates, so the cap must not be approached).
 * - Caveat: mock host contracts are older than Sepolia's; Phase D re-measures on Sepolia.
 */
const HCU_TX_LIMIT = 20_000_000;
const HCU_DEPTH_LIMIT = 5_000_000;
const STOP_THRESHOLD_GAS = 11_000_000n;
const SEPOLIA_BLOCK_GAS_LIMIT = 60_000_000n;

type Row = { players: number; joinGas: bigint; startGas: bigint; hcu: number; depth: number };

describe("BluffDice: gas and HCU of the game start", function () {
  let game: BluffDice;
  const rows: Row[] = [];

  beforeEach(async function () {
    if (!fhevm.isMock) {
      console.warn("This hardhat test suite cannot run on Sepolia Testnet");
      this.skip();
    }
    game = await deployGame();
  });

  after(function () {
    if (rows.length === 0) return;
    console.log("\n      players | normal join gas | filling join gas | % of 16,777,216 cap | HCU        | HCU depth");
    for (const r of rows) {
      const pct = Number((r.startGas * 10_000n) / TX_GAS_CAP) / 100;
      console.log(
        `      ${r.players}       | ${r.joinGas.toString().padStart(15)} | ${r.startGas.toString().padStart(16)} | ` +
          `${pct.toFixed(2).padStart(18)}% | ${r.hcu.toString().padEnd(10)} | ${r.depth}`,
      );
    }
    console.log(`      (Sepolia block gas limit for reference: ${SEPOLIA_BLOCK_GAS_LIMIT})\n`);
  });

  for (const n of [2, 3, 4]) {
    it(`${n} players: the filling join fits the per-tx gas cap and the HCU limits`, async function () {
      const signers = await ethers.getSigners();
      const players = signers.slice(0, n);

      // Baseline: a non-filling join on a separate, larger table (no dice rolled).
      let joinGas = 0n;
      if (n < 4) {
        const other = await createTable(game, signers[10], 4);
        joinGas = (await (await game.connect(signers[11]).joinTable(other)).wait())!.gasUsed;
      } else {
        const other = await createTable(game, signers[10], 3);
        joinGas = (await (await game.connect(signers[11]).joinTable(other)).wait())!.gasUsed;
      }

      const { fillReceipt } = await fullTable(game, players, { gasLimit: TX_GAS_CAP });
      const { globalHCU, maxHCUDepth } = fhevm.computeTransactionHCU(fillReceipt);
      rows.push({ players: n, joinGas, startGas: fillReceipt.gasUsed, hcu: globalHCU, depth: maxHCUDepth });

      expect(fillReceipt.status).to.eq(1);
      expect(globalHCU).to.eq(n * 5 * 507_064);
      expect(globalHCU).to.be.lte(HCU_TX_LIMIT);
      expect(maxHCUDepth).to.be.lte(HCU_DEPTH_LIMIT);
      expect(fillReceipt.gasUsed).to.be.lt(TX_GAS_CAP);
      expect(fillReceipt.gasUsed, "above the Phase A stop threshold: report before switching to 3 dice").to.be.lt(
        STOP_THRESHOLD_GAS,
      );
    });
  }
});

/**
 * Cost of "Liar" and of the reveal for 2, 3 and 4 players. Both are sent with gasLimit = 16,777,216.
 *
 * - `callLiar`: 0 FHE ops, maxPlayers * 5 `makePubliclyDecryptable` ACL calls. Mock gas is multiplied by the
 *   Phase A Sepolia factor x3.2 for an estimate (that factor was measured for FHE ops; ACL calls are a guess).
 * - `finalizeReveal`: 0 FHE ops, one `checkSignatures`. The mock proof carries ONE KMS signature; Sepolia proofs
 *   carry several, so the mock number is a LOWER BOUND only. Phase D measures it on Sepolia.
 */
const SEPOLIA_FACTOR_X10 = 32n;

type RevealRow = { players: number; liarGas: bigint; finalizeGas: bigint };

describe("BluffDice: gas and HCU of callLiar and finalizeReveal", function () {
  let game: BluffDice;
  const rows: RevealRow[] = [];

  beforeEach(async function () {
    if (!fhevm.isMock) {
      console.warn("This hardhat test suite cannot run on Sepolia Testnet");
      this.skip();
    }
    game = await deployGame();
  });

  after(function () {
    if (rows.length === 0) return;
    console.log(
      "\n      players | callLiar gas | x3.2 Sepolia est. | finalizeReveal gas (mock, 1 KMS sig, lower bound)",
    );
    for (const r of rows) {
      const est = (r.liarGas * SEPOLIA_FACTOR_X10) / 10n;
      console.log(
        `      ${r.players}       | ${r.liarGas.toString().padStart(12)} | ${est.toString().padStart(17)} | ` +
          `${r.finalizeGas.toString().padStart(10)}`,
      );
    }
    console.log("");
  });

  for (const n of [2, 3, 4]) {
    it(`${n} players: callLiar and finalizeReveal use 0 HCU and fit the per-tx gas cap`, async function () {
      const players = (await ethers.getSigners()).slice(0, n);
      const { tableId } = await fullTable(game, players);
      await (await game.connect(players[0]).bid(tableId, 1, 1)).wait();

      const liar = (await (await game.connect(players[1]).callLiar(tableId, { gasLimit: TX_GAS_CAP })).wait())!;
      const r = await revealProof(game, tableId);
      const fin = (await (
        await game.finalizeReveal(tableId, r.abiEncodedClearValues, r.decryptionProof, { gasLimit: TX_GAS_CAP })
      ).wait())!;

      for (const receipt of [liar, fin]) {
        expect(receipt.status).to.eq(1);
        expect(fhevm.computeTransactionHCU(receipt).globalHCU).to.eq(0);
        expect(receipt.gasUsed).to.be.lt(TX_GAS_CAP);
      }
      expect((liar.gasUsed * SEPOLIA_FACTOR_X10) / 10n).to.be.lt(TX_GAS_CAP);
      rows.push({ players: n, liarGas: liar.gasUsed, finalizeGas: fin.gasUsed });
    });
  }
});
