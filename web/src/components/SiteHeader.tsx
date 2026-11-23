import Link from "next/link";

import { NavLinks } from "./NavLinks";
import styles from "./SiteHeader.module.css";

export function SiteHeader() {
  return (
    <header className={styles.header}>
      <div className={`container ${styles.inner}`}>
        <Link href="/" className={styles.wordmark} aria-label="Bluff, home">
          Bluff
        </Link>
        <NavLinks />
      </div>
    </header>
  );
}
