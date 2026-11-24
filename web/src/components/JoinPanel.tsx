"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import type { Address } from "viem";
import { useConnection, usePublicClient } from "wagmi";

import { findBotTable, findQuickPlayTable, tableIdFromReceipt } from "@/chain/discovery";
import { getTable } from "@/chain/reads";
import { useTxQueue } from "@/chain/TxQueueProvider";
import { useLobbyTables } from "@/chain/useLobby";
import { useDecryptedBalance, type PlayerChainReads } from "@/chain/usePlayerReads";
import { createWrite, joinWrite } from "@/chain/writes";
import { BOT_ADDRESS } from "@/config/bot";
import { botView, BOT_TEXT } from "@/lib/botState";
import { formatChips } from "@/lib/chips";
import { defaultDescribeContext, needsReauthorize, type TxError } from "@/lib/errors";
import { groupTables, isOpen } from "@/lib/lobby";
import { balanceTooLow, nextFaucetAt } from "@/lib/onboarding";
import { seatSituation } from "@/lib/playNow";
import { DEFAULT_PLAYERS, DEFAULT_STAKE } from "@/lib/stakes";
import { onboardingTimer } from "@/lib/stepTimer";
import { useNow } from "@/lib/useNow";
import { useSearchParam } from "@/lib/useSearchParam";

import { AuthorizeAgain } from "./AuthorizeAgain";
import styles from "./Onboarding.module.css";
import { UnlockCard } from "./UnlockCard";
import { EncryptedAmountNote } from "@/components/EncryptedAmountNote";

function contractError(error: TxError | null): string | null {
  return error?.kind === "contract" ? error.name : null;
}

