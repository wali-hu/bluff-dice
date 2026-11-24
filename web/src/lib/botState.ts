import { BOT_FLOOR_WEI } from "@/config/bot";

/** How long the app keeps looking for a new bot table after its seat was taken. */
export const BOT_RESEARCH_MS = 30_000;

export type BotView =
  | { kind: "hidden" }
  | { kind: "ready"; tableId: bigint }
  | { kind: "searching"; secondsLeft: number }
  | { kind: "resting" }
  | { kind: "busy" };

export interface BotInput {
  readonly configured: boolean;
  readonly tableId: bigint | undefined;
  /** Bot ETH balance in wei, undefined while unknown. */
  readonly botBalance: bigint | undefined;
  /** When a join hit WrongPhase (someone took the seat), in ms; null otherwise. */
  readonly seatTakenAt: number | null;
  /** The table whose seat was taken (a stale read may still list it). */
  readonly takenTableId?: bigint | null;
  readonly now: number;
}

/** What the "Play vs Bot" control shows. Pure. */
export function botView({ configured, tableId, botBalance, seatTakenAt, takenTableId = null, now }: BotInput): BotView {
  if (!configured) return { kind: "hidden" };
  if (tableId !== undefined && tableId !== takenTableId) return { kind: "ready", tableId };
  if (seatTakenAt !== null && now - seatTakenAt < BOT_RESEARCH_MS) {
    return { kind: "searching", secondsLeft: Math.ceil((BOT_RESEARCH_MS - (now - seatTakenAt)) / 1000) };
  }
  if (botBalance !== undefined && botBalance < BOT_FLOOR_WEI) return { kind: "resting" };
  return { kind: "busy" };
}

export const BOT_TEXT = {
  ready: "Play vs Bot (one wallet)",
  searching: (s: number) => `Someone just took the bot's seat. Looking for its next table… (${s} s)`,
  resting: "The bot is resting (it is out of test ETH). Play with a friend, or try again later.",
  busy: "The bot is busy right now. Try again in a minute, or play with a friend.",
  dropped:
    "Your stake did not arrive at the bot's table, so it removed you. Claim chips; the bot opens a new table after its next game.",
} as const;
