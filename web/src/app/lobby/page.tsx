import type { Metadata } from "next";

import { LobbyView } from "@/components/LobbyView";

import styles from "../play/page.module.css";

export const metadata: Metadata = {
  title: "Lobby",
  description: "Open tables, your tables and a form to create a new one.",
};

export default function LobbyPage() {
  return (
    <div className="container">
      <header className={styles.intro}>
        <h1 className={styles.title}>Lobby</h1>
        <p className={styles.lead}>The newest 50 tables on Sepolia, read straight from the contract.</p>
      </header>
      <LobbyView />
    </div>
  );
}
