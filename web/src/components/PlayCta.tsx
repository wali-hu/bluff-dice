import Link from "next/link";

import { formatEstimate, type PlayEstimate } from "@/lib/estimate";

import styles from "./PlayCta.module.css";

interface PlayCtaProps {
  estimate: PlayEstimate;
}

/**
 * Primary call to action. Disabled until the onboarding flow exists (step E4); the cost line always comes from
 * lib/estimate.ts.
 */
export function PlayCta({ estimate }: PlayCtaProps) {
  const text = formatEstimate(estimate);
  return (
    <section className={styles.cta} aria-labelledby="play-title">
      <h2 id="play-title" className="visually-hidden">
        Play
      </h2>
      <div className={styles.actions}>
        <button type="button" className="button button-primary" disabled aria-describedby="play-cost play-status">
          Play
        </button>
        <Link href="/how-to-play" className="button button-ghost">
          How to play
        </Link>
      </div>
      <p id="play-cost" className={styles.cost}>
        Play: {text}
        {estimate.measured ? "" : " (estimate)"}.
      </p>
      <p id="play-status" className={styles.status}>
        Playing opens soon. Until then, learn the rules in under a minute.
      </p>
    </section>
  );
}