/** Step 5 (S2): Play vs Bot, a table from the lobby (?table=N), or Quick play (join a recent table or create one). */
export function JoinPanel({ reads }: { reads: PlayerChainReads }) {
  const client = usePublicClient();
  const router = useRouter();
  const queryClient = useQueryClient();
  const tx = useTxQueue();
  const now = useNow();
  const { address } = useConnection();
  const lobby = useLobbyTables();
  const balance = useDecryptedBalance(reads.balanceHandle);
  const targetParam = useSearchParam("table");
  const targetId = targetParam && /^\d+$/.test(targetParam) ? BigInt(targetParam) : undefined;

  const [seatTakenAt, setSeatTakenAt] = useState<number | null>(null);
  const [takenTableId, setTakenTableId] = useState<bigint | null>(null);
  const [joiningBot, setJoiningBot] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  // Set when a join/create failed because the operator grant expired: "Authorize again", then retry it.
  const [retryAfterAuth, setRetryAfterAuth] = useState<(() => Promise<unknown>) | null>(null);

  const searching = seatTakenAt !== null && now - seatTakenAt < 30_000;
  const botTable = useQuery({
    queryKey: ["bot-table", address],
    enabled: BOT_ADDRESS !== null && Boolean(client) && lobby.data !== undefined,
    refetchInterval: searching ? 5_000 : 20_000,
    queryFn: async () => (await findBotTable(client!, address, { lobby: lobby.data })) ?? null,
  });
  const botBalance = useQuery({
    queryKey: ["bot-balance"],
    enabled: BOT_ADDRESS !== null && Boolean(client),
    refetchInterval: 60_000,
    queryFn: () => client!.getBalance({ address: BOT_ADDRESS as Address }),
  });
  const target = useQuery({
    queryKey: ["table", targetId?.toString()],
    enabled: targetId !== undefined && Boolean(client),
    queryFn: () => getTable(client!, targetId as bigint),
  });

  const groups = lobby.data ? groupTables(lobby.data, address) : null;
  // BluffDice refuses a second seat only at the SAME table; a seat elsewhere is shown, never assumed to be this one.
  const where = groups
    ? seatSituation(
        groups.mine.map((e) => e.id),
        targetId,
      )
    : ({ kind: "free" } as const);
  const bot = botView({
    configured: BOT_ADDRESS !== null,
    tableId: botTable.data ?? undefined,
    botBalance: botBalance.data,
    seatTakenAt,
    takenTableId,
    now,
  });

  const stakeNeeded = target.data?.stake ?? DEFAULT_STAKE;
  const low = balanceTooLow(balance, stakeNeeded);
  const nowSeconds = BigInt(Math.floor(now / 1000));
  const nextClaim = nextFaucetAt(reads.lastFaucet, nowSeconds);

  function seated(tableId: bigint) {
    onboardingTimer.seated();
    void queryClient.invalidateQueries();
    router.push(`/table/${tableId}`);
  }

  /** Resolves with the contract error name on failure ("" for other failures), null on success. */
  async function join(tableId: bigint, viaBot: boolean): Promise<string | null> {
    setMessage(null);
    setRetryAfterAuth(null);
    setJoiningBot(viaBot);
    const outcome = await tx.run(joinWrite(tableId));
    setJoiningBot(false);
    if (outcome.ok) {
      seated(tableId);
      return null;
    }
    if (needsReauthorize(outcome.error)) setRetryAfterAuth(() => () => join(tableId, viaBot));
    const name = contractError(outcome.error);
    if (viaBot && name === "WrongPhase") {
      setSeatTakenAt(now);
      setTakenTableId(tableId);
      void queryClient.invalidateQueries({ queryKey: ["lobby"] });
    } else if (viaBot && name === "DroppedFromTable") {
      setMessage(BOT_TEXT.dropped);
    }
    return name ?? "";
  }

  async function quickPlay() {
    if (!client || !address) return;
    setMessage("Looking for a table that started in the last 15 minutes…");
    const found = await findQuickPlayTable(client, address).catch(() => undefined);
    if (found !== undefined) {
      setMessage(null);
      const failure = await join(found, false);
      if (failure === null) return;
      // The table filled between discovery and join: open a new one instead.
      if (failure !== "WrongPhase") return;
      tx.reset();
    }
    setMessage(null);
    await createDefault();
  }

  async function createDefault(): Promise<void> {
    setRetryAfterAuth(null);
    const outcome = await tx.run(createWrite(DEFAULT_STAKE, DEFAULT_PLAYERS));
    if (outcome.ok) {
      const id = tableIdFromReceipt(outcome.value);
      if (id !== undefined) seated(id);
    } else if (needsReauthorize(outcome.error)) {
      setRetryAfterAuth(() => createDefault);
    }
  }

  if (where.kind === "atTarget") {
    return (
      <div className={styles.panel}>
        <p>You already have a seat at table #{where.tableId.toString()}.</p>
        <button type="button" className="button button-primary" onClick={() => seated(where.tableId)}>
          Go to your table
        </button>
      </div>
    );
  }

  return (
    <div className={styles.panel}>
      {where.kind === "elsewhere" ? (
        <p className={styles.warning} role="status">
          You already have a seat at table #{where.tableId.toString()} (
          <Link href={`/table/${where.tableId}`}>open it</Link>). One account can sit at more than one table; joining
          below takes a second seat and locks a second stake.
        </p>
      ) : null}
      {low ? (
        <p className={styles.warning} role="alert">
          You have {formatChips(balance ?? 0n)} chips; this table needs {formatChips(stakeNeeded)}. Joining without
          enough chips gets you removed and banned from that table.{" "}
          {nextClaim === undefined
            ? "Claim more chips first (step 3)."
            : `Next free chips at ${defaultDescribeContext.formatTime(nextClaim)}.`}
        </p>
      ) : null}

      {targetId !== undefined && target.data ? (
        <div className={styles.option}>
          <p className={styles.optionTitle}>Table #{targetId.toString()}</p>
          <p className={styles.muted}>
            {target.data.maxPlayers} players, {formatChips(target.data.stake)} chips each, {target.data.playerCount}{" "}
            seated.
          </p>
          <button
            type="button"
            className="button button-primary"
            disabled={tx.busy || !isOpen(target.data)}
            onClick={() => void join(targetId, false)}
          >
            {isOpen(target.data) ? `Join table #${targetId.toString()}` : "This table is not open"}
          </button>
        </div>
      ) : null}

      {bot.kind !== "hidden" ? (
        <div className={styles.option}>
          <p className={styles.optionTitle}>Play vs Bot</p>
          {bot.kind === "ready" ? (
            <>
              <p className={styles.muted}>
                One wallet is enough. The bot is a normal player: it can decrypt only its own dice, never yours.
              </p>
              <button
                type="button"
                className="button button-primary"
                disabled={tx.busy}
                onClick={() => void join(bot.tableId, true)}
              >
                {BOT_TEXT.ready}
              </button>
            </>
          ) : (
            <p className={styles.muted} role="status">
              {bot.kind === "searching"
                ? BOT_TEXT.searching(bot.secondsLeft)
                : bot.kind === "resting"
                  ? BOT_TEXT.resting
                  : BOT_TEXT.busy}
            </p>
          )}
        </div>
      ) : null}

      <div className={styles.option}>
        <p className={styles.optionTitle}>Quick play</p>
        <p className={styles.muted}>
          Joins the newest open 2-player table at 60 chips from the last 15 minutes, or opens a new one and waits for a
          friend (send them the table link).
        </p>
        <button type="button" className="button button-ghost" disabled={tx.busy} onClick={() => void quickPlay()}>
          Quick play (2 players, 60 chips)
        </button>
      </div>
      <EncryptedAmountNote />

      {message ? (
        <p className={styles.muted} role="status">
          {message}
        </p>
      ) : null}
      {retryAfterAuth ? <AuthorizeAgain retry={retryAfterAuth} /> : null}

      {joiningBot && tx.state.status === "pending" ? (
        <UnlockCard context="While your seat is being confirmed:" />
      ) : null}
    </div>
  );
}
