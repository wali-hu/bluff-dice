"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useConnection, usePublicClient } from "wagmi";

import { findBotTable } from "@/chain/discovery";
import { BOT_ADDRESS } from "@/config/bot";
import { BOT_TEXT } from "@/lib/botState";

/** Home: "Play vs Bot" as the primary action when the bot has an open table. Nothing when bot mode is off. */
export function BotCta() {
  const client = usePublicClient();
  const { address } = useConnection();
  const botTable = useQuery({
    queryKey: ["bot-table", address],
    enabled: BOT_ADDRESS !== null && Boolean(client),
    refetchInterval: 20_000,
    queryFn: async () => (await findBotTable(client!, address)) ?? null,
  });
  if (BOT_ADDRESS === null || botTable.data === undefined || botTable.data === null) return null;
  return (
    <Link href={`/play?table=${botTable.data}`} className="button button-primary">
      {BOT_TEXT.ready}
    </Link>
  );
}
