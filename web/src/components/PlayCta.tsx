import Link from "next/link";

import { formatEstimate, type PlayEstimate } from "@/lib/estimate";

import { BotCta } from "./BotCta";
import styles from "./PlayCta.module.css";

interface PlayCtaProps {
  estimate: PlayEstimate;
}

/**
 * Primary call to action. The cost line always comes from lib/estimate.ts (targets until measured).
 */
export function PlayCta({ estimate }: PlayCtaProps) {
  const text = formatEstimate(estimate);
  return (
    <section className={styles.cta} aria-labelledby="play-title">
      <h2 id="play-title" className="visually-hidden">
        Play
      </h2>
      <div className={styles.actions}>
        <BotCta />
        <Link href="/play" className="button button-primary" aria-describedby="play-cost">
          Play
        </Link>
        <Link href="/how-to-play" className="button button-ghost">
          How to play
        </Link>
      </div>
      <p id="play-cost" className={styles.cost}>
        Play: {text}
        {estimate.measured ? "" : " (estimate)"}.
      </p>
      <p className={styles.status}>
        New here? The rules take under a minute. Prefer to pick a table? <Link href="/lobby">Open the lobby</Link>.
      </p>
    </section>
  );
}
