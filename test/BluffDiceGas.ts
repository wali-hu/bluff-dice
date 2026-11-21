import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import { expect } from "chai";
import { ContractTransactionReceipt } from "ethers";
import { ethers, fhevm } from "hardhat";

import { BluffChips, BluffDice } from "../types";
import {
  BID_TIMEOUT,
  FUNDED_SIGNERS,
  PROOF_TIMEOUT,
  STAKE,
  TX_GAS_CAP,
  approve,
  createTable,
  deployAll,
  fullTable,
  revealProof,
  startWithProof,
} from "./helpers/fixtures";

/**
 * Gas, HCU and HCU depth of every transaction of a round, for 2, 3 and 4 players.
 *
 * - Heavy transactions are sent with gasLimit = 16,777,216 (EIP-7825 per-transaction cap, enforced on Sepolia
 *   since Fusaka), so an overrun fails here whatever the local hardfork enforces.
 * - "x3.2" is the Phase A factor between Sepolia and mock gas. It was measured on dice ops (FHE ops + ACL
 *   allows); token transfers and multi-signature `checkSignatures` are only estimated with it. Phase D measures
 *   them for real. `startGame` and `finalizeReveal` carry ONE mock KMS signature: lower bounds.
 * - Caveat: mock host contracts are older than Sepolia's; HCU constants match, EVM gas does not.
 */
const HCU_TX_LIMIT = 20_000_000;
const HCU_DEPTH_LIMIT = 5_000_000;
const STOP_THRESHOLD_GAS = 11_000_000n;
const SEPOLIA_FACTOR_X10 = 32n;

/** OZ ERC7984 `_update` for an initialized sender: ge, sub, select, trivial 0, select, add. */
const TOKEN_UPDATE_HCU = 586_032;
/** Game side of a stake pull: trivial encrypt (32) + eq scalar euint64 (83,000) + cast ebool->euint8 (32). */
const PULL_GAME_HCU = 83_064;
/** One die: D6.roll(). */
const DIE_HCU = 507_064;

type Row = { tx: string; players: number | "-"; gas: bigint; hcu: number; depth: number };
const rows: Row[] = [];

function record(tx: string, players: number | "-", receipt: ContractTransactionReceipt): Row {
  const { globalHCU, maxHCUDepth } = fhevm.computeTransactionHCU(receipt);
  const row = { tx, players, gas: receipt.gasUsed, hcu: globalHCU, depth: maxHCUDepth };
  rows.push(row);
  expect(receipt.status).to.eq(1);
  expect(receipt.gasUsed).to.be.lt(TX_GAS_CAP);
  expect((receipt.gasUsed * SEPOLIA_FACTOR_X10) / 10n, `${tx}: x3.2 Sepolia estimate over the cap`).to.be.lt(
    TX_GAS_CAP,
  );
  expect(globalHCU).to.be.lt(HCU_TX_LIMIT);
  expect(maxHCUDepth).to.be.lt(HCU_DEPTH_LIMIT);
  return row;
}

async function send(p: Promise<{ wait: () => Promise<ContractTransactionReceipt | null> }>) {
  return (await (await p).wait())!;
}

