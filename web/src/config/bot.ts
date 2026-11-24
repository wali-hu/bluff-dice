import { getAddress, isAddress, type Address } from "viem";

import { BLUFF_DICE_DEPLOY_BLOCK } from "@/contracts/addresses";

/**
 * The "Play vs Bot" opponent (Phase F). The bot is a normal player with its own wallet and no special power in
 * the contracts; the frontend only needs its address to find its open table and label its seat.
 */
function parseBotAddress(raw: string | undefined): Address | null {
  const value = (raw ?? "").trim();
  return value !== "" && isAddress(value) ? getAddress(value) : null;
}

/** Bot player address from NEXT_PUBLIC_BOT_ADDRESS. null = bot mode hidden everywhere. */
export const BOT_ADDRESS: Address | null = parseBotAddress(process.env.NEXT_PUBLIC_BOT_ADDRESS);

/** First block to scan for the bot's tables (NEXT_PUBLIC_BOT_FROM_BLOCK); defaults to the BluffDice deploy block. */
export const BOT_FROM_BLOCK: bigint = (() => {
  const raw = (process.env.NEXT_PUBLIC_BOT_FROM_BLOCK ?? "").trim();
  return /^\d+$/.test(raw) ? BigInt(raw) : BLUFF_DICE_DEPLOY_BLOCK;
})();

/**
 * Under this Sepolia ETH balance the bot opens no new table ("resting"). Shared with bot/ (Phase F):
 * 0.03 ETH, the floor from the plan's abuse limits.
 */
export const BOT_FLOOR_WEI = 30_000_000_000_000_000n;

export function isBotAddress(address: string | undefined | null, bot: Address | null = BOT_ADDRESS): boolean {
  return bot !== null && address !== undefined && address !== null && address.toLowerCase() === bot.toLowerCase();
}
