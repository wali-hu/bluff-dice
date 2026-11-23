/**
 * Colour tokens. Mirrored as CSS custom properties on :root in app/globals.css (a unit test keeps both in sync).
 */
export const COLORS = {
  ink: "#0E1219", // table background
  slate: "#1A2130", // surfaces
  bone: "#EDE6D6", // dice, main text
  boneMuted: "#A8A193", // secondary text
  brass: "#C9A24B", // turn, primary action
  ember: "#E0533D", // Liar, loser
  verdigris: "#3FA38C", // verified onchain
} as const;

export type ColorName = keyof typeof COLORS;

/** CSS custom property name for each token. */
export const CSS_VARS: Record<ColorName, string> = {
  ink: "--ink",
  slate: "--slate",
  bone: "--bone",
  boneMuted: "--bone-muted",
  brass: "--brass",
  ember: "--ember",
  verdigris: "--verdigris",
};

export interface TextPair {
  readonly fg: ColorName;
  readonly bg: ColorName;
  /** Large text (>= 24 px, or >= 18.66 px bold): WCAG AA needs 3:1 instead of 4.5:1. */
  readonly large: boolean;
  readonly use: string;
}

/**
 * Every foreground/background pair the app uses for TEXT. Adding a new pair in CSS means adding it here; the
 * contrast test enforces WCAG AA. Ember on slate is 4.2:1, so it is only allowed for large display text.
 */
export const TEXT_PAIRS: readonly TextPair[] = [
  { fg: "bone", bg: "ink", large: false, use: "body text" },
  { fg: "bone", bg: "slate", large: false, use: "text on cards, header, footer" },
  { fg: "boneMuted", bg: "ink", large: false, use: "secondary text" },
  { fg: "boneMuted", bg: "slate", large: false, use: "secondary text on cards, disabled button label" },
  { fg: "brass", bg: "ink", large: false, use: "links, wordmark, step labels" },
  { fg: "brass", bg: "slate", large: false, use: "links and labels on cards" },
  { fg: "ink", bg: "brass", large: false, use: "primary button label" },
  { fg: "ink", bg: "bone", large: false, use: "text on bone (bid chip)" },
  { fg: "ember", bg: "ink", large: false, use: "LIAR!, loser" },
  { fg: "ember", bg: "slate", large: true, use: "LIAR! display text on cards" },
  { fg: "verdigris", bg: "ink", large: false, use: "verified onchain" },
  { fg: "verdigris", bg: "slate", large: false, use: "verified onchain on cards" },
];
