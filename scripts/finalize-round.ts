/**
 * Pushes a table forward with the KMS proof it is waiting for. Permissionless: any funded account can run it, the
 * proof is the authority, not the sender. Public data only: no player key, no user decryption.
 *
 *   TABLE_ID=2 npx hardhat run scripts/finalize-round.ts --network sepolia
 *
 * - AwaitingPaidProof: paidHandles -> relayer publicDecrypt -> startGame
 * - AwaitingReveal:    revealHandles -> relayer publicDecrypt -> finalizeReveal
 * - Bidding:           only with CLAIM_TIMEOUT=1, and only after the turn deadline: claimTurnTimeout
 * - anything else:     prints the phase and exits 0
 *
 * Handles always come from the contract. Every send is preceded by a staticCall; "not ready" answers are retried
 * with backoff; a KMSInvalidSigner on the staticCall fetches one fresh proof (KMS signer rotation). DRY_RUN=1 stops
 * after the staticCall. It never calls `cancel`: that is the losing side's option, not a "push forward" action.
 * Addresses: GAME / TOKEN env vars, else the committed fixture test/sepolia/recorded-rounds.json.
 */
import hre from "hardhat";

import { readFixture } from "./lib/fixture";
import { finalizeTable } from "./lib/play";
import { PHASE_NAMES, log, makeCtx } from "./lib/round";

async function main(): Promise<void> {
  const tableIdText = process.env.TABLE_ID;
  if (!tableIdText) throw new Error("set TABLE_ID");
  await hre.fhevm.initializeCLIApi();
  const f = readFixture();
  const game = process.env.GAME ?? f?.game;
  const token = process.env.TOKEN ?? f?.token;
  if (!game || !token) throw new Error("no GAME/TOKEN and no fixture");
  const ctx = await makeCtx(hre, { game, token });
  const tableId = BigInt(tableIdText);
  const before = await ctx.game.getTable(tableId);
  log(`table ${tableId} on ${hre.network.name}: ${PHASE_NAMES[Number(before.phase)]} (sender ${ctx.deployer.address})`);
  const receipt = await finalizeTable(ctx, tableId, {
    dryRun: process.env.DRY_RUN === "1",
    claimTimeout: process.env.CLAIM_TIMEOUT === "1",
  });
  // Read at the receipt's block: a load-balanced RPC can serve "latest" from a node that lags behind.
  const after = await ctx.game.getTable(tableId, { blockTag: receipt?.blockNumber ?? "latest" });
  log(`table ${tableId}: ${PHASE_NAMES[Number(after.phase)]}${receipt ? ` (tx ${receipt.hash})` : ""}`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
