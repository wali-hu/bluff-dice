"use client";

import { useTxQueue } from "@/chain/TxQueueProvider";
import { ETHERSCAN_BASE_URL } from "@/config/links";

import styles from "./TxStatus.module.css";

/** The one write in flight, in words, with its Etherscan link; errors in words with Dismiss. */
export function TxStatus() {
  const { state, reason, reset } = useTxQueue();
  if (state.status === "idle") return null;

  if (state.status === "reverted" || state.status === "blocked") {
    if (state.error.kind === "contract" && state.error.silent) return null;
    if (state.error.kind === "contract" && state.error.soft) {
      // E5-R7: an expected "not yet" (e.g. DeadlineNotPassed) is information, not a failure.
      return (
        <div className={styles.box} role="status">
          <p className={styles.text}>{state.error.message}</p>
          <button type="button" className="button button-ghost" onClick={reset}>
            OK
          </button>
        </div>
      );
    }
    return (
      <div className={`${styles.box} ${styles.error}`} role="alert">
        <p className={styles.text}>
          {state.label}: {state.error.message}
          {state.status === "reverted" && state.hash ? (
            <>
              {" "}
              <a href={`${ETHERSCAN_BASE_URL}/tx/${state.hash}`} target="_blank" rel="noopener noreferrer">
                View on Etherscan
              </a>
            </>
          ) : null}
        </p>
        <button type="button" className="button button-ghost" onClick={reset}>
          {state.status === "blocked" ? "I cleared it, continue" : "Dismiss"}
        </button>
      </div>
    );
  }

  if (state.status === "confirmed") {
    return (
      <div className={styles.box} role="status">
        <p className={styles.text}>
          {state.label}: confirmed in block {state.blockNumber.toString()}.{" "}
          <a href={`${ETHERSCAN_BASE_URL}/tx/${state.hash}`} target="_blank" rel="noopener noreferrer">
            View on Etherscan
          </a>
        </p>
      </div>
    );
  }

  return (
    <div className={styles.box} role="status" aria-live="polite">
      <p className={styles.text}>
        {reason}
        {state.status === "pending" ? (
          <>
            {" "}
            <a href={`${ETHERSCAN_BASE_URL}/tx/${state.hash}`} target="_blank" rel="noopener noreferrer">
              View on Etherscan
            </a>
          </>
        ) : null}
      </p>
    </div>
  );
}
