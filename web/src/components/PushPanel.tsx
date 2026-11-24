"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { usePublicClient } from "wagmi";

import { getPaidHandles, getRevealHandles, getTable } from "@/chain/reads";
import { useTxQueue } from "@/chain/TxQueueProvider";
import { FheError } from "@/fhe/errors";
import { useFheClient } from "@/fhe/FheProvider";
import { pushHandleView, runPush, type PushOutcome } from "@/lib/push";
import { pushGasNote, type PushKind } from "@/lib/tableView";

import styles from "./GameTable.module.css";
import { RelayerStatus } from "./RelayerStatus";

const COPY: Record<PushKind, { title: string; button: string; what: string }> = {
  deal: {
    title: "Deal the dice",
    button: "Deal the dice",
    what: "The KMS decrypts every seat's paid flag; the contract checks the proof and, if every stake arrived, deals.",
  },
  reveal: {
    title: "Reveal the dice",
    button: "Reveal the dice",
    what: "The KMS decrypts every die; the contract checks the proof, counts the bid face and pays the winners.",
  },
};

/**
 * Manual push (E5; the automatic pusher election is E6): public decrypt of the handle list the CONTRACT returns
 * (paidHandles / revealHandles, never rebuilt here), then startGame / finalizeReveal with the cleartexts and the
 * proof byte for byte. Anyone may push; losing the race is a success.
 */
export function PushPanel({ tableId, kind, players }: { tableId: bigint; kind: PushKind; players: number }) {
  const client = usePublicClient();
  const fhe = useFheClient();
  const tx = useTxQueue();
  const queryClient = useQueryClient();
  const [outcome, setOutcome] = useState<PushOutcome | null>(null);
  const [busy, setBusy] = useState(false);
  const copy = COPY[kind];

  async function push() {
    if (!client) return;
    setBusy(true);
    setOutcome(null);
    try {
      // E5-R16: every step lives in runPush (lib/push.ts); here only the real chain, KMS and wallet are plugged in.
      const out = await runPush({
        kind,
        tableId,
        readPhase: async () => (await getTable(client, tableId)).phase,
        readHandles: () =>
          pushHandleView(kind) === "paidHandles" ? getPaidHandles(client, tableId) : getRevealHandles(client, tableId),
        publicDecrypt: (handles) => fhe.publicDecrypt(handles),
        send: async (write) => {
          const sent = await tx.run(write);
          return sent.ok ? { ok: true as const } : { ok: false as const, error: sent.error };
        },
      });
      setOutcome(out);
      void queryClient.invalidateQueries();
    } catch (error) {
      setOutcome({
        result: "failed",
        message: error instanceof FheError ? error.message : "Could not read the table. Press again.",
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className={styles.panel} aria-labelledby={`push-${kind}`}>
      <h2 id={`push-${kind}`} className={styles.sectionTitle}>
        {copy.title}
      </h2>
      <p className={styles.muted}>{copy.what}</p>
      <p className={styles.muted}>{pushGasNote(kind, players)}</p>
      <button type="button" className="button button-primary" disabled={busy || tx.busy} onClick={() => void push()}>
        {busy ? "Working…" : copy.button}
      </button>
      <RelayerStatus channel="publicDecrypt" hint="usually 4-10 s" onRetry={() => void push()} />
      {outcome ? (
        <p
          className={outcome.result === "pushed" || outcome.result === "alreadyPushed" ? styles.ok : styles.muted}
          role={outcome.result === "failed" ? "alert" : "status"}
        >
          {outcome.message}
        </p>
      ) : null}
    </section>
  );
}
