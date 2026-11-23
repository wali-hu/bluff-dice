import type { Metadata } from "next";

import { ChipsCard } from "@/components/ChipsCard";
import { FheInitPanel } from "@/components/FheInitPanel";
import { WalletGate } from "@/components/Gates";
import { ReadinessChecklist } from "@/components/ReadinessChecklist";

import styles from "./page.module.css";

export const metadata: Metadata = {
  title: "Get ready to play",
  description: "Check your wallet, network and test ETH before your first game of Bluff.",
};

/** Shell of the onboarding route (S2). The stepper (claim chips, authorize, join) arrives in step E4. */
export default function PlayPage() {
  return (
    <div className="container">
      <header className={styles.intro}>
        <h1 className={styles.title}>Get ready to play</h1>
        <p className={styles.lead}>
          Bluff runs on the Ethereum Sepolia testnet. Check these first; tables open in the next update.
        </p>
      </header>
      <WalletGate />
      <section className={styles.card} aria-labelledby="ready-title">
        <h2 id="ready-title" className={styles.cardTitle}>
          Your setup
        </h2>
        <ReadinessChecklist />
      </section>
      <FheInitPanel />
      <ChipsCard />
    </div>
  );
}