describe("BluffDice: gas, HCU and depth of a full round", function () {
  let signers: HardhatEthersSigner[];
  let game: BluffDice;
  let token: BluffChips;
  const cap = { gasLimit: TX_GAS_CAP };

  before(async function () {
    signers = await ethers.getSigners();
  });

  beforeEach(async function () {
    if (!fhevm.isMock) {
      console.warn("This hardhat test suite cannot run on Sepolia Testnet");
      this.skip();
    }
    ({ game, token } = await deployAll());
  });

  after(function () {
    if (rows.length === 0) return;
    console.log(
      "\n      tx                                   | players | gas (mock) | x3.2 Sepolia est. | % of cap | HCU        | HCU depth",
    );
    for (const r of rows) {
      const est = (r.gas * SEPOLIA_FACTOR_X10) / 10n;
      const pct = Number((est * 10_000n) / TX_GAS_CAP) / 100;
      console.log(
        `      ${r.tx.padEnd(36)} | ${String(r.players).padStart(7)} | ${r.gas.toString().padStart(10)} | ` +
          `${est.toString().padStart(17)} | ${pct.toFixed(2).padStart(7)}% | ${r.hcu.toString().padEnd(10)} | ${r.depth}`,
      );
    }
    console.log("");
  });

  for (const n of [2, 3, 4]) {
    it(`${n} players: join, filling join, startGame, callLiar, finalizeReveal with payouts`, async function () {
      const players = signers.slice(0, n);
      const tableId = await game.nextTableId();
      const create = await send(game.connect(players[0]).createTable(STAKE, n, cap));
      let fill: ContractTransactionReceipt | null = null;
      let firstJoin: ContractTransactionReceipt | null = null;
      for (const p of players.slice(1)) {
        fill = await send(game.connect(p).joinTable(tableId, cap));
        firstJoin ??= fill;
      }
      const start = await startWithProof(game, tableId, cap);

      record("createTable (funded)", n, create);
      if (n > 2) record("joinTable (funded, not filling)", n, firstJoin!);
      const fillRow = record("joinTable (filling: paid flags public)", n, fill!);
      const startRow = record("startGame (all paid: 5 dice/player)", n, start);
      expect(create.gasUsed).to.be.gt(0n);
      expect(fhevm.computeTransactionHCU(create).globalHCU).to.eq(TOKEN_UPDATE_HCU + 32 + PULL_GAME_HCU);
      expect(fillRow.hcu).to.eq(TOKEN_UPDATE_HCU + PULL_GAME_HCU);
      expect(startRow.hcu).to.eq(n * 5 * DIE_HCU);
      expect(startRow.depth).to.eq(DIE_HCU);
      expect(start.gasUsed, "above the Phase A stop threshold").to.be.lt(STOP_THRESHOLD_GAS);

      await send(game.connect(players[0]).bid(tableId, 1, 1));
      const liar = await send(game.connect(players[1]).callLiar(tableId, cap));
      const r = await revealProof(game, tableId);
      const fin = await send(game.finalizeReveal(tableId, r.abiEncodedClearValues, r.decryptionProof, cap));
      expect(record("callLiar", n, liar).hcu).to.eq(0);
      // 1 trivial encrypt of the share + (n - 1) token transfers from the game's balance.
      expect(record("finalizeReveal + payouts (1 KMS sig)", n, fin).hcu).to.eq(32 + (n - 1) * TOKEN_UPDATE_HCU);
    });
  }

  it("4 players: claimTurnTimeout with 3 payouts", async function () {
    const { tableId } = await fullTable(game, signers.slice(0, 4));
    await time.increase(BID_TIMEOUT + 1n);
    const receipt = await send(game.claimTurnTimeout(tableId, cap));
    expect(record("claimTurnTimeout + payouts", 4, receipt).hcu).to.eq(32 + 3 * TOKEN_UPDATE_HCU);
  });

  it("4 players: cancel with 4 refunds, in AwaitingPaidProof and in AwaitingReveal", async function () {
    const players = signers.slice(0, 4);
    const paidCheck = await createTable(game, players[0], 4);
    for (const p of players.slice(1)) await send(game.connect(p).joinTable(paidCheck));
    const { tableId: reveal } = await fullTable(game, players);
    await send(game.connect(players[0]).bid(reveal, 1, 1));
    await send(game.connect(players[1]).callLiar(reveal));
    await time.increase(PROOF_TIMEOUT + 1n);

    const a = await send(game.cancel(paidCheck, cap));
    const b = await send(game.cancel(reveal, cap));
    expect(record("cancel (AwaitingPaidProof), 4 refunds", 4, a).hcu).to.eq(4 * TOKEN_UPDATE_HCU);
    expect(record("cancel (AwaitingReveal), 4 refunds", 4, b).hcu).to.eq(4 * TOKEN_UPDATE_HCU);
  });

  it("leaveTable refund, a never-funded join, a startGame that drops a seat, and the faucet", async function () {
    const [alice, bob] = signers;
    const broke = signers[FUNDED_SIGNERS]; // never held chips
    await approve(token, game, broke);

    const id = await createTable(game, alice, 3);
    const leave = await send(game.connect(alice).leaveTable(id, cap));
    expect(record("leaveTable (refund)", 3, leave).hcu).to.eq(TOKEN_UPDATE_HCU);

    const drop = await createTable(game, alice, 3);
    await send(game.connect(bob).joinTable(drop));
    const brokeJoin = await send(game.connect(broke).joinTable(drop, cap));
    // OZ tryDecrease on an uninitialized balance: eq(amount, 0) + trivial 0 replace ge/sub/select.
    record("joinTable (never-funded, filling)", 3, brokeJoin);
    const start = await startWithProof(game, drop, cap);
    expect(record("startGame (one seat dropped)", 3, start).hcu).to.eq(0);

    const fresh = signers[FUNDED_SIGNERS + 1];
    const faucet = await send(token.connect(fresh).faucet(cap));
    record("faucet", "-", faucet);
  });
});
