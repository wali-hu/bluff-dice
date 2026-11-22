import path from "node:path";

import { task, types } from "hardhat/config";
import type { HardhatRuntimeEnvironment, TaskArguments } from "hardhat/types";

import { readFixture, recordTable } from "../scripts/lib/fixture";
import { Outcome, cancelAfterDeadline, playRound } from "../scripts/lib/play";
import { Ctx, log, makeCtx, redactedError, sweep } from "../scripts/lib/round";
import { verifyRound } from "../scripts/lib/verify";

/**
 * Scripted functional rounds (Phase D). One operator funds and controls every seat and reads every die: these
 * rounds prove the contracts, the relayer and the KMS end to end; they are not fair games.
 *
 *   npx hardhat --network sepolia task:play-round --id R1 --players 2 --outcome caller-loses --pause-after-fill --external-finalize
 *   npx hardhat --network sepolia task:play-round --id R2 --players 4 --outcome bidder-loses --extras
 *   npx hardhat --network sepolia task:play-round --id R3 --players 2 --outcome timeout
 *   npx hardhat --network sepolia task:play-round --id R0 --players 2 --outcome cancel
 *   npx hardhat --network sepolia task:cancel-table --id R0 --table <tableId>
 *
 * Addresses come from the committed fixture `test/sepolia/recorded-rounds.json` on Sepolia (never from whatever
 * hardhat-deploy deployed last); on the in-process hardhat network a fresh token + game is deployed.
 * Fresh player keys stay in memory; on Ctrl-C every fresh wallet is swept back to the deployer before exit.
 */

/** Rethrows any task error with every registered secret removed (Hardhat prints uncaught errors in full). */
function safe(
  action: (args: TaskArguments, hre: HardhatRuntimeEnvironment) => Promise<void>,
): (args: TaskArguments, hre: HardhatRuntimeEnvironment) => Promise<void> {
  return async (args, hre) => {
    try {
      await action(args, hre);
    } catch (e) {
      throw redactedError(e);
    }
  };
}

const RUNS_DIR = path.join(__dirname, "..", "docs", "runs", "phase-d");

async function contextFor(hre: HardhatRuntimeEnvironment, costCapEth?: string): Promise<Ctx> {
  const { ethers, fhevm, network } = hre;
  await fhevm.initializeCLIApi();
  const costCapWei = costCapEth ? ethers.parseEther(costCapEth) : undefined;
  if (network.name === "hardhat") {
    const [deployer] = await ethers.getSigners();
    const token = await (await ethers.getContractFactory("BluffChips")).deploy(deployer.address);
    const game = await (await ethers.getContractFactory("BluffDice")).deploy(await token.getAddress(), 300);
    return makeCtx(hre, { game: await game.getAddress(), token: await token.getAddress() }, { costCapWei });
  }
  const f = readFixture();
  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  if (!f || f.chainId !== chainId)
    throw new Error(`no recorded deployment for chain ${chainId} in test/sepolia/recorded-rounds.json`);
  return makeCtx(hre, { game: f.game, token: f.token }, { costCapWei });
}

function onSigint(ctx: Ctx): void {
  process.once("SIGINT", () => {
    log("\nSIGINT: sweeping fresh wallets back to the deployer before exit");
    void sweep(ctx, ctx.fresh).finally(() => process.exit(130));
  });
}

task("task:play-round", "Plays one scripted round with fresh wallets")
  .addParam("id", "Round id (R0..R4)")
  .addParam("players", "2 or 4", undefined, types.int)
  .addParam("outcome", "caller-loses | bidder-loses | timeout | cancel")
  .addFlag("extras", "R2: owner-minted leaver + never-funded join + duplicate staticCall")
  .addFlag("pauseAfterFill", "wait for an external startGame (probe task)")
  .addFlag("externalFinalize", "wait for an external finalizeReveal (scripts/finalize-round.ts)")
  .addOptionalParam("costCap", "Fee cap for this round in ETH (default 0.05)")
  .setAction(
    safe(async function (args: TaskArguments, hre) {
      const outcomes: Outcome[] = ["caller-loses", "bidder-loses", "timeout", "cancel"];
      if (!outcomes.includes(args.outcome)) throw new Error(`--outcome must be one of ${outcomes.join(", ")}`);
      if (args.players !== 2 && args.players !== 4) throw new Error("--players must be 2 or 4");
      const ctx = await contextFor(hre, args.costCap);
      onSigint(ctx);
      const startBalance = await hre.ethers.provider.getBalance(ctx.deployer.address);
      log(`network ${hre.network.name}, game ${await ctx.game.getAddress()}, deployer ${ctx.deployer.address}`);

      const report = await playRound(ctx, {
        id: args.id,
        players: args.players,
        outcome: args.outcome,
        extras: args.extras,
        pauseAfterFill: args.pauseAfterFill,
        externalFinalize: args.externalFinalize,
        outFile: hre.network.name === "hardhat" ? undefined : path.join(RUNS_DIR, `${args.id}.json`),
      });

      const endBalance = await hre.ethers.provider.getBalance(ctx.deployer.address);
      log(
        `\n${args.id}: table ${report.tableId} ${report.status}; fees ${hre.ethers.formatEther(ctx.feesWei)} ETH; deployer balance change ${hre.ethers.formatEther(endBalance - startBalance)} ETH`,
      );
      if (hre.network.name === "sepolia") {
        recordTable({
          id: args.id,
          tableId: Number(report.tableId),
          players: args.players,
          outcome: args.outcome,
          fromBlock: ctx.rows.find((r) => r.fn === "createTable")!.block,
          txs: ctx.rows.filter((r) => r.fn !== "transfer").map((r) => ({ label: r.label, hash: r.hash })),
        });
        log("  recorded in test/sepolia/recorded-rounds.json");
      }
    }),
  );

task("task:cancel-table", "Cancels a table after its proof deadline and verifies the refunds (R0)")
  .addParam("id", "Round id in the fixture (e.g. R0)")
  .addParam("table", "Table id", undefined, types.int)
  .setAction(
    safe(async function (args: TaskArguments, hre) {
      const ctx = await contextFor(hre);
      const tableId = BigInt(args.table);
      const receipt = await cancelAfterDeadline(ctx, tableId);
      const f = readFixture();
      const entry = f?.tables.find((t) => t.id === args.id);
      const report = await verifyRound(ctx, tableId, { fromBlock: entry?.fromBlock ?? receipt.blockNumber - 1_000 });
      for (const line of report.lines) log(line);
      if (entry) {
        entry.txs.push({ label: ctx.rows[ctx.rows.length - 1].label, hash: receipt.hash });
        recordTable(entry);
      }
      if (!report.ok) throw new Error("verify found a mismatch");
    }),
  );
