import styles from "./FeatureStrip.module.css";

const FEATURES = [
  {
    title: "Hidden dice",
    text: "Every die is encrypted with FHE. Only you can decrypt yours.",
  },
  {
    title: "Fair dice",
    text: "Dice come from encrypted randomness onchain. No dealer, and the contract owner cannot see them either.",
  },
  {
    title: "Verify every round",
    text: "The reveal carries a KMS decryption proof that the contract checks onchain.",
  },
] as const;

/** Three short promises under the Play button. */
export function FeatureStrip() {
  return (
    <ul className={styles.strip} aria-label="Why it is fair">
      {FEATURES.map((feature) => (
        <li key={feature.title} className={styles.item}>
          <h2 className={styles.title}>{feature.title}</h2>
          <p className={styles.text}>{feature.text}</p>
        </li>
      ))}
    </ul>
  );
}
