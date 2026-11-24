import type { Hex } from "viem";

import { bluffChipsAbi, bluffDiceAbi } from "@/contracts/abi";
import { BLUFF_CHIPS_ADDRESS, BLUFF_DICE_ADDRESS } from "@/contracts/addresses";
import { OPERATOR_TTL_SECONDS } from "@/lib/onboarding";

import type { WriteRequest } from "./TxQueueProvider";

/** Every write the app sends, with the words the UI shows for it. */
export function faucetWrite(): WriteRequest<typeof bluffChipsAbi, "faucet"> {
  return { label: "Claim chips", address: BLUFF_CHIPS_ADDRESS, abi: bluffChipsAbi, functionName: "faucet", args: [] };
}

/** `setOperator(BluffDice, now + 600)`: `until` in SECONDS (uint48), never milliseconds. */
export function authorizeWrite(nowSeconds: bigint): WriteRequest<typeof bluffChipsAbi, "setOperator"> {
  return {
    label: "Authorize the table",
    address: BLUFF_CHIPS_ADDRESS,
    abi: bluffChipsAbi,
    functionName: "setOperator",
    args: [BLUFF_DICE_ADDRESS, Number(nowSeconds + OPERATOR_TTL_SECONDS)],
  };
}

export function joinWrite(tableId: bigint): WriteRequest<typeof bluffDiceAbi, "joinTable"> {
  return {
    label: `Join table #${tableId}`,
    address: BLUFF_DICE_ADDRESS,
    abi: bluffDiceAbi,
    functionName: "joinTable",
    args: [tableId],
  };
}

export function createWrite(stake: bigint, maxPlayers: number): WriteRequest<typeof bluffDiceAbi, "createTable"> {
  return {
    label: "Create a table",
    address: BLUFF_DICE_ADDRESS,
    abi: bluffDiceAbi,
    functionName: "createTable",
    args: [stake, maxPlayers],
  };
}

export function leaveWrite(tableId: bigint): WriteRequest<typeof bluffDiceAbi, "leaveTable"> {
  return {
    label: `Leave table #${tableId}`,
    address: BLUFF_DICE_ADDRESS,
    abi: bluffDiceAbi,
    functionName: "leaveTable",
    args: [tableId],
  };
}

/** `cancel(tableId)`: anyone, after a proof deadline; refunds every seat its own stake. */
export function cancelWrite(tableId: bigint): WriteRequest<typeof bluffDiceAbi, "cancel"> {
  return {
    label: `Cancel table #${tableId}`,
    address: BLUFF_DICE_ADDRESS,
    abi: bluffDiceAbi,
    functionName: "cancel",
    args: [tableId],
  };
}

export function bidWrite(tableId: bigint, quantity: number, face: number): WriteRequest<typeof bluffDiceAbi, "bid"> {
  return {
    label: `Bid ${quantity} × ${face}`,
    address: BLUFF_DICE_ADDRESS,
    abi: bluffDiceAbi,
    functionName: "bid",
    args: [tableId, quantity, face],
  };
}

export function liarWrite(tableId: bigint): WriteRequest<typeof bluffDiceAbi, "callLiar"> {
  return {
    label: "Call LIAR!",
    address: BLUFF_DICE_ADDRESS,
    abi: bluffDiceAbi,
    functionName: "callLiar",
    args: [tableId],
  };
}

export function claimTimeoutWrite(tableId: bigint): WriteRequest<typeof bluffDiceAbi, "claimTurnTimeout"> {
  return {
    label: "Claim the timeout",
    address: BLUFF_DICE_ADDRESS,
    abi: bluffDiceAbi,
    functionName: "claimTurnTimeout",
    args: [tableId],
  };
}

/** `startGame` with the KMS result passed byte for byte (cleartexts + proof exactly as the relayer returned them). */
export function startGameWrite(
  tableId: bigint,
  cleartexts: Hex,
  proof: Hex,
): WriteRequest<typeof bluffDiceAbi, "startGame"> {
  return {
    label: "Deal the dice",
    address: BLUFF_DICE_ADDRESS,
    abi: bluffDiceAbi,
    functionName: "startGame",
    args: [tableId, cleartexts, proof],
  };
}

/** `finalizeReveal` with the KMS result passed byte for byte. */
export function finalizeRevealWrite(
  tableId: bigint,
  cleartexts: Hex,
  proof: Hex,
): WriteRequest<typeof bluffDiceAbi, "finalizeReveal"> {
  return {
    label: "Reveal the dice",
    address: BLUFF_DICE_ADDRESS,
    abi: bluffDiceAbi,
    functionName: "finalizeReveal",
    args: [tableId, cleartexts, proof],
  };
}
