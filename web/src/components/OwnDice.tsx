"use client";

import { useQuery } from "@tanstack/react-query";
import type { Address, Hex } from "viem";
import { usePublicClient } from "wagmi";

import { getDiceOf } from "@/chain/reads";
import { BLUFF_DICE_ADDRESS } from "@/contracts/addresses";
import { FheError } from "@/fhe/errors";
import { useFheClient, useUnlockedUser } from "@/fhe/FheProvider";
import { OWN_DICE_RETRY, relayerCall } from "@/fhe/relayerCall";
import { diceDealt, ownDiceDecryptItems, ownDiceQueryKey, ownDiceView } from "@/lib/tableView";

import { BoneDie } from "./BoneDie";
import { CipherDie } from "./CipherDie";
import { DiceRow } from "./DiceRow";
import { RelayerStatus } from "./RelayerStatus";
import { UnlockCard } from "./UnlockCard";

interface DiceRead {
  handles: readonly Hex[];
  values: Map<string, bigint>;
}

/**
 * The player's own five dice, user-decrypted for this tab only (E5-R2/R3/R15). Own-dice path: wait until the ACL
 * lists the player on every die at a block >= the deal (GameStarted), then retry the SDK's pre-check refusal /
 * "not ready" for up to 60 s. Only the viewer's own non-zero handles are sent; raw handles are never shown; the
 * cache key is per account.
 */
export function OwnDice({
  tableId,
  round,
  player,
  seat,
  dealtAtBlock,
}: {
  tableId: bigint;
  round: number;
  player: Address;
  seat: number;
  dealtAtBlock: bigint | undefined;
}) {
  const client = usePublicClient();
  const fhe = useFheClient();
  const unlocked = useUnlockedUser();
  const isUnlocked = Boolean(unlocked && unlocked.toLowerCase() === player.toLowerCase());
  const dice = useQuery({
    queryKey: ownDiceQueryKey(tableId, player, round),
    enabled: isUnlocked && Boolean(client),
    retry: false, // our own retry policy (relayerCall OWN_DICE_RETRY)
    staleTime: Infinity,
    gcTime: 0,
    queryFn: async (): Promise<DiceRead> => {
      // RV-4: right after the deal a lagging RPC can still return bytes32(0) dice. Never resolve on those: retry
      // with the own-dice backoff for up to 60 s, then fail with Retry.
      const handles = await relayerCall(
        async () => {
          const read = await getDiceOf(client!, tableId, player);
          if (!diceDealt(read)) throw new FheError("notReady", "Your dice are not dealt yet.");
          return read;
        },
        { channel: "userDecrypt", label: "Waiting for your dice to be dealt", retry: OWN_DICE_RETRY },
      );
      const items = ownDiceDecryptItems({ viewerSeat: seat, handles, contract: BLUFF_DICE_ADDRESS });
      const clear = await fhe.userDecrypt(items, {
        ownDiceAfterBlock: dealtAtBlock ?? 0n,
        label: "Decrypting your dice",
      });
      return { handles, values: new Map([...clear].map(([h, v]) => [h, v])) };
    },
  });

  if (!isUnlocked) {
    return (
      <>
        <DiceRow label="Your dice: locked">
          {Array.from({ length: 5 }, (_, i) => (
            <CipherDie key={i} seed={900 + i} label="Your die: sign to read it" />
          ))}
        </DiceRow>
        <UnlockCard context="Your dice are dealt. Sign to read them:" />
      </>
    );
  }

  const view = ownDiceView({ seated: true, handles: dice.data?.handles, values: dice.data?.values });
  if (view.kind === "faces") {
    return (
      <DiceRow label="Your dice">
        {view.faces.map((face, i) => (
          <BoneDie key={i} face={face} />
        ))}
      </DiceRow>
    );
  }
  return (
    <>
      <DiceRow label="Your dice: decrypting">
        {Array.from({ length: 5 }, (_, i) => (
          <CipherDie key={i} seed={900 + i} label="Your die: decrypting" />
        ))}
      </DiceRow>
      {view.kind === "error" ? (
        <p role="alert">
          {view.message}{" "}
          <button type="button" className="button button-ghost" onClick={() => void dice.refetch()}>
            Retry
          </button>
        </p>
      ) : (
        <RelayerStatus
          channel="userDecrypt"
          idleText="Decrypting your dice (usually 9-12 s after the deal)…"
          hint="usually 9-12 s after the deal"
          onRetry={() => void dice.refetch()}
        />
      )}
    </>
  );
}
