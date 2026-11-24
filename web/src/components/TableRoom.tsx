"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useConnection, usePublicClient } from "wagmi";

import { getTable, NO_SEAT } from "@/chain/reads";
import { useTxQueue } from "@/chain/TxQueueProvider";
import { useMounted } from "@/chain/useWalletGate";
import { leaveWrite } from "@/chain/writes";
import { isBotAddress } from "@/config/bot";
import { formatChips } from "@/lib/chips";
import { isOpen, seatOfIn } from "@/lib/lobby";
import { potOf } from "@/lib/stakes";
import { PHASE_NAMES, roomView } from "@/lib/tableRoom";

import { BotBadge } from "./BotBadge";
import { GameTable } from "./GameTable";
import styles from "./TableRoom.module.css";
import { TxStatus } from "./TxStatus";
import { EncryptedAmountNote } from "./EncryptedAmountNote";
import { UnlockCard } from "./UnlockCard";

const ZERO = "0x0000000000000000000000000000000000000000";

function short(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

/** /table/<id>: the waiting room while Joining, the full table view (GameTable) in every later phase. */
export function TableRoom({ id }: { id: string }) {
  const tableId = BigInt(id);
  const client = usePublicClient();
  const mounted = useMounted();
  const router = useRouter();
  const tx = useTxQueue();
  const { address } = useConnection();
  const [copied, setCopied] = useState(false);
  const table = useQuery({
    queryKey: ["table", tableId.toString()],
    enabled: Boolean(client),
    refetchInterval: 4_000,
    queryFn: () => getTable(client!, tableId),
  });

  if (table.isPending) return <p className={styles.muted}>Reading table #{tableId.toString()} from Sepolia…</p>;
  if (table.isError || !table.data) {
    return (
      <p className={styles.muted} role="alert">
        Table #{tableId.toString()} was not found (or Sepolia did not answer).{" "}
        <Link href="/lobby">Back to the lobby</Link>
      </p>
    );
  }

  const t = table.data;
  const view = roomView(t.phase);
  // Every phase after Joining: the E5 table view.
  if (view.kind !== "waiting" && view.kind !== "notFound") return <GameTable tableId={tableId} t={t} />;
  const mySeat = seatOfIn(t, address);
  const seated = mySeat !== NO_SEAT;
  const inviteUrl = mounted ? `${window.location.origin}/table/${tableId}` : `/table/${tableId}`;

  return (
    <div className={styles.room}>
      <header className={styles.header}>
        <h1 className={styles.title}>Table #{tableId.toString()}</h1>
        <p className={styles.muted}>
          {t.maxPlayers} players · {formatChips(t.stake)} chips each · pot {formatChips(potOf(t.stake, t.maxPlayers))}{" "}
          chips · <span className={styles.phase}>{PHASE_NAMES[t.phase as keyof typeof PHASE_NAMES]}</span>
        </p>
      </header>

      <ol className={styles.seats} aria-label="Seats">
        {Array.from({ length: t.maxPlayers }, (_, seat) => {
          const player = t.players[seat] ?? ZERO;
          const empty = player === ZERO;
          return (
            <li key={seat} className={styles.seat}>
              <span className={styles.seatNo}>Seat {seat + 1}</span>
              {empty ? (
                <span className={styles.muted}>Open seat</span>
              ) : (
                <span className="mono">
                  {short(player)} {isBotAddress(player) ? <BotBadge /> : null}{" "}
                  {seat === mySeat ? <strong className={styles.you}>you</strong> : null}
                </span>
              )}
            </li>
          );
        })}
      </ol>

      <TxStatus />

      {view.kind === "waiting" ? (
        <>
          <p className={styles.muted}>
            Waiting for {t.maxPlayers - t.playerCount} more player{t.maxPlayers - t.playerCount === 1 ? "" : "s"}. The
            dice are dealt when every seat is taken and every stake is verified.
          </p>
          <div className={styles.invite}>
            <label className={styles.inviteLabel}>
              Invite link
              <input className="mono" readOnly value={inviteUrl} onFocus={(e) => e.currentTarget.select()} />
            </label>
            <button
              type="button"
              className="button button-ghost"
              onClick={() => {
                void navigator.clipboard?.writeText(inviteUrl).then(() => setCopied(true));
              }}
            >
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
          {seated ? (
            <>
              <UnlockCard context="While you wait for the table to fill:" />
              <button
                type="button"
                className="button button-ghost"
                disabled={tx.busy}
                onClick={() =>
                  void tx.run(leaveWrite(tableId)).then((outcome) => {
                    if (outcome.ok) router.push("/lobby");
                  })
                }
              >
                Leave and get my stake back
              </button>
              <EncryptedAmountNote />
            </>
          ) : isOpen(t) ? (
            <Link className="button button-primary" href={`/play?table=${tableId}`}>
              Join this table
            </Link>
          ) : null}
        </>
      ) : (
        <p className={styles.muted}>This table does not exist.</p>
      )}
    </div>
  );
}
