/**
 * Read-only re-check of a finished table from public chain data. No player key, no user decryption.
 *
 * For a Liar round it proves, without trusting the game contract's own events:
 * - the handles the KMS signed are exactly `revealHandles(tableId)` (from the `PublicDecryptionVerified` event of the
 *   finalize receipt, which the library emits only after a passing check);
 * - the proof (from calldata) is accepted by the real KMSVerifier, by an `eth_call` at the finalize block, and by an
 *   off-chain EIP-712 recovery that names the KMS signers;
 * - the decoded dice, the count of the challenged face, the loser and every payout match the events.
 * Timeout and cancelled tables get their own checks (no dice public; refunds equal the token's transfer handles).
 */
import { ethers } from "ethers";

import {
  Ctx,
  PHASE_NAMES,
  Phase,
  checkSigners,
  decodeRevert,
  kmsDomain,
  kmsVerifier,
  parseProof,
  publicDecryptDigest,
  publicDecryptRetry,
  words,
} from "./round";

export type Check = { name: string; ok: boolean; detail: string };

export type VerifyReport = {
  tableId: bigint;
  phase: string;
  kind: "liar" | "timeout" | "cancelled" | "open";
  ok: boolean;
  checks: Check[];
  lines: string[];
  kmsSigners?: string[];
};

const ETHERSCAN = "https://sepolia.etherscan.io/tx/";
/** Log search window after `fromBlock` (about 2.8 days of Sepolia blocks). */
const LOG_WINDOW_BLOCKS = 20_000;

type Proven = { handles: string[]; cleartexts: string; proof: string; block: number; hash: string };

/** Handles + cleartexts from the PublicDecryptionVerified event, proof from calldata of `fn`. */
async function provenDecryption(ctx: Ctx, txHash: string, fn: "startGame" | "finalizeReveal"): Promise<Proven> {
  const provider = ctx.hre.ethers.provider;
  const receipt = await provider.getTransactionReceipt(txHash);
  const tx = await provider.getTransaction(txHash);
  if (!receipt || !tx) throw new Error(`tx ${txHash} not found`);
  const gameAddress = (await ctx.game.getAddress()).toLowerCase();
  let handles: string[] | undefined;
  let cleartexts: string | undefined;
  for (const l of receipt.logs) {
    if (l.address.toLowerCase() !== gameAddress) continue;
    const parsed = ctx.game.interface.parseLog(l);
    if (parsed?.name === "PublicDecryptionVerified") {
      handles = [...parsed.args.handlesList].map(String);
      cleartexts = String(parsed.args.abiEncodedCleartexts);
    }
  }
  if (!handles || cleartexts === undefined) throw new Error(`no PublicDecryptionVerified event in ${txHash}`);
  const call = ctx.game.interface.parseTransaction({ data: tx.data });
  if (call?.name !== fn) throw new Error(`${txHash} is not a direct ${fn} call (${call?.name ?? "unknown"})`);
  return { handles, cleartexts, proof: String(call.args.proof), block: receipt.blockNumber, hash: txHash };
}

