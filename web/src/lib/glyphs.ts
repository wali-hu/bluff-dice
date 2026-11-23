/**
 * Decorative "ciphertext" noise for hidden dice. These characters are random UI noise, NEVER a real handle or
 * ciphertext: the app does not show raw handles to players.
 */
export const HEX_GLYPHS = "0123456789abcdef";

/** Small deterministic PRNG (mulberry32) so server and client render the same first frame. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function glyphNoise(count: number, random: () => number): string[] {
  return Array.from({ length: count }, () => HEX_GLYPHS[Math.floor(random() * HEX_GLYPHS.length)] as string);
}
