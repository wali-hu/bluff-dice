import { deadlineRing } from "@/lib/tableView";

import styles from "./GameTable.module.css";

const R = 18;
const C = 2 * Math.PI * R;

/** Seconds left until the turn or proof deadline, as a draining ring (static: it only redraws once a second). */
export function DeadlineRing({ phase, deadline, nowSeconds }: { phase: number; deadline: bigint; nowSeconds: bigint }) {
  const ring = deadlineRing(phase, deadline, nowSeconds);
  if (!ring) return null;
  const what = phase === 3 ? "Turn" : "Proof deadline";
  return (
    <span
      className={styles.ring}
      role="timer"
      aria-live="off"
      aria-label={`${what}: ${ring.expired ? ring.label : `${ring.label} left`}`}
    >
      <svg width="44" height="44" viewBox="0 0 44 44" aria-hidden="true">
        <circle cx="22" cy="22" r={R} className={styles.ringTrack} />
        <circle
          cx="22"
          cy="22"
          r={R}
          className={ring.expired ? styles.ringExpired : styles.ringFill}
          strokeDasharray={C}
          strokeDashoffset={C * (1 - ring.fraction)}
          transform="rotate(-90 22 22)"
        />
      </svg>
      <span className={styles.ringText}>
        {what}: {ring.expired ? ring.label : `${ring.label} left`}
      </span>
    </span>
  );
}
