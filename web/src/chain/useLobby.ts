"use client";

import { useQuery } from "@tanstack/react-query";
import { usePublicClient } from "wagmi";

import { getLobbyTables } from "./discovery";

export const LOBBY_KEY = "lobby";

/** The newest 50 tables (one Multicall3 call), refreshed every 8 s while the tab is visible. */
export function useLobbyTables() {
  const client = usePublicClient();
  return useQuery({
    queryKey: [LOBBY_KEY],
    enabled: Boolean(client),
    refetchInterval: 8_000,
    queryFn: () => getLobbyTables(client!),
  });
}
