"use client";

import Link from "next/link";
import { useEffect, useRef } from "react";

import { useTxQueue } from "@/chain/TxQueueProvider";
import { usePlayNow } from "@/chain/usePlayNow";
import { PLAY_STEP_LABELS, PLAY_STEPS, progressOf, UPGRADE_NOTICE } from "@/lib/playNow";
import { useSearchParam } from "@/lib/useSearchParam";

import styles from "./PlayNow.module.css";

const MARK = { done: "✓", active: "…", failed: "!", todo: "" } as const;
const STEP_CLASS = {
  done: styles.stepDone,
  active: styles.stepActive,
  failed: styles.stepFailed,
  todo: styles.stepTodo,
};

/**
 * One button, one progress bar: Connect -> Sepolia -> [Claim chips] -> [Authorize table] -> Take a seat -> Sign.
 * Every remaining step runs in order; the player only confirms in the wallet. A rejection stops at that step and
 * "Try again" resumes there (finished steps are read from the chain and never redone).
 */
export function PlayNow() {
  const tableParam = useSearchParam("table");
  const requested = tableParam && /^\d+$/.test(tableParam) ? BigInt(tableParam) : undefined;
  const { run, done, seatedId, elsewhereId, start, oneByOne, joinAnyway } = usePlayNow(requested);
  const tx = useTxQueue();
  const progress = progressOf(done, run);
  const allDone = PLAY_STEPS.every((s) => progress[s] === "done");

  // Home's "Play now" opens /play?start=1: that click starts the run here once.
  const autoStart = useSearchParam("start");
  const started = useRef(false);
  useEffect(() => {
    if (autoStart !== "1" || started.current) return;
    started.current = true;
    const url = new URL(window.location.href);
    url.searchParams.delete("start");
    window.history.replaceState(null, "", url);
    void start();
  }, [autoStart, start]);

  const label = run.running ? "Working…" : run.failed ? "Try again" : allDone ? "Go to your table" : "Play now";

  return (
    <section className={styles.card} aria-labelledby="playnow-title">
      <h2 id="playnow-title" className={styles.title}>
        Play now
      </h2>
      <p className={styles.lead}>
        One button. Steps you have already done are skipped; you only confirm in your wallet.
      </p>

      <ol className={styles.bar} aria-label="Progress">
        {PLAY_STEPS.map((step) => (
          <li key={step} className={`${styles.step} ${STEP_CLASS[progress[step]]}`}>
            <span className={styles.mark} aria-hidden="true">
              {MARK[progress[step]]}
            </span>
            <span className={styles.stepLabel}>{PLAY_STEP_LABELS[step]}</span>
            <span className="visually-hidden">
              {progress[step] === "done"
                ? " (done)"
                : progress[step] === "active"
                  ? " (in progress)"
                  : progress[step] === "failed"
                    ? " (stopped)"
                    : ""}
            </span>
          </li>
        ))}
      </ol>

      {elsewhereId !== null ? (
        <div className={styles.notice} role="status">
          <p>
            You already have a seat at table #{elsewhereId.toString()}.{" "}
            {requested !== undefined
              ? `You have not joined table #${requested.toString()} yet.`
              : "Play now will not take a second seat unless you ask for it."}{" "}
            One account can sit at more than one table; each seat locks its own stake.
          </p>
          <div className={styles.actions}>
            <Link className="button button-primary" href={`/table/${elsewhereId}`}>
              Open table #{elsewhereId.toString()}
            </Link>
            <button type="button" className="button button-ghost" disabled={tx.busy} onClick={joinAnyway}>
              {requested !== undefined ? `Join table #${requested.toString()} too` : "Take another seat anyway"}
            </button>
          </div>
        </div>
      ) : null}

      {elsewhereId === null ? (
        <div className={styles.actions}>
          {allDone && seatedId !== undefined ? (
            <Link className="button button-primary" href={`/table/${seatedId}`}>
              Go to your table
            </Link>
          ) : (
            <button
              type="button"
              className="button button-primary"
              disabled={run.running || (tx.busy && !run.running)}
              onClick={() => void start()}
            >
              {label}
            </button>
          )}
          {run.failed &&
          run.failed.step !== "sign" &&
          !run.preferSequential &&
          (run.path === "batch" || run.path === "batchWithUpgrade") ? (
            <button
              type="button"
              className="button button-ghost"
              onClick={() => {
                oneByOne();
                void start();
              }}
            >
              Do it one by one
            </button>
          ) : null}
          {run.failed?.step === "sign" && seatedId !== undefined ? (
            <Link className="button button-ghost" href={`/table/${seatedId}`}>
              Go to your table
            </Link>
          ) : null}
        </div>
      ) : null}

      <div aria-live="polite" className={styles.status}>
        {run.running && run.path === "batchWithUpgrade" ? <p className={styles.notice}>{UPGRADE_NOTICE}</p> : null}
        {run.status ? <p>{run.status}</p> : null}
        {!run.running && tx.busy && tx.reason ? <p>{tx.reason}</p> : null}
        {run.failed ? (
          <div className={styles.error} role="alert">
            <p>{run.failed.message}</p>
            {run.failed.detail ? (
              <details>
                <summary>Technical details</summary>
                <p className="mono">{run.failed.detail}</p>
              </details>
            ) : null}
          </div>
        ) : null}
      </div>
    </section>
  );
}
