import { FHE_ASSETS, type FheAsset } from "./assets";
import { FheError } from "./errors";

/**
 * The subset of the relayer SDK 0.4.1 UMD global (`window.relayerSDK`) the app uses. Types come from the
 * installed package (`import type` only: the SDK code itself is never bundled, it is the self-hosted UMD).
 */
export type RelayerSdkModule = Pick<
  typeof import("@zama-fhe/relayer-sdk/web"),
  "initSDK" | "createInstance" | "SepoliaConfig"
>;

declare global {
  interface Window {
    relayerSDK?: RelayerSdkModule;
  }
}

function toHex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  return toHex(await crypto.subtle.digest("SHA-256", bytes as BufferSource));
}

/** Downloads a pinned asset and refuses it unless size and sha256 match the manifest. */
export async function fetchVerified(asset: FheAsset, fetchImpl: typeof fetch = fetch): Promise<Uint8Array> {
  let response: Response;
  try {
    response = await fetchImpl(asset.url);
  } catch (cause) {
    throw new FheError("asset", `Could not download ${asset.url}`, { cause });
  }
  if (!response.ok) throw new FheError("asset", `GET ${asset.url} -> HTTP ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.length !== asset.bytes || (await sha256Hex(bytes)) !== asset.sha256) {
    throw new FheError("asset", `${asset.url} does not match its pinned sha256`);
  }
  return bytes;
}

let scriptPromise: Promise<RelayerSdkModule> | null = null;

/**
 * Adds the self-hosted UMD as a <script> with Subresource Integrity (browser-enforced sha384) and resolves with
 * `window.relayerSDK`. Client only, once per page.
 */
export function loadSdkScript(): Promise<RelayerSdkModule> {
  if (scriptPromise) return scriptPromise;
  scriptPromise = new Promise<RelayerSdkModule>((resolve, reject) => {
    if (window.relayerSDK) return resolve(window.relayerSDK);
    const script = document.createElement("script");
    script.src = FHE_ASSETS.umd.url;
    script.integrity = FHE_ASSETS.umd.integrity;
    script.async = true;
    script.onload = () =>
      window.relayerSDK
        ? resolve(window.relayerSDK)
        : reject(new FheError("asset", "The encryption toolkit loaded but did not register itself"));
    script.onerror = () => reject(new FheError("asset", `Could not load ${FHE_ASSETS.umd.url}`));
    document.head.appendChild(script);
  }).catch((error: unknown) => {
    scriptPromise = null; // allow Retry
    throw error;
  });
  return scriptPromise;
}
