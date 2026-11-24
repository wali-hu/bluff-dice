"use client";

import { useQuery } from "@tanstack/react-query";
import { useRef } from "react";
import type { Address } from "viem";
import { useConnection, usePublicClient } from "wagmi";

import { NO_SEAT, Phase, type TableView } from "@/chain/reads";
import { fetchTableTimeline } from "@/chain/tableLogs";
import { useTxQueue } from "@/chain/TxQueueProvider";
import { claimTimeoutWrite, liarWrite } from "@/chain/writes";
import { isBotAddress } from "@/config/bot";
import { ETHERSCAN_BASE_URL } from "@/config/links";
import { SEPOLIA_CHAIN_ID } from "@/contracts/addresses";
import { formatChips } from "@/lib/chips";
import { seatOfIn } from "@/lib/lobby";
import { potOf } from "@/lib/stakes";
import { CANCELLED_TEXT, PHASE_NAMES, roomView } from "@/lib/tableRoom";
import { paidLabel, seatRows, settledSummary, tableActions } from "@/lib/tableView";
import { historyView, type Timeline } from "@/lib/timeline";
import { useNow } from "@/lib/useNow";

import { BidHistory } from "./BidHistory";
import { BidPicker } from "./BidPicker";
import { BotBadge } from "./BotBadge";
import { CancelPanel } from "./CancelPanel";
import { CipherDie } from "./CipherDie";
import { DeadlineRing } from "./DeadlineRing";
import { DiceRow } from "./DiceRow";
import styles from "./GameTable.module.css";
import { OwnDice } from "./OwnDice";
import { PushPanel } from "./PushPanel";
import { TxStatus } from "./TxStatus";

const ZERO = "0x0000000000000000000000000000000000000000";

