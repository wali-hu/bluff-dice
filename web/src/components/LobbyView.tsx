"use client";

import Link from "next/link";
import { useConnection } from "wagmi";

import { useTxQueue } from "@/chain/TxQueueProvider";
import { Phase } from "@/chain/reads";
import { useLobbyTables } from "@/chain/useLobby";
import { leaveWrite } from "@/chain/writes";
import { isBotAddress } from "@/config/bot";
import { formatChips } from "@/lib/chips";
import { groupTables, type TableEntry } from "@/lib/lobby";
import { PHASE_NAMES } from "@/lib/tableRoom";

import { BotBadge } from "./BotBadge";
import { CreateTableForm } from "./CreateTableForm";
import styles from "./Lobby.module.css";
import { TxStatus } from "./TxStatus";
import { EncryptedAmountNote } from "@/components/EncryptedAmountNote";

function Row({ entry, action }: { entry: TableEntry; action?: React.ReactNode }) {
  const { table, id } = entry;
  const bot = isBotAddress(table.players[0]);
  return (
    <li className={styles.row}>
      <div className={styles.rowMain}>
        <Link href={`/table/${id}`} className={styles.rowTitle}>
          Table #{id.toString()}
        </Link>{" "}
        {bot ? <BotBadge /> : null}
        <span className={styles.muted}>
          {" "}
          {table.maxPlayers} players · {formatChips(table.stake)} chips · {table.playerCount}/{table.maxPlayers} seated
          · {PHASE_NAMES[table.phase as keyof typeof PHASE_NAMES] ?? "Unknown"}
        </span>
      </div>
      {action}
    </li>
  );
}

/** S3: the newest 50 tables in one Multicall3 read, grouped: yours, open, recently finished. */
export function LobbyView() {
  const { address } = useConnection();
  const lobby = useLobbyTables();
  const tx = useTxQueue();
  const groups = lobby.data ? groupTables(lobby.data, address) : null;

  return (
    <div className={styles.lobby}>
      <TxStatus />
      {lobby.isPending ? <p className={styles.muted}>Reading the newest 50 tables from Sepolia…</p> : null}
      {lobby.isError ? (
        <p className={styles.muted} role="alert">
          Could not read the tables right now. Retrying automatically…
        </p>
      ) : null}

      {groups && groups.mine.length > 0 ? (
        <section aria-labelledby="mine-title">
          <h2 id="mine-title" className={styles.heading}>
            Your tables
          </h2>
          <ul className={styles.list}>
            {groups.mine.map((entry) => (
              <Row
                key={entry.id.toString()}
                entry={entry}
                action={
                  entry.table.phase === Phase.Joining ? (
                    <button
                      type="button"
                      className="button button-ghost"
                      disabled={tx.busy}
                      onClick={() => void tx.run(leaveWrite(entry.id)).then(() => lobby.refetch())}
                    >
                      Leave
                    </button>
                  ) : (
                    <Link className="button button-ghost" href={`/table/${entry.id}`}>
                      Open
                    </Link>
                  )
                }
              />
            ))}
          </ul>
          <EncryptedAmountNote />
        </section>
      ) : null}

      {groups ? (
        <section aria-labelledby="open-title">
          <h2 id="open-title" className={styles.heading}>
            Open tables
          </h2>
          {groups.open.length === 0 ? (
            <p className={styles.muted}>No open table right now. Create one below and share its link.</p>
          ) : (
            <ul className={styles.list}>
              {groups.open.map((entry) => (
                <Row
                  key={entry.id.toString()}
                  entry={entry}
                  action={
                    <Link className="button button-primary" href={`/play?table=${entry.id}`}>
                      Join
                    </Link>
                  }
                />
              ))}
            </ul>
          )}
        </section>
      ) : null}

      <section aria-labelledby="create-title" className={styles.card}>
        <h2 id="create-title" className={styles.heading}>
          Create a table
        </h2>
        <CreateTableForm />
      </section>

      {groups && groups.finished.length > 0 ? (
        <section aria-labelledby="finished-title">
          <h2 id="finished-title" className={styles.heading}>
            Recently finished
          </h2>
          <ul className={styles.list}>
            {groups.finished.map((entry) => (
              <Row key={entry.id.toString()} entry={entry} />
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