/** On-chain + off-chain KMS check of one proven decryption. */
async function checkKms(ctx: Ctx, p: Proven, label: string, checks: Check[], lines: string[]): Promise<string[]> {
  const kms = await kmsVerifier(ctx);
  let onChain: string;
  try {
    const r = await kms.verifyDecryptionEIP712KMSSignatures.staticCall(p.handles, p.cleartexts, p.proof, {
      blockTag: p.block,
    });
    onChain = r === true ? "true (at the finalize block)" : `returned ${String(r)}`;
  } catch (e) {
    // No archive state on this RPC: call at latest. A KMSInvalidSigner there can mean a signer rotation OR a
    // forgery: it is reported as inconclusive and does NOT pass.
    try {
      const r = await kms.verifyDecryptionEIP712KMSSignatures.staticCall(p.handles, p.cleartexts, p.proof);
      onChain = r === true ? "true (at latest; no archive state for the finalize block)" : `returned ${String(r)}`;
    } catch (e2) {
      const why = decodeRevert(ctx, e2);
      onChain = why.startsWith("KMSInvalidSigner")
        ? `INCONCLUSIVE: ${why} at latest and no archive state (KMS signer rotation or a bad proof)`
        : `reverted ${why} (archive call: ${decodeRevert(ctx, e)})`;
    }
  }
  checks.push({ name: `${label}: KMSVerifier eth_call`, ok: onChain.startsWith("true"), detail: onChain });

  // Signer set and threshold as of the round's block (archive), else latest: a later rotation must not fail an
  // honest old round, nor pass a forged one.
  let domain;
  let known: string[];
  let threshold: number;
  let at = `block ${p.block}`;
  try {
    domain = await kmsDomain(kms, p.block);
    known = [...(await kms.getKmsSigners({ blockTag: p.block }))].map(String);
    threshold = Number(await kms.getThreshold({ blockTag: p.block }));
  } catch {
    at = "latest (no archive state)";
    domain = await kmsDomain(kms);
    known = [...(await kms.getKmsSigners())].map(String);
    threshold = Number(await kms.getThreshold());
  }
  const parsed = parseProof(p.proof);
  const digest = publicDecryptDigest(domain, p.handles, p.cleartexts, parsed.extraData);
  const sc = checkSigners(digest, parsed.signatures, known, threshold);
  checks.push({
    name: `${label}: off-chain EIP-712 recovery`,
    ok: sc.verdict === "accepted",
    detail: `${parsed.numSigners} signatures, ${sc.unique} unique known signers (signer set at ${at}) reached threshold ${threshold}: ${sc.verdict}`,
  });
  lines.push(`    ${label} signed by: ${sc.recovered.join(", ")}`);
  return sc.recovered;
}

