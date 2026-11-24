"use client";

import { useTxQueue } from "@/chain/TxQueueProvider";
import { cancelWrite } from "@/chain/writes";
import { defaultDescribeContext } from "@/lib/errors";
import { cancelState } from "@/lib/tableRoom";
import { useNow } from "@/lib/useNow";

import { EncryptedAmountNote } from "./EncryptedAmountNote";
import styles from "./TableRoom.module.css";

/**
 * Stuck tables give the stakes back: after the proof deadline anyone may call `cancel`, and every seat gets its
 * own stake back. Shown to seated players and spectators alike.
 */
export function CancelPanel({ tableId, phase, deadline }: { tableId: bigint; phase: number; deadline: bigint }) {
  const tx = useTxQueue();
  const now = BigInt(Math.floor(useNow() / 1000));
  const state = cancelState(phase, deadline, now);
  if (state.kind === "none") return null;
  if (state.kind === "wait") {
    return (
      <p className={styles.muted}>
        If this step is not sent onchain by {defaultDescribeContext.formatTime(state.deadline)}, anyone can cancel the
        table and every player gets their own stake back.
      </p>
    );
  }
  return (
    <div>
      <p className={styles.muted}>
        The deadline has passed. Anyone can now cancel this table: every player gets their own stake back.
      </p>
      <button
        type="button"
        className="button button-ghost"
        disabled={tx.busy}
        onClick={() => void tx.run(cancelWrite(tableId))}
      >
        Cancel table and refund every stake
      </button>
      <EncryptedAmountNote />
    </div>
  );
}
