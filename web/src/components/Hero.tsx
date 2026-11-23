import { MAX_PLAYERS, MIN_PLAYERS } from "@/config/game";
import { etherscanAddressUrl } from "@/config/links";
import { BLUFF_DICE_ADDRESS } from "@/contracts/addresses";

import { BoneDie } from "./BoneDie";
import { CipherDie } from "./CipherDie";
import { DiceRow } from "./DiceRow";
import styles from "./Hero.module.css";

const OPPONENT_SEEDS = [11, 23, 37, 41, 59] as const;

/** "Ciphertext under the cup": the opponent's cup is encrypted, your own die is face up. */
export function Hero() {
  return (
    <section className={styles.hero} aria-labelledby="hero-title">
      <div className={styles.copy}>
        <div className={styles.eyebrow}>
          <span className={styles.players}>
            Bluffing for {MIN_PLAYERS}–{MAX_PLAYERS} players
          </span>
          <a
            className={styles.live}
            href={etherscanAddressUrl(BLUFF_DICE_ADDRESS)}
            target="_blank"
            rel="noopener noreferrer"
          >
            <span className={styles.liveDot} aria-hidden="true" />
            Live on Sepolia
            <span className="visually-hidden"> (BluffDice contract on Etherscan, opens in a new tab)</span>
          </a>
        </div>
        <h1 id="hero-title" className={styles.title}>
          Liar&apos;s Dice, with a cup made of encryption.
        </h1>
        <p className={styles.lead}>
          Your dice are encrypted on Ethereum. Only you can read them, until someone calls{" "}
          <span className={styles.liar}>Liar</span>.
        </p>
      </div>
      <figure className={styles.table}>
        <div className={styles.row}>
          <span className={styles.rowLabel}>Their cup</span>
          <DiceRow label="Their cup: 5 hidden dice">
            {OPPONENT_SEEDS.map((seed) => (
              <CipherDie key={seed} seed={seed} />
            ))}
          </DiceRow>
        </div>
        <div className={styles.row}>
          <span className={styles.rowLabel}>Your die</span>
          <DiceRow label="Your die">
            <BoneDie face={5} />
          </DiceRow>
        </div>
        <figcaption className={styles.caption}>
          Hidden dice show random noise, not real data. Each die can be decrypted only by its owner.
        </figcaption>
      </figure>
    </section>
  );
}