/** Re-checks a table. `fromBlock` bounds the log search (the TableCreated block or the game's deploy block). */
export async function verifyRound(
  ctx: Ctx,
  tableId: bigint,
  opts: { fromBlock?: number; relayerRecheck?: boolean } = {},
): Promise<VerifyReport> {
  const checks: Check[] = [];
  const lines: string[] = [];
  const g = ctx.game;
  const from = opts.fromBlock ?? 0;
  const t = await g.getTable(tableId);
  const phase = Number(t.phase) as Phase;
  const n = Number(t.maxPlayers);
  // `players` is a fixed MAX_PLAYERS array: seats >= maxPlayers are address(0).
  const players = [...t.players].slice(0, n).map(String);
  const share = (t.stake / BigInt(n - 1)) * BigInt(n);
  const link = (h: string) => (ctx.isMock ? h : ETHERSCAN + h);

  // Every event of a round falls within hours of its createTable block. A bounded window keeps the query under
  // public RPC range limits (50,000 blocks observed) however long after the round this runs.
  const latest = await ctx.hre.ethers.provider.getBlockNumber();
  const to = Math.min(latest, from + LOG_WINDOW_BLOCKS);
  // A load-balanced RPC can serve getLogs from a node a block or two behind the head we just read: retry.
  const q = async (name: string) => {
    for (let i = 0; ; ++i) {
      try {
        return await g.queryFilter(
          (g.filters as unknown as Record<string, (id: bigint) => ethers.DeferredTopicFilter>)[name](tableId),
          from,
          to,
        );
      } catch (e) {
        if (!/beyond current head|header not found|unknown block/i.test(String((e as Error)?.message)) || i >= 20)
          throw e;
        await new Promise((resolve) => setTimeout(resolve, 3_000));
      }
    }
  };
  const started = await q("GameStarted");
  const liarCalled = await q("LiarCalled");
  const revealed = await q("RoundRevealed");
  const winnings = await q("WinningsPaid");
  const timedOut = await q("TurnTimedOut");
  const cancelled = await q("TableCancelled");
  const bids = await q("BidPlaced");

  let kind: VerifyReport["kind"] = "open";
  let kmsSigners: string[] | undefined;
  lines.push(`  verify table ${tableId}: ${PHASE_NAMES[phase]}, ${n} players, stake ${t.stake}`);

  // Paid check (any table that started).
  if (started.length > 0) {
    const ev = started[started.length - 1] as ethers.EventLog;
    const p = await provenDecryption(ctx, ev.transactionHash, "startGame");
    const expected = [...(await g.paidHandles(tableId))].map(String);
    checks.push({
      name: "paid: signed handles == paidHandles()",
      ok: JSON.stringify(p.handles) === JSON.stringify(expected),
      detail: `${p.handles.length} handles`,
    });
    const flags = words(p.cleartexts).map((w) => BigInt(w));
    checks.push({ name: "paid: every flag is 1", ok: flags.every((f) => f === 1n), detail: flags.join(",") });
    await checkKms(ctx, p, "paid", checks, lines);
    lines.push(`    startGame ${link(p.hash)}`);
  }

  if (revealed.length > 0) {
    kind = "liar";
    const rev = revealed[0] as ethers.EventLog;
    const liar = (liarCalled[0] as ethers.EventLog).args;
    const p = await provenDecryption(ctx, rev.transactionHash, "finalizeReveal");
    const expected = [...(await g.revealHandles(tableId))].map(String);
    checks.push({
      name: "reveal: signed handles == revealHandles()",
      ok: JSON.stringify(p.handles) === JSON.stringify(expected),
      detail: `${p.handles.length} handles`,
    });
    // Independent of the reveal view: seat 0..n-1, each player's five `diceOf` handles, concatenated.
    const perPlayer: string[] = [];
    for (const pl of players) perPlayer.push(...[...(await g.diceOf(tableId, pl))].map(String));
    checks.push({
      name: "reveal: signed handles == every seat's diceOf() in seat order",
      ok: JSON.stringify(p.handles) === JSON.stringify(perPlayer),
      detail: `${perPlayer.length} handles`,
    });
    kmsSigners = await checkKms(ctx, p, "reveal", checks, lines);

    const dice = words(p.cleartexts).map((w) => Number(BigInt(w)));
    checks.push({ name: "reveal: every die in 1..6", ok: dice.every((d) => d >= 1 && d <= 6), detail: dice.join("") });
    const quantity = Number(liar.quantity);
    const face = Number(liar.face);
    const count = dice.filter((d) => d === face).length;
    const callerSeat = players.indexOf(String(liar.caller));
    const bidderSeat = players.indexOf(String(liar.bidder));
    const loserSeat = count >= quantity ? callerSeat : bidderSeat;
    const r = rev.args;
    checks.push({
      name: "reveal: recomputed count == event count",
      ok: Number(r.count) === count,
      detail: `${count} x face ${face}, bid ${quantity}`,
    });
    checks.push({
      name: "reveal: recomputed loser == event loser",
      ok: String(r.loser) === players[loserSeat],
      detail: `seat ${loserSeat} (${count >= quantity ? "bid was true: caller" : "bid was false: bidder"} loses)`,
    });
    checks.push({
      name: "reveal: loserSeat in storage",
      ok: Number(t.loserSeat) === loserSeat,
      detail: String(t.loserSeat),
    });
    const paidTo = winnings.map((w) => String((w as ethers.EventLog).args.winner));
    const expectedWinners = players.filter((_, s) => s !== loserSeat);
    checks.push({
      name: "payouts: one WinningsPaid per non-loser, amount = n*stake/(n-1)",
      ok:
        JSON.stringify(paidTo) === JSON.stringify(expectedWinners) &&
        winnings.every((w) => (w as ethers.EventLog).args.amount === share),
      detail: `${paidTo.length} x ${share}`,
    });
    for (let s = 0; s < n; ++s) lines.push(`    seat ${s} dice ${dice.slice(s * 5, s * 5 + 5).join(",")}`);
    lines.push(`    finalizeReveal ${link(p.hash)}`);

    if (opts.relayerRecheck && !ctx.isMock) {
      try {
        const again = await publicDecryptRetry(ctx, p.handles, 60_000);
        checks.push({
          name: "relayer re-decrypt (optional)",
          ok: again.abiEncodedClearValues === p.cleartexts,
          detail: "same clear values",
        });
      } catch (e) {
        lines.push(`    relayer re-decrypt skipped: ${(e as Error).message.slice(0, 120)}`);
      }
    }
  } else if (timedOut.length > 0) {
    kind = "timeout";
    const ev = timedOut[0] as ethers.EventLog;
    const block = await ev.getBlock();
    const lastDeadline =
      bids.length > 0
        ? (bids[bids.length - 1] as ethers.EventLog).args.deadline
        : (started[0] as ethers.EventLog).args.deadline;
    const turnSeat = bids.length > 0 ? Number((bids[bids.length - 1] as ethers.EventLog).args.nextSeat) : 0;
    checks.push({
      name: "timeout: claimed after the turn deadline",
      ok: BigInt(block.timestamp) > lastDeadline,
      detail: `deadline ${lastDeadline}, claim block time ${block.timestamp}`,
    });
    checks.push({
      name: "timeout: loser is the player on turn",
      ok: String(ev.args.loser) === players[turnSeat],
      detail: `seat ${turnSeat}`,
    });
    const paidTo = winnings.map((w) => String((w as ethers.EventLog).args.winner));
    checks.push({
      name: "timeout: every other player paid n*stake/(n-1)",
      ok:
        JSON.stringify(paidTo) === JSON.stringify(players.filter((_, s) => s !== turnSeat)) &&
        winnings.every((w) => (w as ethers.EventLog).args.amount === share),
      detail: `${paidTo.length} x ${share}`,
    });
    const { ACLAddress } = await ctx.hre.fhevm.getCoprocessorConfig(await g.getAddress());
    const acl = new ethers.Contract(
      ACLAddress,
      ["function isAllowedForDecryption(bytes32) view returns (bool)"],
      ctx.hre.ethers.provider,
    );
    let pub = 0;
    let total = 0;
    for (const pl of players)
      for (const h of await g.diceOf(tableId, pl)) {
        ++total;
        if (await acl.isAllowedForDecryption(h)) ++pub;
      }
    checks.push({ name: "timeout: no die is publicly decryptable", ok: pub === 0, detail: `${pub} of ${total}` });
    lines.push(`    claimTurnTimeout ${link(ev.transactionHash)}`);
  } else if (phase === Phase.Cancelled && cancelled.length > 0) {
    kind = "cancelled";
    const ev = cancelled[0] as ethers.EventLog;
    const receipt = (await ev.getTransactionReceipt())!;
    const tokenAddress = (await ctx.token.getAddress()).toLowerCase();
    const gameAddress = (await g.getAddress()).toLowerCase();
    const refunds: { player: string; amount: string }[] = [];
    const transfers: { to: string; amount: string }[] = [];
    for (const l of receipt.logs) {
      if (l.address.toLowerCase() === gameAddress) {
        const parsed = g.interface.parseLog(l);
        if (parsed?.name === "StakeRefunded")
          refunds.push({ player: String(parsed.args.player), amount: String(parsed.args.amount) });
      } else if (l.address.toLowerCase() === tokenAddress) {
        const parsed = ctx.token.interface.parseLog(l);
        if (parsed?.name === "ConfidentialTransfer" && String(parsed.args.from).toLowerCase() === gameAddress) {
          transfers.push({ to: String(parsed.args.to), amount: String(parsed.args.amount) });
        }
      }
    }
    const seated = players.filter((a) => a !== ethers.ZeroAddress);
    checks.push({
      name: "cancel: one StakeRefunded per seated player",
      ok: refunds.length === seated.length && seated.every((a) => refunds.some((r) => r.player === a)),
      detail: `${refunds.length} refunds, ${seated.length} seated`,
    });
    checks.push({
      name: "cancel: each refund handle == the token's ConfidentialTransfer(game, player) handle",
      ok: refunds.every((r) => transfers.some((x) => x.to === r.player && x.amount === r.amount)),
      detail: `${transfers.length} transfers from the game`,
    });
    checks.push({
      name: "cancel: no RoundRevealed",
      ok: revealed.length === 0,
      detail: liarCalled.length > 0 ? "Liar was called (dice public)" : "dice never public",
    });
    lines.push(`    cancel ${link(ev.transactionHash)}`);
  }

  // A finished table must have been recognised and checked: zero checks (e.g. a log window that missed the round)
  // is a failure, never "ALL CHECKS PASSED".
  const expectedKind =
    phase === Phase.Settled ? ["liar", "timeout"] : phase === Phase.Cancelled ? ["cancelled"] : ["open"];
  checks.push({
    name: "table recognised (events found for its phase)",
    ok: expectedKind.includes(kind) && (kind === "open" || checks.length > 0),
    detail: `phase ${PHASE_NAMES[phase]}, recognised as ${kind}`,
  });
  const ok = checks.every((c) => c.ok);
  for (const c of checks) lines.push(`    [${c.ok ? "ok" : "FAIL"}] ${c.name}: ${c.detail}`);
  lines.push(`  verify table ${tableId}: ${ok ? "ALL CHECKS PASSED" : "MISMATCH"}`);
  return { tableId, phase: PHASE_NAMES[phase], kind, ok, checks, lines, kmsSigners };
}
