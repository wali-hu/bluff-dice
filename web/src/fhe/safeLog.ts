/**
 * Secret guard. While a decryption session exists, its EIP-712 signature and ML-KEM private key are registered
 * here; any string that contains one of them (with or without 0x, any case) is refused by `assertNoSecret` and
 * never printed by `safeLog`. Same idea as the Phase D runner's guard.
 */
const secrets = new Set<string>();

function normalise(value: string): string {
  return value.toLowerCase().replace(/^0x/, "");
}

export function registerSecret(value: string): void {
  const v = normalise(value);
  if (v.length >= 32) secrets.add(v);
}

export function clearSecrets(): void {
  secrets.clear();
}

export function containsSecret(text: string): boolean {
  const haystack = text.toLowerCase();
  for (const secret of secrets) if (haystack.includes(secret)) return true;
  return false;
}

export class SecretLeakError extends Error {
  constructor() {
    super("Refused to output a string that contains decryption secrets.");
    this.name = "SecretLeakError";
  }
}

export function assertNoSecret(text: string): string {
  if (containsSecret(text)) throw new SecretLeakError();
  return text;
}

function stringify(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  try {
    return JSON.stringify(value, (_k, v: unknown) => (typeof v === "bigint" ? `${v}n` : v));
  } catch {
    return String(value);
  }
}

/** Logs only when nothing in the arguments contains a registered secret. */
export function safeLog(level: "info" | "warn" | "error", ...args: unknown[]): void {
  const text = args.map(stringify).join(" ");
  if (containsSecret(text)) {
    console.error("[fhe] a log line was dropped because it contained decryption secrets");
    return;
  }
  console[level](`[fhe] ${text}`);
}
