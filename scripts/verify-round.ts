/**
 * Re-checks a finished table from public chain data only (read RPC, no key, no ETH).
 *
 *   TABLE_ID=2 npx hardhat run scripts/verify-round.ts --network sepolia
 *   npx hardhat run scripts/verify-round.ts --network sepolia            # every table in the fixture
 *
 * Liar round: handles and clear dice from the PublicDecryptionVerified event of the finalize receipt (asserted equal
 * to revealHandles), proof from calldata, eth_call of the real KMSVerifier at the finalize block (must return
 * exactly true), off-chain EIP-712 recovery of every KMS signature, then the count, the loser and every payout are
 * recomputed and compared with the events. Timeout and cancelled tables get their own checks.
 * Exits non-zero on any mismatch. RELAYER_RECHECK=1 also asks the relayer to decrypt again (an outage never fails).
 */
import hre from "hardhat";

import { readFixture } from "./lib/fixture";
import { log, makeCtx } from "./lib/round";
import { verifyRound } from "./lib/verify";

async function main(): Promise<void> {
  await hre.fhevm.initializeCLIApi();
  const f = readFixture();
  const game = process.env.GAME ?? f?.game;
  const token = process.env.TOKEN ?? f?.token;
  if (!game || !token) throw new Error("no GAME/TOKEN and no fixture");
  const ctx = await makeCtx(hre, { game, token });
  const ids = process.env.TABLE_ID ? [BigInt(process.env.TABLE_ID)] : (f?.tables ?? []).map((t) => BigInt(t.tableId));
  let failed = 0;
  for (const tableId of ids) {
    const entry = f?.tables.find((t) => BigInt(t.tableId) === tableId);
    const report = await verifyRound(ctx, tableId, {
      fromBlock: entry?.fromBlock ?? f?.deployBlock,
      relayerRecheck: process.env.RELAYER_RECHECK === "1",
    });
    log(`\n${entry ? `${entry.id} ` : ""}(${report.kind})`);
    for (const line of report.lines) log(line);
    if (!report.ok) ++failed;
  }
  if (failed) throw new Error(`${failed} table(s) failed verification`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
