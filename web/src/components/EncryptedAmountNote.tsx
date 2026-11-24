import styles from "./EncryptedAmountNote.module.css";

/**
 * Shown next to every button whose transaction moves chips (claim, create, join, leave). Chip amounts are
 * encrypted (ERC-7984), so wallets cannot simulate them and show "No changes" in their preview.
 */
export function EncryptedAmountNote() {
  return (
    <p className={styles.note}>
      Your wallet may show &ldquo;No changes&rdquo; for this transaction: chip amounts are encrypted, so it cannot
      preview them. The chips still move.
    </p>
  );
}
