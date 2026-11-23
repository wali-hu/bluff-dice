import { recoverTypedDataAddress, type Address, type Hex, type PublicClient } from "viem";

import { SEPOLIA_CHAIN_ID } from "@/contracts/addresses";

import { FHE_ASSETS } from "./assets";
import type { DecryptItem, FheClient, PublicDecryptResult, UserDecryptOptions } from "./client";
import { PERMIT_CONTRACTS, PERMIT_DURATION_DAYS, toWalletTypedData, type SdkUserDecryptEip712 } from "./eip712";
import { FheError, FHE_ERROR_TEXT } from "./errors";
import { fetchVerified, loadSdkScript, type RelayerSdkModule } from "./loader";
import { LAG_RETRY, NO_RETRY, OWN_DICE_RETRY, relayerCall } from "./relayerCall";
import { currentSession, lock as lockSession, setSession } from "./session";
import { markInit, type InitPhase } from "./timing";

export const ZERO_HANDLE = `0x${"00".repeat(32)}` as const;

/** Sepolia ACL (SepoliaConfig.aclContractAddress in 0.4.1, checked on-chain by createInstance in R2). */
export const ACL_ADDRESS = "0xf0Ffdc93b7E186bC2f8CB3dAA75D86d1930A433D" as const;

/** ACL.persistAllowed (Sepolia ACL from SepoliaConfig, verified on-chain in R2). */
const ACL_PERSIST_ALLOWED_ABI = [
  {
    type: "function",
    name: "persistAllowed",
    stateMutability: "view",
    inputs: [
      { name: "handle", type: "bytes32" },
      { name: "account", type: "address" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;

type Instance = Awaited<ReturnType<RelayerSdkModule["createInstance"]>>;

export interface SdkClientDeps {
  /** Read RPC URL passed to createInstance (never window.ethereum: a wallet on another chain cannot break init). */
  readonly rpcUrl: string;
  /** Loads the SDK module (the self-hosted UMD in the browser; a fake in tests). */
  readonly loadSdk?: () => Promise<RelayerSdkModule>;
  /** Fetches a pinned asset and checks its sha256. */
  readonly fetchAsset?: typeof fetchVerified;
  /** Our read client, for the own-dice ACL check at a pinned block. */
  readonly publicClient?: PublicClient;
  readonly now?: () => number;
}

function lowerKey(handle: string): string {
  return handle.toLowerCase();
}

/** 0.4.1 returns bigint for every euint, boolean for ebool; normalise everything to bigint. */
function toBigint(value: bigint | boolean | string | undefined, handle: string): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "boolean") return value ? 1n : 0n;
  if (typeof value === "string") return BigInt(value);
  throw new FheError("unknown", `No clear value returned for ${handle}`);
}

function pick<T>(record: Readonly<Record<string, T>>, handle: string): T | undefined {
  return record[handle] ?? record[lowerKey(handle)];
}

export function createSdkClient(deps: SdkClientDeps): FheClient {
  const loadSdk = deps.loadSdk ?? loadSdkScript;
  const fetchAsset = deps.fetchAsset ?? fetchVerified;
  const now = deps.now ?? Date.now;
  let instancePromise: Promise<Instance> | null = null;

  async function timed<T>(phase: InitPhase, work: () => Promise<T>): Promise<T> {
    const start = now();
    const value = await work();
    markInit(phase, now() - start);
    return value;
  }

  function init(): Promise<Instance> {
    if (instancePromise) return instancePromise;
    const started = now();
    instancePromise = relayerCall(
      async () => {
        // Key + CRS (4.6 MB) download in parallel with the script and the WASM.
        const keys = timed("keys", () =>
          Promise.all([fetchAsset(FHE_ASSETS.publicKey), fetchAsset(FHE_ASSETS.crs2048)]),
        );
        const sdk = await timed("script", loadSdk);
        await timed("wasm", async () => {
          const [tfhe, kms] = await Promise.all([fetchAsset(FHE_ASSETS.tfheWasm), fetchAsset(FHE_ASSETS.kmsWasm)]);
          // thread: 0 = no WASM thread pool. This app only decrypts (no encryption to speed up), and the pool's
          // worker would be fetched from the site root (/workerHelpers.js), not from /fhe/.
          await sdk.initSDK({ tfheParams: tfhe, kmsParams: kms, thread: 0 });
        });
        const [publicKey, crs] = await keys;
        const instance = await timed("createInstance", () =>
          sdk.createInstance({
            ...sdk.SepoliaConfig,
            network: deps.rpcUrl,
            // The shape createInstance expects (NOT the getters' shape); with both present it skips /v2/keyurl.
            publicKey: { data: publicKey, id: FHE_ASSETS.publicKey.id },
            publicParams: { 2048: { publicParams: crs, publicParamsId: FHE_ASSETS.crs2048.id } },
          }),
        );
        markInit("total", now() - started);
        return instance;
      },
      { channel: "init", label: "Loading the encryption toolkit", retry: NO_RETRY, now },
    ).catch((error: unknown) => {
      instancePromise = null; // Retry starts from scratch
      throw error;
    });
    return instancePromise;
  }

  function requireSession() {
    const session = currentSession(Math.floor(now() / 1000));
    if (!session) throw new FheError("locked", FHE_ERROR_TEXT.locked);
    return session;
  }

  async function waitForOwnAcl(handles: readonly Hex[], user: Address, afterBlock: bigint): Promise<void> {
    const client = deps.publicClient;
    if (!client) return;
    await relayerCall(
      async () => {
        const head = await client.getBlockNumber({ cacheTime: 0 });
        const blockNumber = head > afterBlock ? head : afterBlock;
        const allowed = await Promise.all(
          handles.map((handle) =>
            client.readContract({
              address: ACL_ADDRESS,
              abi: ACL_PERSIST_ALLOWED_ABI,
              functionName: "persistAllowed",
              args: [handle, user],
              blockNumber,
            }),
          ),
        );
        if (!allowed.every(Boolean)) throw new FheError("aclRefused", FHE_ERROR_TEXT.aclRefused);
      },
      { channel: "userDecrypt", label: "Waiting for your dice to be dealt", retry: OWN_DICE_RETRY, now },
    );
  }

  return {
    async init() {
      await init();
    },

    async unlock(user, sign, options = {}) {
      // The permit's EIP-712 domain is Sepolia; wallets refuse to sign typed data for another active chain.
      if (options.walletChainId !== undefined && options.walletChainId !== SEPOLIA_CHAIN_ID) {
        throw new FheError("wrongChain", FHE_ERROR_TEXT.wrongChain);
      }
      lockSession(); // a new unlock always replaces the old session
      const instance = await init();
      await relayerCall(
        async () => {
          const { publicKey, privateKey } = instance.generateKeypair();
          const startTimestamp = Math.floor(now() / 1000);
          const eip = instance.createEIP712(publicKey, [...PERMIT_CONTRACTS], startTimestamp, PERMIT_DURATION_DAYS);
          const typedData = toWalletTypedData(eip as unknown as SdkUserDecryptEip712);
          const signature = await sign(typedData);
          const signer = await recoverTypedDataAddress({ ...typedData, signature });
          if (signer.toLowerCase() !== user.toLowerCase()) {
            throw new FheError("badSignature", FHE_ERROR_TEXT.badSignature);
          }
          setSession({
            user,
            publicKey,
            privateKey,
            signature,
            startTimestamp,
            durationDays: PERMIT_DURATION_DAYS,
            contracts: PERMIT_CONTRACTS,
          });
        },
        { channel: "unlock", label: "Waiting for your signature", retry: NO_RETRY, now },
      );
    },

    async userDecrypt(items: readonly DecryptItem[], options: UserDecryptOptions = {}) {
      const live = items.filter((item) => lowerKey(item.handle) !== ZERO_HANDLE);
      const result = new Map<Hex, bigint>();
      if (live.length === 0) return result;
      const instance = await init();
      const { user } = requireSession();
      if (options.ownDiceAfterBlock !== undefined) {
        await waitForOwnAcl(
          live.map((item) => item.handle),
          user,
          options.ownDiceAfterBlock,
        );
      }
      const clear = await relayerCall(
        ({ signal, onProgress }) => {
          const session = requireSession();
          return instance.userDecrypt(
            live.map((item) => ({ handle: item.handle, contractAddress: item.contract })),
            session.privateKey,
            session.publicKey,
            session.signature,
            [...session.contracts],
            session.user,
            session.startTimestamp,
            session.durationDays,
            { signal, onProgress },
          );
        },
        {
          channel: "userDecrypt",
          label: options.label ?? "Decrypting",
          retry: options.ownDiceAfterBlock !== undefined ? OWN_DICE_RETRY : LAG_RETRY,
          now,
        },
      );
      for (const item of live) result.set(item.handle, toBigint(pick(clear, item.handle), item.handle));
      return result;
    },

    async publicDecrypt(handles: readonly Hex[]): Promise<PublicDecryptResult> {
      const instance = await init();
      const out = await relayerCall(
        ({ signal, onProgress }) => instance.publicDecrypt([...handles], { signal, onProgress }),
        { channel: "publicDecrypt", label: "The KMS is decrypting", retry: LAG_RETRY, now },
      );
      const clear = new Map<Hex, bigint>();
      for (const handle of handles) clear.set(handle, toBigint(pick(out.clearValues, handle), handle));
      // Byte for byte as the SDK returns them: the contract checks exactly these bytes.
      return { clear, abiEncoded: out.abiEncodedClearValues, proof: out.decryptionProof };
    },

    async rawUserDecryptForDemo() {
      throw new FheError("unknown", "The peek demo arrives in step E7.");
    },

    lock() {
      lockSession();
    },
  };
}
