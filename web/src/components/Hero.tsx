import { BoneDie } from "./BoneDie";
import { CipherDie } from "./CipherDie";
import styles from "./Hero.module.css";

const OPPONENT_SEEDS = [11, 23, 37, 41, 59] as const;

/** "Ciphertext under the cup": the opponent's cup is encrypted, your own die is face up. */
export function Hero() {
  return (
    <section className={styles.hero} aria-labelledby="hero-title">
      <div className={styles.copy}>
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
          <div className={styles.dice}>
            {OPPONENT_SEEDS.map((seed) => (
              <CipherDie key={seed} seed={seed} size="sm" />
            ))}
          </div>
        </div>
        <div className={styles.row}>
          <span className={styles.rowLabel}>Your die</span>
          <div className={styles.dice}>
            <BoneDie face={5} />
          </div>
        </div>
        <figcaption className={styles.caption}>
          Hidden dice show random noise, not real data. Each die can be decrypted only by its owner.
        </figcaption>
      </figure>
    </section>
  );
}