function short(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

/** E5 table view for every phase after Joining. Stacked layout at every width. */
export function GameTable({ tableId, t }: { tableId: bigint; t: TableView }) {
  const client = usePublicClient();
  const tx = useTxQueue();
  const { address, chainId, status } = useConnection();
  const now = useNow();
  const nowSeconds = BigInt(Math.floor(now / 1000));
  const knownFrom = useRef<bigint | undefined>(undefined);

  const timeline = useQuery({
    queryKey: ["table-timeline", tableId.toString(), t.round],
    enabled: Boolean(client),
    refetchInterval: 8_000,
    retry: false,
    queryFn: async (): Promise<Timeline | null> => {
      try {
        const tl = await fetchTableTimeline(client!, tableId, t.round, knownFrom.current);
        if (tl.createdBlock !== undefined) knownFrom.current = tl.createdBlock;
        return tl;
      } catch {
        return null; // degraded: the current bid comes from getTable
      }
    },
  });

  const mySeat = seatOfIn(t, address);
  const seated = mySeat !== NO_SEAT;
  const canWrite = status === "connected" && chainId === SEPOLIA_CHAIN_ID;
  const actions = tableActions({
    phase: t.phase,
    mySeat,
    turnSeat: t.turnSeat,
    playerCount: t.playerCount,
    bidQuantity: t.bidQuantity,
    bidFace: t.bidFace,
    deadline: t.deadline,
    nowSeconds: now === 0 ? 0n : nowSeconds,
    canWrite,
    pendingTx: tx.busy,
  });
  const rows = seatRows({
    players: t.players,
    maxPlayers: t.maxPlayers,
    phase: t.phase,
    turnSeat: t.turnSeat,
    viewer: address,
  });

  function seatName(who: string | number): string {
    const seat = typeof who === "number" ? who : seatOfIn(t, who as Address);
    if (seat === NO_SEAT) return typeof who === "string" ? short(who) : "a player";
    if (seat === mySeat) return "you";
    const player = t.players[seat] ?? ZERO;
    return `seat ${seat + 1} (${isBotAddress(player) ? "Bot" : short(player)})`;
  }

  const phaseTx = timeline.data?.phaseTx[t.phase];
  const view = roomView(t.phase);
  const summary = t.phase === Phase.Settled ? settledSummary(t, (s) => seatName(s)) : null;

  return (
    <div className={styles.table}>
      <header className={styles.header}>
        <h1 className={styles.title}>Table #{tableId.toString()}</h1>
        <p className={styles.meta}>
          {t.maxPlayers} players · {formatChips(t.stake)} chips each · pot {formatChips(potOf(t.stake, t.maxPlayers))}{" "}
          chips
        </p>
        <div className={styles.headerRow}>
          <span className={styles.phaseChip}>{PHASE_NAMES[t.phase as keyof typeof PHASE_NAMES] ?? "Unknown"}</span>
          {now !== 0 ? <DeadlineRing phase={t.phase} deadline={t.deadline} nowSeconds={nowSeconds} /> : null}
          {phaseTx ? (
            <a
              href={`${ETHERSCAN_BASE_URL}/tx/${phaseTx}`}
              target="_blank"
              rel="noopener noreferrer"
              className={styles.txLink}
            >
              Transaction that started this phase
            </a>
          ) : null}
        </div>
      </header>

      <ol className={styles.seats} aria-label="Seats">
        {rows.map((row) => (
          <li key={row.seat} className={`${styles.seat} ${row.turn ? styles.onTurn : ""}`}>
            <div className={styles.seatHead}>
              <span className={styles.seatNo}>Seat {row.seat + 1}</span>
              <span className="mono">{row.address === null ? "empty" : short(row.address)}</span>
              {isBotAddress(row.address) ? <BotBadge /> : null}
              {row.you ? <strong className={styles.you}>you</strong> : null}
              {row.turn ? <span className={styles.turn}>on turn</span> : null}
            </div>
            {row.address !== null ? <p className={styles.paid}>{paidLabel(t.phase)}</p> : null}
            {row.dice === "own" && address ? (
              <OwnDice
                tableId={tableId}
                round={t.round}
                player={address}
                seat={row.seat}
                dealtAtBlock={timeline.data?.gameStartedBlock}
              />
            ) : row.dice === "cipher" ? (
              <DiceRow label={`Seat ${row.seat + 1}: 5 hidden dice`}>
                {Array.from({ length: 5 }, (_, i) => (
                  <CipherDie
                    key={i}
                    seed={row.seat * 10 + i + 1}
                    label={`Seat ${row.seat + 1}, die ${i + 1}: hidden`}
                  />
                ))}
              </DiceRow>
            ) : null}
          </li>
        ))}
      </ol>

      {t.phase === Phase.Bidding || t.phase === Phase.AwaitingReveal || t.phase === Phase.Settled ? (
        <BidHistory view={historyView(timeline.data ?? null, t)} seatName={seatName} />
      ) : null}

      {t.phase === Phase.AwaitingPaidProof ? (
        <>
          <p className={styles.notice}>
            The table is full. Before the deal, the contract checks with a KMS proof that every stake arrived.
          </p>
          {canWrite ? <PushPanel tableId={tableId} kind="deal" players={t.maxPlayers} /> : null}
        </>
      ) : null}

      {t.phase === Phase.AwaitingReveal ? (
        <>
          <p className={styles.notice}>
            {seatName(t.liarCallerSeat)} called LIAR! on {t.bidQuantity} × {t.bidFace}. Every die is now public; the KMS
            decrypts them and the contract checks the proof.
          </p>
          {canWrite ? <PushPanel tableId={tableId} kind="reveal" players={t.maxPlayers} /> : null}
        </>
      ) : null}

      {t.phase === Phase.Settled ? (
        <section className={styles.panel} aria-labelledby="result-title">
          <h2 id="result-title" className={styles.sectionTitle}>
            Result
          </h2>
          {summary && summary.kind !== "unknown" ? <p>{summary.text}</p> : null}
          {timeline.data && timeline.data.winnings.length > 0 ? (
            <ul className={styles.winnings}>
              {timeline.data.winnings.map((w) => (
                <li key={w.winner}>
                  {seatName(w.winner)} received {formatChips(w.amount)} chips
                </li>
              ))}
            </ul>
          ) : null}
          <p className={styles.muted}>{view.kind === "over" ? view.text : null}</p>
        </section>
      ) : null}

      {t.phase === Phase.Cancelled ? <p className={styles.notice}>{CANCELLED_TEXT}</p> : null}

      <CancelPanel tableId={tableId} phase={t.phase} deadline={t.deadline} />
      <TxStatus />

      {t.phase === Phase.Bidding ? (
        <section className={styles.actionBar} aria-label="Your move">
          {actions.bid || actions.liar ? (
            <>
              <p className={styles.yourTurn}>Your turn.</p>
              {actions.bid ? (
                <BidPicker
                  tableId={tableId}
                  ctx={{ playerCount: t.playerCount, prevQuantity: t.bidQuantity, prevFace: t.bidFace }}
                />
              ) : (
                <p className={styles.muted}>{actions.reason}</p>
              )}
              {actions.liar ? (
                <button
                  type="button"
                  className={`button ${styles.liar}`}
                  disabled={tx.busy}
                  onClick={() => void tx.run(liarWrite(tableId))}
                >
                  LIAR!
                </button>
              ) : (
                <p className={styles.muted}>{actions.liarReason}</p>
              )}
            </>
          ) : actions.waitingForTurn ? (
            <p className={styles.muted}>
              Waiting for {seatName(t.turnSeat)} to bid or call LIAR!
              {seated ? "" : " You are watching this table."}
            </p>
          ) : !actions.claimTimeout && actions.reason ? (
            <p className={styles.muted}>{actions.reason}</p>
          ) : null}
          {actions.claimTimeout ? (
            <div>
              <p className={styles.muted}>
                {seatName(t.turnSeat)} ran out of time. Anyone can end the round: they lose, the others are paid, and
                the dice stay encrypted.
              </p>
              <button
                type="button"
                className="button button-ghost"
                disabled={tx.busy}
                onClick={() => void tx.run(claimTimeoutWrite(tableId))}
              >
                Claim the timeout
              </button>
            </div>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}
