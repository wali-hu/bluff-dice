import { signTypedData } from "wagmi/actions";

import { wagmiConfig } from "@/chain/wagmi";

import type { TypedDataSigner } from "./client";

/** Signs the user-decrypt permit with the connected wallet. */
export const signWithWallet: TypedDataSigner = (typedData) =>
  signTypedData(wagmiConfig, typedData as unknown as Parameters<typeof signTypedData>[1]);
