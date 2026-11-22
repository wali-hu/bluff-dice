/**
 * Scripted functional rounds (Phase D). One operator funds and controls every seat and reads every die: these
 * rounds prove that the contracts, the relayer and the KMS work end to end. They are not fair games.
 *
 * Used by `task:play-round` (Sepolia or hardhat), `scripts/finalize-round.ts` (`finalizeTable`) and the mock test
 * `test/ScriptedRounds.ts`.
 */
import { ContractTransactionReceipt, ethers } from "ethers";

import {
  Actor,
  Ctx,
  DICE_PER_PLAYER,
  FAUCET_AMOUNT,
  OPERATOR_TTL,
  PHASE_NAMES,
  Phase,
  ROUND_STAKE,
  TxRow,
  decodeRevert,
  freshActor,
  fund,
  latestTimestamp,
  log,
  parseProof,
  publicDecryptRetry,
  readFresh,
  sawBlock,
  send,
  sweep,
  userDecryptAs,
  waitPhaseLeaves,
  waitUntilAfter,
  writeRunJson,
} from "./round";
import { VerifyReport, verifyRound } from "./verify";

export type Outcome = "caller-loses" | "bidder-loses" | "timeout" | "cancel";

/** Base URL of the Sepolia relayer (the SDK appends /v2). */
export const RELAYER_URL = "https://relayer.testnet.zama.org";

export type RoundOptions = {
  /** Round id for logs and the run JSON, e.g. "R1". */
  id: string;
  players: 2 | 4;
  outcome: Outcome;
  stake?: bigint;
  /** R2 only: an owner-minted 5th wallet joins and leaves; a never-funded 6th joins for real and leaves; a 7th
   *  never-funded wallet's join is only simulated and must revert `DuplicatePaidHandle`. */
  extras?: boolean;
  /** Do not send `startGame`: wait until someone else does (the probe task runs in between). */
  pauseAfterFill?: boolean;
  /** Do not send `finalizeReveal`: wait until someone else does (`scripts/finalize-round.ts`). */
  externalFinalize?: boolean;
  /** Where to write the allow-listed run JSON (nothing written when undefined). */
  outFile?: string;
  /** Wait limit for an external `startGame` / `finalizeReveal`. */
  externalWaitMs?: number;
};

export type RoundReport = {
  id: string;
  tableId: bigint;
  status: "settled" | "timed-out" | "awaiting-cancel";
  players: { name: string; address: string; seat: number }[];
  loserSeat?: number;
  count?: number;
  bid?: { quantity: number; face: number };
  dice?: number[][];
  latency?: Record<string, number>;
  leakChecks?: Record<string, string>;
  duplicateCheck?: string;
  refusal?: string;
  deadline?: number;
  verify?: VerifyReport;
  rows: TxRow[];
  feesWei: bigint;
};

function seatName(i: number): string {
  return `p${i}`;
}

/** Event args of `name` emitted by the game in `receipt`. */
function gameEvents(ctx: Ctx, receipt: ethers.TransactionReceipt, name: string): ethers.Result[] {
  const out: ethers.Result[] = [];
  const gameAddress = ctx.game.target.toString().toLowerCase();
  for (const l of receipt.logs) {
    if (l.address.toLowerCase() !== gameAddress) continue;
    try {
      const parsed = ctx.game.interface.parseLog(l);
      if (parsed?.name === name) out.push(parsed.args);
    } catch {
      // not a game event
    }
  }
  return out;
}

async function setOperator(ctx: Ctx, a: Actor): Promise<void> {
  const until = (await latestTimestamp(ctx)) + OPERATOR_TTL;
  await send(ctx, "setOperator", a, ctx.token, "setOperator", [await ctx.game.getAddress(), until]);
}

/**
 * Submits the pending decryption proof of a table, whatever it is waiting for:
 * AwaitingPaidProof -> `paidHandles` -> publicDecrypt -> `startGame`;
 * AwaitingReveal -> `revealHandles` -> publicDecrypt -> `finalizeReveal`;
 * Bidding with `claimTimeout` and the deadline passed -> `claimTurnTimeout`.
 * Handles always come from the contract. Every send is preceded by a staticCall; a `KMSInvalidSigner` there
 * triggers one fresh proof (KMS signer rotation). Never calls `cancel` (that is the losing side's option).
 */
