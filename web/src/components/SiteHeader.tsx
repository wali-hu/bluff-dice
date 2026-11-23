import Link from "next/link";

import { ConnectButton } from "./ConnectButton";
import { NavLinks } from "./NavLinks";
import styles from "./SiteHeader.module.css";

export function SiteHeader() {
  return (
    <header className={styles.header}>
      <div className={`container ${styles.inner}`}>
        <Link href="/" className={styles.wordmark} aria-label="Bluff, home">
          Bluff
        </Link>
        <div className={styles.nav}>
          <NavLinks />
        </div>
        <div className={styles.connect}>
          <ConnectButton />
        </div>
      </div>
    </header>
  );
}
