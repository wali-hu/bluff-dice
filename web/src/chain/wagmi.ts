import { createConfig, http, injected } from "wagmi";
import { sepolia } from "wagmi/chains";

import { SEPOLIA_RPC_URL } from "@/config/env";

/**
 * Sepolia only. Reads go through our RPC (NEXT_PUBLIC_SEPOLIA_RPC_URL, else a public keyless endpoint); writes
 * and signatures always go through the wallet.
 *
 * Connectors: every wallet that announces itself with EIP-6963 becomes a connector
 * (`multiInjectedProviderDiscovery`), plus the generic `injected()` fallback for in-app browsers that only
 * expose `window.ethereum`.
 *
 * SSR: `ssr: true` makes wagmi wait until the client has mounted before it restores the last connection from
 * localStorage, so the prerendered HTML and the first client render are identical ("not connected") and the
 * pages stay static. We do not use cookie storage: it would need request cookies in the layout and turn every
 * route dynamic for a one-frame gain.
 */
export const wagmiConfig = createConfig({
  chains: [sepolia],
  connectors: [injected()],
  multiInjectedProviderDiscovery: true,
  transports: { [sepolia.id]: http(SEPOLIA_RPC_URL) },
  ssr: true,
});

declare module "wagmi" {
  interface Register {
    config: typeof wagmiConfig;
  }
}
