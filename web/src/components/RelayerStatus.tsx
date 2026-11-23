"use client";

import { useFheStatus } from "@/fhe/FheProvider";
import type { FheChannel } from "@/fhe/status";
import { useNow } from "@/lib/useNow";

import styles from "./RelayerStatus.module.css";

interface RelayerStatusProps {
  channel: FheChannel;
  /** Shown while nothing has run yet. */
  idleText?: string;
  /** Typical duration, e.g. "usually 4-10 s". */
  hint?: string;
  onRetry?: () => void;
}

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`;
}

/** Every wait in words: what is happening, for how long, and Retry when it failed. */
export function RelayerStatus({ channel, idleText, hint, onRetry }: RelayerStatusProps) {
  const status = useFheStatus(channel);
  const now = useNow();
  const elapsed = status.startedAt && now ? Math.max(0, now - status.startedAt) : 0;

  let body: React.ReactNode = idleText ?? null;
  let tone = styles.idle;
  if (status.phase === "running" || status.phase === "retrying") {
    tone = styles.running;
    body = (
      <>
        {status.label}… <span className="mono">{Math.floor(elapsed / 1000)} s</span>
        {hint ? <span className={styles.hint}> ({hint})</span> : null}
        {status.detail ? <span className={styles.detail}>{status.detail}.</span> : null}
        {status.phase === "retrying" && status.lastError ? (
          <span className={styles.detail}>
            {status.lastError.message} Trying again automatically (attempt {status.attempt}).
          </span>
        ) : null}
      </>
    );
  } else if (status.phase === "ok" && status.startedAt && status.endedAt) {
    tone = styles.ok;
    body = (
      <>
        {status.label}: done in <span className="mono">{seconds(status.endedAt - status.startedAt)}</span>.
      </>
    );
  } else if (status.phase === "failed" || status.phase === "timedOut") {
    tone = styles.failed;
    body = (
      <>
        {status.label}: {status.lastError?.message ?? "failed."}{" "}
        {onRetry ? (
          <button type="button" className={`button button-ghost ${styles.retry}`} onClick={onRetry}>
            Retry
          </button>
        ) : null}
      </>
    );
  }

  if (body === null) return null;
  return (
    <p className={`${styles.status} ${tone}`} role="status" aria-live="polite">
      {body}
    </p>
  );
}
