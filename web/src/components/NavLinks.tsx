"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import styles from "./SiteHeader.module.css";

const LINKS = [
  { href: "/", label: "Home" },
  { href: "/how-to-play", label: "How to play" },
] as const;

export function NavLinks() {
  const pathname = usePathname();
  return (
    <nav aria-label="Main">
      <ul className={styles.nav}>
        {LINKS.map((link) => {
          const current = pathname === link.href;
          return (
            <li key={link.href}>
              <Link href={link.href} className={styles.navLink} aria-current={current ? "page" : undefined}>
                {link.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
