import { pipCells } from "@/lib/pips";

import styles from "./Dice.module.css";

interface BoneDieProps {
  face: number;
  /** Highlight (e.g. the die matches the bid face during a reveal). */
  lit?: boolean;
  /** "row" sizes from the enclosing DiceRow; "chip" is a fixed small die inside text. */
  size?: "row" | "chip";
}

/** A face-up die: the player's own die after decryption, or any die after the reveal. */
export function BoneDie({ face, lit = false, size = "row" }: BoneDieProps) {
  const cells = pipCells(face);
  return (
    <span
      role="img"
      aria-label={`Die showing ${face}`}
      className={`${styles.die} ${styles.bone} ${size === "chip" ? styles.chip : ""} ${lit ? styles.lit : ""}`}
    >
      {Array.from({ length: 9 }, (_, cell) => (
        <span key={cell} className={cells.includes(cell) ? styles.pip : styles.empty} aria-hidden="true" />
      ))}
    </span>
  );
}
