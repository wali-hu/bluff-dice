import { BLUFF_DICE_DEPLOY_BLOCK } from "@/contracts/addresses";

import { resolveRpcUrl } from "./rpc";

export { DEFAULT_SEPOLIA_RPC_URL } from "./rpc";

function trimmed(value: string | undefined): string {
  return (value ?? "").trim();
}

/** Read RPC (all reads; writes always go through the wallet). Public by design: it ships to the browser. */
export const SEPOLIA_RPC_URL = resolveRpcUrl(process.env.NEXT_PUBLIC_SEPOLIA_RPC_URL);

/** Bot player address (Phase F). Empty string = bot mode hidden. */
export const BOT_ADDRESS = trimmed(process.env.NEXT_PUBLIC_BOT_ADDRESS);

/** First block to scan for the bot's tables; defaults to the BluffDice deploy block. */
export const BOT_FROM_BLOCK = (() => {
  const raw = trimmed(process.env.NEXT_PUBLIC_BOT_FROM_BLOCK);
  return /^\d+$/.test(raw) ? BigInt(raw) : BLUFF_DICE_DEPLOY_BLOCK;
})();

export const SEPOLIA_FAUCET_URL = "https://cloud.google.com/application/web3/faucet/ethereum/sepolia";
