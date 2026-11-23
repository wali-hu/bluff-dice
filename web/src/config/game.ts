/**
 * Game rules as enforced by BluffDice (contracts/BluffDice.sol). A unit test reads the Solidity source and fails
 * if any of these constants drift from the contract.
 */
export const MIN_PLAYERS = 2;
export const MAX_PLAYERS = 4;
export const DICE_PER_PLAYER = 5;
export const FACES = 6;

/** Constructor argument of the Sepolia deployment (Phase D, BluffDice 0x0456...8566). */
export const BID_TIMEOUT_SECONDS = 300;
/** `PROOF_TIMEOUT` in the contract: after this, anyone may cancel a table whose decryption proof never came. */
export const PROOF_TIMEOUT_SECONDS = 60 * 60;