export async function finalizeTable(
  ctx: Ctx,
  tableId: bigint,
  opts: { dryRun?: boolean; claimTimeout?: boolean } = {},
): Promise<ContractTransactionReceipt | undefined> {
  const t = await readFresh(ctx, (o) => ctx.game.getTable(tableId, o));
  const phase = Number(t.phase) as Phase;
  const n = Number(t.maxPlayers);

  if (phase === Phase.AwaitingPaidProof || phase === Phase.AwaitingReveal) {
    const fn = phase === Phase.AwaitingPaidProof ? "startGame" : "finalizeReveal";
    const handles = [
      ...(phase === Phase.AwaitingPaidProof
        ? await readFresh(ctx, (o) => ctx.game.paidHandles(tableId, o))
        : await readFresh(ctx, (o) => ctx.game.revealHandles(tableId, o))),
    ];
    for (let attempt = 0; attempt < 2; ++attempt) {
      const r = await publicDecryptRetry(ctx, handles);
      const p = parseProof(r.decryptionProof);
      log(
        `  ${fn}: publicDecrypt of ${handles.length} handles in ${r.ms} ms (${r.attempts} attempt(s)), ` +
          `${p.numSigners} KMS signatures, extraData ${p.extraData}`,
      );
      try {
        await ctx.game.getFunction(fn).staticCall(tableId, r.abiEncodedClearValues, r.decryptionProof);
      } catch (e) {
        const why = decodeRevert(ctx, e);
        if (attempt === 0 && why.startsWith("KMSInvalidSigner")) {
          log(`  ${fn} staticCall: ${why}; fetching a fresh proof once`);
          continue;
        }
        throw new Error(`${fn} staticCall reverted: ${why}`);
      }
      if (opts.dryRun) {
        log(`  ${fn} staticCall OK (DRY_RUN, nothing sent)`);
        return undefined;
      }
      return send(ctx, `${fn} (${n}p)`, ctx.deployer, ctx.game, fn, [
        tableId,
        r.abiEncodedClearValues,
        r.decryptionProof,
      ]);
    }
    throw new Error(`${fn}: the proof was rejected twice`);
  }

  if (phase === Phase.Bidding && opts.claimTimeout) {
    const now = await latestTimestamp(ctx);
    if (BigInt(now) <= t.deadline) {
      log(`  table ${tableId}: turn deadline ${t.deadline} not passed yet (now ${now}); nothing to claim`);
      return undefined;
    }
    await ctx.game.claimTurnTimeout.staticCall(tableId);
    if (opts.dryRun) return undefined;
    return send(ctx, `claimTurnTimeout (${n}p)`, ctx.deployer, ctx.game, "claimTurnTimeout", [tableId]);
  }

  log(`  table ${tableId} is ${PHASE_NAMES[phase]}: nothing to finalize`);
  return undefined;
}

/** Cancels a table after its proof deadline (R0) and returns the receipt. Permissionless. */
export async function cancelAfterDeadline(ctx: Ctx, tableId: bigint): Promise<ContractTransactionReceipt> {
  const t = await readFresh(ctx, (o) => ctx.game.getTable(tableId, o));
  const phase = Number(t.phase) as Phase;
  if (phase !== Phase.AwaitingPaidProof && phase !== Phase.AwaitingReveal) {
    throw new Error(
      `table ${tableId} is ${PHASE_NAMES[phase]}, not cancellable (someone may have pushed startGame: open a replacement table)`,
    );
  }
  await waitUntilAfter(ctx, t.deadline);
  return send(ctx, `cancel (${Number(t.maxPlayers)}p, ${PHASE_NAMES[phase]})`, ctx.deployer, ctx.game, "cancel", [
    tableId,
  ]);
}

