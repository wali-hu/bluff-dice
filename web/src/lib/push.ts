import type { Hex } from "viem";

import { Phase } from "@/chain/reads";
import { finalizeRevealWrite, startGameWrite } from "@/chain/writes";

import type { TxError } from "./errors";
import { hasZeroHandle, type PushKind } from "./tableView";

/**
 * E5-R16: the manual deal / reveal push, with every side effect injected (testable without a chain or a KMS).
 *   1. re-read the phase: moved on -> "alreadyPushed" (no decrypt, no send); again after the decrypt;
 *   2. read the handle list from the CONTRACT view (paidHandles / revealHandles), never rebuilt here;
 *      empty or containing bytes32(0) -> stop (no decrypt, no send);
 *   3. public-decrypt exactly those handles;
 *   4. send startGame / finalizeReveal with tableId, cleartexts and proof UNMODIFIED;
 *   5. WrongPhase revert -> "alreadyPushed" (someone else won the race: a success); other failures -> words.
 */
export type PushOutcome = {
  readonly result: "pushed" | "alreadyPushed" | "notReady" | "failed";
  readonly message: string;
};

export interface PushDeps {
  readonly kind: PushKind;
  readonly tableId: bigint;
  readonly readPhase: () => Promise<number>;
  readonly readHandles: () => Promise<readonly Hex[]>;
  readonly publicDecrypt: (handles: readonly Hex[]) => Promise<{ abiEncoded: Hex; proof: Hex }>;
  readonly send: (
    write: ReturnType<typeof startGameWrite> | ReturnType<typeof finalizeRevealWrite>,
  ) => Promise<{ ok: true } | { ok: false; error: TxError | null }>;
}

const PUSHED = "Done: the table moved on.";
const ALREADY = "Someone else already pushed it. The table moved on.";

/** RV-5: the contract view whose handle list a push decrypts. */
export function pushHandleView(kind: PushKind): "paidHandles" | "revealHandles" {
  return kind === "deal" ? "paidHandles" : "revealHandles";
}

export async function runPush(deps: PushDeps): Promise<PushOutcome> {
  const expected = deps.kind === "deal" ? Phase.AwaitingPaidProof : Phase.AwaitingReveal;
  if ((await deps.readPhase()) !== expected) return { result: "alreadyPushed", message: ALREADY };

  const handles = await deps.readHandles();
  if (handles.length === 0 || hasZeroHandle(handles)) {
    return { result: "notReady", message: "Some values are not set yet. Wait a few seconds and press again." };
  }

  const { abiEncoded, proof } = await deps.publicDecrypt(handles);
  // The KMS takes seconds: someone else may have pushed meanwhile. Check again right before the wallet prompt.
  if ((await deps.readPhase()) !== expected) return { result: "alreadyPushed", message: ALREADY };
  const write =
    deps.kind === "deal"
      ? startGameWrite(deps.tableId, abiEncoded, proof)
      : finalizeRevealWrite(deps.tableId, abiEncoded, proof);
  const sent = await deps.send(write);
  if (sent.ok) return { result: "pushed", message: PUSHED };
  if (sent.error?.kind === "contract" && sent.error.name === "WrongPhase") {
    return { result: "alreadyPushed", message: ALREADY };
  }
  return { result: "failed", message: sent.error?.message ?? "The transaction did not go through. Press again." };
}
