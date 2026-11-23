import type { Metadata } from "next";

import { ExampleBid } from "@/components/ExampleBid";
import { HowToPlayCards } from "@/components/HowToPlayCards";

import styles from "./page.module.css";

export const metadata: Metadata = {
  title: "How to play",
  description: "The rules of Bluff (Liar's Dice with encrypted dice) in under a minute.",
};

export default function HowToPlayPage() {
  return (
    <div className="container">
      <header className={styles.intro}>
        <h1 className={styles.title}>How to play</h1>
        <p className={styles.lead}>Four rules, one example. Under a minute.</p>
      </header>
      <HowToPlayCards />
      <ExampleBid />
      <aside className={styles.note} aria-label="About the bot opponent">
        <h2 className={styles.noteTitle}>Coming later: a bot opponent</h2>
        <p>
          The bot is just another player: the ACL lets it read only its own dice, and the contracts have no admin key.
          Your decryption key lives only in your tab; you trust the page code (open source, pinned SDK) and the KMS
          threshold, as with every FHEVM app.
        </p>
      </aside>
    </div>
  );
}