/** Three-layer leak check for dice that were never made public (timeout round). */
async function leakChecks(ctx: Ctx, dieHandles: string[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const { ACLAddress } = await ctx.hre.fhevm.getCoprocessorConfig(await ctx.game.getAddress());
  const acl = new ethers.Contract(
    ACLAddress,
    ["function isAllowedForDecryption(bytes32 handle) view returns (bool)"],
    ctx.hre.ethers.provider,
  );
  let publicCount = 0;
  for (const h of dieHandles) if (await acl.isAllowedForDecryption(h)) ++publicCount;
  out.onChain = `ACL.isAllowedForDecryption: ${publicCount} of ${dieHandles.length} dice public`;
  if (publicCount !== 0) throw new Error(`LEAK: ${publicCount} dice of a timed-out round are publicly decryptable`);

  try {
    await ctx.hre.fhevm.publicDecrypt([dieHandles[0]]);
    throw new Error("LEAK: the SDK decrypted a die of a timed-out round");
  } catch (e) {
    const msg = (e as Error).message;
    if (msg.startsWith("LEAK")) throw e;
    out.sdk = msg.slice(0, 200);
  }

  if (ctx.isMock) {
    out.relayer = "skipped in mock (no relayer)";
  } else {
    const res = await fetch(`${RELAYER_URL}/v2/public-decrypt`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ciphertextHandles: [dieHandles[0]], extraData: "0x00" }),
    });
    let body = await res.text();
    // A 202 only queues a job: poll it once the way the SDK does, to see the final answer.
    try {
      const j = JSON.parse(body);
      const jobId = j?.result?.jobId;
      if (res.status === 202 && jobId) {
        for (let i = 0; i < 10; ++i) {
          await new Promise((r) => setTimeout(r, 3_000));
          const g = await fetch(`${RELAYER_URL}/v2/public-decrypt/${jobId}`);
          body = `POST 202 queued; GET ${g.status}: ${await g.text()}`;
          if (g.status !== 202) break;
        }
      }
    } catch {
      // not JSON: keep the raw body
    }
    out.relayer = `HTTP ${res.status}: ${body.slice(0, 400)}`;
    if (/"decryptedValue"|"decrypted_value"/.test(body)) throw new Error(`LEAK: relayer answered ${out.relayer}`);
  }
  return out;
}

