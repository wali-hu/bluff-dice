import { glyphNoise, seededRandom } from "@/lib/glyphs";

import styles from "./Dice.module.css";

const GLYPHS_PER_DIE = 9;

interface CipherDieProps {
  /** Seed for the glyph pattern (deterministic, so server and client render the same tile). */
  seed: number;
  /** Screen-reader label, e.g. "Seat 2, die 3: hidden". */
  label?: string;
}

/**
 * A hidden die: a static tile of hex glyphs. The glyphs are random noise that only suggests ciphertext; they are
 * never the die's handle. (The animated scramble was cut, owner decision: static tiles.)
 */
export function CipherDie({ seed, label = "Hidden die: encrypted, only its owner can read it" }: CipherDieProps) {
  const glyphs = glyphNoise(GLYPHS_PER_DIE, seededRandom(seed));
  return (
    <span role="img" aria-label={label} className={`${styles.die} ${styles.cipher}`}>
      {glyphs.map((glyph, i) => (
        <span key={i} className={styles.glyph} aria-hidden="true">
          {glyph}
        </span>
      ))}
    </span>
  );
}
