import styles from "./Dice.module.css";

interface DiceRowProps {
  label: string;
  children: React.ReactNode;
}

/** One cup of dice on a single line; each die sizes itself to 1/5 of the row (max 64 px). */
export function DiceRow({ label, children }: DiceRowProps) {
  return (
    <div className={styles.row} role="group" aria-label={label}>
      {children}
    </div>
  );
}
