import { BID_TIMEOUT_SECONDS, DICE_PER_PLAYER, MAX_PLAYERS, MIN_PLAYERS } from "@/config/game";

import styles from "./HowToPlayCards.module.css";

const turnMinutes = BID_TIMEOUT_SECONDS / 60;

/** The rules in four cards. Every sentence matches what BluffDice enforces. */
export function HowToPlayCards() {
  return (
    <ol className={styles.cards}>
      <li className={styles.card}>
        <span className={styles.step}>1</span>
        <h2 className={styles.title}>Everyone rolls in secret</h2>
        <p>
          {MIN_PLAYERS} to {MAX_PLAYERS} players, {DICE_PER_PLAYER} dice each, same stake for everyone. Your dice are
          encrypted on chain: only you can decrypt them.
        </p>
      </li>
      <li className={styles.card}>
        <span className={styles.step}>2</span>
        <h2 className={styles.title}>Bid on the whole table</h2>
        <p>
          A bid says &ldquo;at least <strong>Q</strong> dice on the table show face <strong>F</strong>&rdquo;, counting
          every player&apos;s dice. The first seat (usually the table creator) opens. Ones are not wild.
        </p>
      </li>
      <li className={styles.card}>
        <span className={styles.step}>3</span>
        <h2 className={styles.title}>Raise, or call Liar</h2>
        <p>
          On your turn, raise: more dice, or the same number with a higher face. Or call <em>Liar</em> on the previous
          bid. You have {turnMinutes} minutes per turn; run out of time and you lose.
        </p>
      </li>
      <li className={styles.card}>
        <span className={styles.step}>4</span>
        <h2 className={styles.title}>Reveal and settle</h2>
        <p>
          &ldquo;Liar&rdquo; reveals every die. At least <strong>Q</strong> show <strong>F</strong>: the bid was true
          and the caller loses. Fewer: the bidder loses. The loser&apos;s stake is lost; the other players split the
          pot. One call ends the game.
        </p>
      </li>
    </ol>
  );
}
