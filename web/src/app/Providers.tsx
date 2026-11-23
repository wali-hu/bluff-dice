"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import { WagmiProvider } from "wagmi";

import { TxQueueProvider } from "@/chain/TxQueueProvider";
import { wagmiConfig } from "@/chain/wagmi";

export function Providers({ children }: { children: React.ReactNode }) {
  // One QueryClient per browser tab (created lazily, never shared between server requests).
  const [queryClient] = useState(() => new QueryClient());
  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        <TxQueueProvider>{children}</TxQueueProvider>
      </QueryClientProvider>
    </WagmiProvider>
  );
}