/** Plays one scripted round. Always sweeps the fresh wallets back to the deployer and writes the run JSON. */
export async function playRound(ctx: Ctx, o: RoundOptions): Promise<RoundReport> {
  const n = o.players;
  const stake = o.stake ?? ROUND_STAKE;
  const liar = o.outcome === "caller-loses" || o.outcome === "bidder-loses";
  const gameAddress = await ctx.game.getAddress();
  const tokenAddress = await ctx.token.getAddress();
  const players: Actor[] = Array.from({ length: n }, (_, i) => freshActor(ctx, seatName(i)));
  const extras = o.extras
    ? { leaver: freshActor(ctx, "leaver"), nofund: freshActor(ctx, "nofund"), nofund2: freshActor(ctx, "nofund2") }
    : undefined;
  const everyone = [...players, ...(extras ? [extras.leaver, extras.nofund, extras.nofund2] : [])];
  const report: RoundReport = {
    id: o.id,
    tableId: 0n,
    status: "settled",
    players: players.map((p, seat) => ({ name: p.name, address: p.address, seat })),
    rows: ctx.rows,
    feesWei: 0n,
  };
  let ok = false;

  log(`\n=== ${o.id}: ${n} players, outcome ${o.outcome}, stake ${ethers.formatUnits(stake, 6)} chips ===`);
  try {
    // 1. Funding: each wallet gets the planned gas of its own transactions x maxFee x 1.5.
    for (let i = 0; i < n; ++i) {
      const actions = ["faucet", "setOperator", i === 0 ? "createTable" : "joinTable"];
      if (liar && i === 0) actions.push("bid");
      if (liar && i === 1) actions.push("bid");
      if (liar && i === (n === 2 ? 0 : 2)) actions.push("callLiar");
      await fund(ctx, players[i], actions);
    }
    if (extras) {
      await fund(ctx, extras.leaver, ["setOperator", "joinTable", "leaveTable"]);
      await fund(ctx, extras.nofund, ["setOperator", "joinTable", "leaveTable"]);
      await fund(ctx, extras.nofund2, ["setOperator"]);
    }

    // 2. Chips: every player claims the faucet exactly once; the leaver gets an owner mint.
    for (const p of players) await send(ctx, "faucet", p, ctx.token, "faucet", []);
    if (extras) await send(ctx, "mint", ctx.deployer, ctx.token, "mint", [extras.leaver.address, FAUCET_AMOUNT]);

    // 3. Create and fill. Each wallet approves the game for 10 minutes right before its own join.
    await setOperator(ctx, players[0]);
    const created = await send(ctx, `createTable (${n}p)`, players[0], ctx.game, "createTable", [stake, n]);
    const tableId = gameEvents(ctx, created, "TableCreated")[0].tableId as bigint;
    report.tableId = tableId;
    log(`  table id ${tableId}`);

    await setOperator(ctx, players[1]);
    const fill1 = await send(ctx, n === 2 ? "joinTable (filling)" : "joinTable", players[1], ctx.game, "joinTable", [
      tableId,
    ]);
    let fillReceipt = fill1;

    if (extras) {
      await setOperator(ctx, extras.leaver);
      await send(ctx, "joinTable", extras.leaver, ctx.game, "joinTable", [tableId]);
      await send(ctx, "leaveTable", extras.leaver, ctx.game, "leaveTable", [tableId]);

      await setOperator(ctx, extras.nofund);
      await send(ctx, "joinTable (never-funded)", extras.nofund, ctx.game, "joinTable", [tableId]);
      await setOperator(ctx, extras.nofund2);
      // Mock (host contracts v0.1.0): handles are keccak(op, inputs, acl, chainid), so this second never-funded
      // pull recreates the seated one's paid handle and must revert DuplicatePaidHandle.
      // Sepolia (FHEVMExecutor v0.6.0, verified source): handles also hash blockhash(n-1) and block.timestamp, so
      // a pull simulated in a later block gets a different handle and must NOT revert. Same-block collisions are
      // still possible there, which is why the contract keeps the guard.
      let why: string;
      try {
        await ctx.game.connect(extras.nofund2.signer).joinTable.staticCall(tableId);
        why = "no revert";
      } catch (e) {
        why = decodeRevert(ctx, e);
      }
      const expected = ctx.isMock ? "DuplicatePaidHandle" : "no revert";
      report.duplicateCheck = `second never-funded join (staticCall, a later block): ${why} (expected ${expected})`;
      log(`  ${report.duplicateCheck}`);
      if (!why.startsWith(expected)) throw new Error(`duplicate check: expected ${expected}, got ${why}`);
      await send(ctx, "leaveTable (never-funded)", extras.nofund, ctx.game, "leaveTable", [tableId]);
    }

    for (let i = 2; i < n; ++i) {
      await setOperator(ctx, players[i]);
      const label = i === n - 1 ? "joinTable (filling)" : "joinTable";
      fillReceipt = await send(ctx, label, players[i], ctx.game, "joinTable", [tableId]);
    }

    const filled = await readFresh(ctx, (o) => ctx.game.getTable(tableId, o));
    if (Number(filled.phase) !== Phase.AwaitingPaidProof)
      throw new Error(`expected AwaitingPaidProof, got ${PHASE_NAMES[Number(filled.phase)]}`);
    const paid = [...(await readFresh(ctx, (o) => ctx.game.paidHandles(tableId, o)))];
    if (new Set(paid).size !== paid.length) throw new Error("paid handles are not distinct");
    log(
      `  table full, ${paid.length} distinct paid handles, proof deadline ${filled.deadline} (fill block ${fillReceipt.blockNumber})`,
    );
    report.deadline = Number(filled.deadline);

    // 4. Cancel round: nobody starts the game. The cancel itself is sent later (`cancelAfterDeadline`).
    if (o.outcome === "cancel") {
      report.status = "awaiting-cancel";
      log(`  ${o.id}: waiting for anyone to cancel after ${filled.deadline}`);
      ok = true;
      return report;
    }

    // 5. Start: here, or by someone else (probe task) while this process waits.
    let startTs: number;
    let startSeenAt: number;
    if (o.pauseAfterFill) {
      log(`  PAUSED: table ${tableId} is waiting for an external startGame (probe task)`);
      await waitPhaseLeaves(ctx, tableId, Phase.AwaitingPaidProof, o.externalWaitMs ?? 55 * 60_000);
      startSeenAt = Date.now();
      const ev = await ctx.game.queryFilter(ctx.game.filters.GameStarted(tableId), fillReceipt.blockNumber);
      if (ev.length === 0) throw new Error("table left AwaitingPaidProof without GameStarted (players dropped?)");
      startTs = (await ev[0].getBlock()).timestamp;
      sawBlock(ctx, ev[0].blockNumber);
      log(`  startGame seen: ${ev[0].transactionHash}`);
    } else {
      const r = await finalizeTable(ctx, tableId);
      if (!r) throw new Error("startGame was not sent");
      startSeenAt = Date.now();
      startTs = (await r.getBlock()).timestamp;
    }
    const started = await readFresh(ctx, (o) => ctx.game.getTable(tableId, o));
    if (Number(started.phase) !== Phase.Bidding)
      throw new Error(`expected Bidding, got ${PHASE_NAMES[Number(started.phase)]}`);

    const share = (stake / BigInt(n - 1)) * BigInt(n);
    let loserSeat: number;

    if (o.outcome === "timeout") {
      // 6a. Nobody acts. The runner never decrypts, prints or saves these dice: they are never public.
      await waitUntilAfter(ctx, started.deadline);
      const r = await send(ctx, `claimTurnTimeout (${n}p)`, ctx.deployer, ctx.game, "claimTurnTimeout", [tableId]);
      loserSeat = Number(started.turnSeat);
      const timedOut = gameEvents(ctx, r, "TurnTimedOut")[0];
      if (timedOut.loser !== players[loserSeat].address) throw new Error("TurnTimedOut names the wrong loser");
      const dice: string[] = [];
      for (const p of players) dice.push(...(await readFresh(ctx, (o) => ctx.game.diceOf(tableId, p.address, o))));
      report.leakChecks = await leakChecks(ctx, dice);
      for (const [k, v] of Object.entries(report.leakChecks)) log(`  leak check ${k}: ${v}`);
      try {
        await readFresh(ctx, (o) => ctx.game.revealHandles(tableId, o));
        throw new Error("revealHandles did not revert on a timed-out table");
      } catch (e) {
        const why = decodeRevert(ctx, e);
        if (!why.startsWith("LiarNotCalled")) throw new Error(`revealHandles: expected LiarNotCalled, got ${why}`);
        report.leakChecks.revealHandles = why;
      }
      report.status = "timed-out";
    } else {
      // 6b. Liar round. Seat 0 opens at once with a placeholder so the turn clock is not spent on decryption.
      // Seat 0's own decryption starts in parallel (signing typed data uses no nonce), so the latency below is
      // what a real player would see after the game starts.
      const handles0 = [...(await readFresh(ctx, (o) => ctx.game.diceOf(tableId, players[0].address, o)))];
      const [, first] = await Promise.all([
        send(ctx, "bid", players[0], ctx.game, "bid", [tableId, 1, 1]),
        userDecryptAs(ctx, players[0], handles0, gameAddress),
      ]);
      const dice: number[][] = [first.values.map(Number)];
      const firstSuccessAt = first.firstSuccessAt;
      const perPlayerMs: number[] = [first.ms];
      for (const p of players.slice(1)) {
        const handles = [...(await readFresh(ctx, (o) => ctx.game.diceOf(tableId, p.address, o)))];
        const r = await userDecryptAs(ctx, p, handles, gameAddress);
        perPlayerMs.push(r.ms);
        dice.push(r.values.map(Number));
      }
      report.latency = {
        startMinedToFirstDiceSec: Math.round(firstSuccessAt / 1000 - startTs),
        startSeenToFirstDiceMs: firstSuccessAt - startSeenAt,
        maxUserDecryptMs: Math.max(...perPlayerMs),
      };
      log(
        `  user decrypt: first player's dice ${report.latency.startMinedToFirstDiceSec} s after the startGame block ` +
          `(${report.latency.startSeenToFirstDiceMs} ms after it was seen); slowest request ${report.latency.maxUserDecryptMs} ms`,
      );

      // The ACL refuses another player's die (the SDK's persistAllowed pre-check).
      const p0Die = (await readFresh(ctx, (o) => ctx.game.diceOf(tableId, players[0].address, o)))[0];
      try {
        await userDecryptAs(ctx, players[1], [p0Die], gameAddress, 0);
        throw new Error("LEAK: player 1 decrypted player 0's die");
      } catch (e) {
        const msg = (e as Error).message;
        if (msg.startsWith("LEAK")) throw e;
        report.refusal = `the SDK refuses (ACL pre-check): ${msg.slice(0, 160)}`;
        log(`  ${report.refusal}`);
      }

      // Forced bid: a face with c >= 2 (always exists for >= 10 dice); Q = c (bid true) or c + 1 (bid false).
      const all = dice.flat();
      const counts = [0, 1, 2, 3, 4, 5, 6].map((f) => all.filter((v) => v === f).length);
      if (all.some((v) => v < 1 || v > 6)) throw new Error("a die is outside 1..6");
      let face = 0;
      for (let f = 1; f <= 6; ++f)
        if (counts[f] >= 2 && counts[f] + 1 <= all.length && counts[f] >= counts[face]) face = f;
      if (face === 0) throw new Error("no face with count >= 2");
      const c = counts[face];
      const quantity = o.outcome === "caller-loses" ? c : c + 1;
      await send(ctx, "bid", players[1], ctx.game, "bid", [tableId, quantity, face]);
      const callerSeat = n === 2 ? 0 : 2;
      await send(ctx, `callLiar (${n}p)`, players[callerSeat], ctx.game, "callLiar", [tableId]);
      report.dice = dice;
      report.bid = { quantity, face };
      log(`  dice (public since callLiar): ${dice.map((d, s) => `seat ${s} [${d.join(",")}]`).join("  ")}`);
      log(`  challenged bid: ${quantity} x face ${face}; true count ${c}`);

      // 7. Reveal: here, or by scripts/finalize-round.ts while this process waits.
      let revealReceipt: ethers.TransactionReceipt;
      if (o.externalFinalize) {
        log(`  PAUSED: table ${tableId} is waiting for an external finalizeReveal (scripts/finalize-round.ts)`);
        await waitPhaseLeaves(ctx, tableId, Phase.AwaitingReveal, o.externalWaitMs ?? 55 * 60_000);
        const ev = await ctx.game.queryFilter(ctx.game.filters.RoundRevealed(tableId), fillReceipt.blockNumber);
        if (ev.length === 0) throw new Error("table left AwaitingReveal without RoundRevealed (cancelled?)");
        revealReceipt = (await ev[0].getTransactionReceipt())!;
        sawBlock(ctx, revealReceipt.blockNumber);
        log(`  finalizeReveal seen: ${revealReceipt.hash}`);
      } else {
        const r = await finalizeTable(ctx, tableId);
        if (!r) throw new Error("finalizeReveal was not sent");
        revealReceipt = r;
      }
      const revealed = gameEvents(ctx, revealReceipt, "RoundRevealed")[0];
      loserSeat = o.outcome === "caller-loses" ? callerSeat : 1;
      if (revealed.loser !== players[loserSeat].address)
        throw new Error(`RoundRevealed loser ${revealed.loser} != seat ${loserSeat}`);
      if (Number(revealed.count) !== c) throw new Error(`RoundRevealed count ${revealed.count} != ${c}`);
      report.count = c;
    }
    report.loserSeat = loserSeat;

    // 8. Balances: each player decrypts their own chip balance (contract = token).
    for (let s = 0; s < n; ++s) {
      const h = await readFresh(ctx, (o) => ctx.token.confidentialBalanceOf(players[s].address, o));
      const r = await userDecryptAs(ctx, players[s], [h], tokenAddress);
      const expected = s === loserSeat ? FAUCET_AMOUNT - stake : FAUCET_AMOUNT - stake + share;
      // The decrypted value is the player's private balance: never put it in an error message.
      if (r.values[0] !== expected)
        throw new Error(`seat ${s}: decrypted balance differs from the expected ${expected}`);
      log(
        `  seat ${s} balance ${ethers.formatUnits(r.values[0], 6)} chips (${s === loserSeat ? "loser" : "winner"}) OK`,
      );
    }

    // 9. Independent re-check from public data only.
    report.verify = await verifyRound(ctx, tableId, { fromBlock: created.blockNumber });
    for (const line of report.verify.lines) log(line);
    if (!report.verify.ok) throw new Error("verify-round found a mismatch");
    ok = true;
    return report;
  } finally {
    await sweep(ctx, everyone);
    report.feesWei = ctx.feesWei;
    if (o.outFile) {
      const net = await ctx.hre.ethers.provider.getNetwork();
      writeRunJson(o.outFile, {
        round: o.id,
        network: ctx.hre.network.name,
        chainId: Number(net.chainId),
        game: gameAddress,
        token: tokenAddress,
        deployer: ctx.deployer.address,
        tableId: report.tableId.toString(),
        players: report.players,
        outcome: o.outcome,
        status: ok ? report.status : "failed",
        txs: ctx.rows,
        result: {
          loserSeat: report.loserSeat ?? null,
          count: report.count ?? null,
          bid: report.bid ?? null,
          // Dice are written only for Liar rounds, where callLiar made them public.
          dice: report.bid ? (report.dice ?? null) : null,
          duplicateCheck: report.duplicateCheck ?? null,
          refusal: report.refusal ?? null,
          leakChecks: report.leakChecks ?? null,
          deadline: report.deadline ?? null,
          verifyOk: report.verify?.ok ?? null,
        },
        latency: report.latency ?? null,
        feesWei: ctx.feesWei.toString(),
      });
      log(`  run JSON: ${o.outFile}`);
    }
  }
}

export { DICE_PER_PLAYER };
