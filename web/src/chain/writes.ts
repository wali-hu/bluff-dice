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
