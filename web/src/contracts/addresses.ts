/** Final Sepolia deployment (Phase D). Public data. */
export const SEPOLIA_CHAIN_ID = 11155111;

export const BLUFF_CHIPS_ADDRESS = "0xd3F1dA18626e42E36b4a25e6765a932D40fe4E40" as const;
export const BLUFF_DICE_ADDRESS = "0x0456bAb0779697cCaB7125A0089b10eEEB0A8566" as const;

/**
 * Deploy blocks: the lower bound for every log scan. Source: deployments/sepolia/*.json (hardhat-deploy
 * receipts), cross-checked with eth_getTransactionByHash on Sepolia:
 * BluffChips tx 0xcaba3adb...6715 (block 12,181,547), BluffDice tx 0x2217fd65...a09e (block 12,183,614).
 */
export const BLUFF_CHIPS_DEPLOY_BLOCK = 12_181_547n;
export const BLUFF_DICE_DEPLOY_BLOCK = 12_183_614n;

/** Multicall3, canonical address; on Sepolia it holds 3,808 bytes of code (eth_getCode, 2026-11-22). */
export const MULTICALL3_ADDRESS = "0xcA11bde05977b3631167028862bE2a173976CA11" as const;
