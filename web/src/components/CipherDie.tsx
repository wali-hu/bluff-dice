"use client";

import { useEffect, useState } from "react";

import { glyphNoise, seededRandom } from "@/lib/glyphs";

import styles from "./Dice.module.css";

const GLYPHS_PER_DIE = 9;
const SCRAMBLE_MS = 220;

interface CipherDieProps {
  /** Seed for the first frame (same on server and client, so hydration matches). */
  seed: number;
  /** Re-scramble the glyphs (skipped when the user prefers reduced motion). */
  animate?: boolean;
  size?: "md" | "sm";
}

/**
 * A hidden die. The glyphs are random noise that only suggests ciphertext; they are not the die's handle.
 */
export function CipherDie({ seed, animate = true, size = "md" }: CipherDieProps) {
  const [glyphs, setGlyphs] = useState(() => glyphNoise(GLYPHS_PER_DIE, seededRandom(seed)));

  useEffect(() => {
    if (!animate) return;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
    if (reduced.matches) return;
    const timer = window.setInterval(() => {
      if (document.hidden) return;
      setGlyphs((current) => {
        const next = [...current];
        const index = Math.floor(Math.random() * next.length);
        next[index] = glyphNoise(1, Math.random)[0] as string;
        return next;
      });
    }, SCRAMBLE_MS);
    return () => window.clearInterval(timer);
  }, [animate]);

  return (
    <span
      role="img"
      aria-label="Hidden die: encrypted, only its owner can read it"
      className={`${styles.die} ${styles.cipher} ${size === "sm" ? styles.sm : ""}`}
    >
      {glyphs.map((glyph, i) => (
        <span key={i} className={styles.glyph} aria-hidden="true">
          {glyph}
        </span>
      ))}
    </span>
  );
}
