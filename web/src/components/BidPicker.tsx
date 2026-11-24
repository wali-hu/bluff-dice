"use client";

import { useState } from "react";

import { useTxQueue } from "@/chain/TxQueueProvider";
import { bidWrite } from "@/chain/writes";
import { BID_RULE_TEXT, legalFaces, maxQuantity, smallestLegalBid, type BidContext } from "@/lib/bidRules";

import { BoneDie } from "./BoneDie";
import styles from "./GameTable.module.css";

/** Quantity stepper + 6 face buttons; only bids that raise the current one are enabled (BluffDice._validateBid). */
export function BidPicker({ tableId, ctx }: { tableId: bigint; ctx: BidContext }) {
  const tx = useTxQueue();
  // E5-R5: the picker starts at the smallest legal bid.
  const start = smallestLegalBid(ctx);
  const min = start?.quantity ?? 1;
  const max = maxQuantity(ctx.playerCount);
  const [quantity, setQuantity] = useState<number>(min);
  const q = Math.min(max, Math.max(min, quantity));
  const faces = legalFaces(ctx, q);
  const [face, setFace] = useState<number | null>(start?.face ?? null);
  const chosen = face !== null && faces.includes(face) ? face : null;

  if (start === null) {
    return <p className={styles.muted}>No higher bid is possible. Call LIAR!</p>;
  }

  return (
    <div className={styles.picker}>
      <p className={styles.rule}>{BID_RULE_TEXT}</p>
      <div className={styles.stepper} role="group" aria-label="Quantity">
        <button
          type="button"
          className="button button-ghost"
          aria-label="One die fewer"
          disabled={q <= min}
          onClick={() => setQuantity(q - 1)}
        >
          −
        </button>
        <span className={styles.quantity} aria-live="polite">
          {q} ×
        </span>
        <button
          type="button"
          className="button button-ghost"
          aria-label="One die more"
          disabled={q >= max}
          onClick={() => setQuantity(q + 1)}
        >
          +
        </button>
      </div>
      <div className={styles.faces} role="group" aria-label="Face">
        {[1, 2, 3, 4, 5, 6].map((f) => (
          <button
            key={f}
            type="button"
            className={`${styles.faceButton} ${chosen === f ? styles.faceChosen : ""}`}
            disabled={!faces.includes(f)}
            aria-pressed={chosen === f}
            aria-label={`Face ${f}`}
            onClick={() => setFace(f)}
          >
            <BoneDie face={f} size="chip" />
          </button>
        ))}
      </div>
      <button
        type="button"
        className="button button-primary"
        disabled={chosen === null || tx.busy}
        onClick={() => chosen !== null && void tx.run(bidWrite(tableId, q, chosen))}
      >
        {chosen === null ? "Pick a face" : `Bid ${q} × ${chosen}`}
      </button>
    </div>
  );
}
