import type { Metadata } from "next";

import { ChipsCard } from "@/components/ChipsCard";
import { FheInitPanel } from "@/components/FheInitPanel";
import { WalletGate } from "@/components/Gates";
import { OnboardingStepper } from "@/components/OnboardingStepper";
import { PlayNow } from "@/components/PlayNow";

import styles from "./page.module.css";

export const metadata: Metadata = {
  title: "Play",
  description: "Connect, claim free test chips, authorize the table and take a seat.",
};

export default function PlayPage() {
  return (
    <div className="container">
      <header className={styles.intro}>
        <h1 className={styles.title}>Play</h1>
        <p className={styles.lead}>
          Press Play now and confirm in your wallet. Steps you have already done are skipped.
        </p>
      </header>
      <WalletGate />
      <PlayNow />
      <details className={styles.diagnostics}>
        <summary>Do it step by step</summary>
        <OnboardingStepper />
      </details>
      <details className={styles.diagnostics}>
        <summary>Encryption toolkit and chip balance</summary>
        <FheInitPanel />
        <ChipsCard />
      </details>
    </div>
  );
}
