"use client";

import { useSyncExternalStore } from "react";

import { onboardingTimer, type StepTimerSnapshot } from "@/lib/stepTimer";
import { useDebugFlag } from "@/lib/useSearchParam";

import styles from "./DebugPanel.module.css";

const subscribe = onboardingTimer.subscribe;
const snapshot = onboardingTimer.snapshot;
const serverSnapshot = (): StepTimerSnapshot | null => null;

function s(ms: number): string {
  return `${(ms / 1000).toFixed(1)} s`;
}

/** `?debug=1`: the onboarding stopwatch (N) and wallet prompt counts (K). Memory only, nothing is logged. */
export function DebugPanel() {
  const debug = useDebugFlag();
  const timer = useSyncExternalStore(subscribe, snapshot, serverSnapshot);
  if (!debug || !timer) return null;
  const total = timer.startedAt !== null && timer.seatedAt !== null ? timer.seatedAt - timer.startedAt : null;
  return (
    <aside className={`container ${styles.panel}`} aria-label="Debug: onboarding timer" data-testid="debug-panel">
      <h2 className={styles.title}>Debug: onboarding timer</h2>
      <dl className={styles.list}>
        {timer.steps.map((row, i) => (
          <div key={`${row.step}-${i}`} className={styles.row}>
            <dt>{row.step}</dt>
            <dd className="mono">{s(row.ms)}</dd>
          </div>
        ))}
        {timer.current ? (
          <div className={styles.row}>
            <dt>{timer.current}</dt>
            <dd className="mono">in progress</dd>
          </div>
        ) : null}
        <div className={styles.row}>
          <dt>Total to seated (N)</dt>
          <dd className="mono" data-testid="debug-total">
            {total === null ? "not seated yet" : s(total)}
          </dd>
        </div>
        <div className={styles.row}>
          <dt>Transactions / signatures (K)</dt>
          <dd className="mono" data-testid="debug-prompts">
            {timer.prompts.transaction} tx + {timer.prompts.signature} sig
          </dd>
        </div>
        <div className={styles.row}>
          <dt>Connect / network prompts</dt>
          <dd className="mono">
            {timer.prompts.connect} / {timer.prompts.switchNetwork}
          </dd>
        </div>
      </dl>
      {timer.notes.length > 0 ? <p className={styles.notes}>{timer.notes.join(" · ")}</p> : null}
    </aside>
  );
}
