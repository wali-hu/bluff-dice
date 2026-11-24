import { ETHERSCAN_BASE_URL } from "@/config/links";
import type { HistoryView } from "@/lib/timeline";

import styles from "./GameTable.module.css";

/** Bids newest first (BidPlaced events); degraded: the current bid read from the contract. */
export function BidHistory({ view, seatName }: { view: HistoryView; seatName: (who: string | number) => string }) {
  if (view.kind === "degraded") {
    return (
      <section aria-labelledby="bids-title">
        <h2 id="bids-title" className={styles.sectionTitle}>
          Bids
        </h2>
        <p className={styles.muted}>
          {view.current
            ? `Current bid: ${view.current.quantity} × ${view.current.face} by ${seatName(view.current.bidderSeat)}.`
            : "No bid yet."}{" "}
          Bid history is unavailable right now; the current bid comes straight from the contract.
        </p>
      </section>
    );
  }
  return (
    <section aria-labelledby="bids-title">
      <h2 id="bids-title" className={styles.sectionTitle}>
        Bids
      </h2>
      {view.bids.length === 0 ? (
        <p className={styles.muted}>No bid yet.</p>
      ) : (
        <ol className={styles.history}>
          {view.bids.map((b, i) => (
            <li key={`${b.txHash}:${b.logIndex}`} className={i === 0 ? styles.latestBid : undefined}>
              <span className={styles.bidText}>
                {b.quantity} × {b.face}
              </span>{" "}
              <span className={styles.muted}>by {seatName(b.bidder)}</span>{" "}
              <a
                href={`${ETHERSCAN_BASE_URL}/tx/${b.txHash}`}
                target="_blank"
                rel="noopener noreferrer"
                className={styles.txLink}
              >
                tx
              </a>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
