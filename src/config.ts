import { defaultBaseUrl, defaultNotaryUrl } from "@dmarket/p2p-tracker-headless";

/**
 * How the SDK proves: the notary, and the prover processes' limits. The `"prover"` object of the config file.
 *
 * `enabled: false` makes no proof at all: a deal that requires one is reported unproven. `peakMemoryMb` is one
 * proof's memory peak, for the start-up check against the container's limit.
 */
export interface ProverConfig {
  readonly enabled: boolean;
  readonly notaryUrl: string;
  readonly maxConcurrency: number;
  readonly proofsPerChild: number;
  readonly threadCount: number;
  readonly peakMemoryMb: number;
  readonly assetsDir: string | null;
}

/** A config file the SDK cannot use. The message names the field and never quotes a value or the file. */
export class ConfigError extends Error {
  override readonly name = "ConfigError";
}

export const DEFAULT_PORT = 8790;
export const MIN_SECRET_LENGTH = 32;

const PROVER_DEFAULTS = {
  enabled: true,
  maxConcurrency: 1,
  proofsPerChild: 1,
  // Each thread adds about 12 MB to a proof's peak; four instead of two save about a second of a 6 s proof.
  threadCount: 2,
  // One prover process's peak with the tracker's bundle loaded is 510-610 MB at two threads, plus headroom: a 512 MB
  // container cannot hold it beside the SDK, a 768 MB one can.
  peakMemoryMb: 640,
} as const;
const MAX_CONCURRENCY = 2;
const MAX_PROOFS_PER_CHILD = 5;
const MAX_THREADS = 16;

/**
 * The SDK's settings, read once at start. The only secret here is `managementSecret`, the bearer the local management
 * API requires; the DMarket key and the Steam token are never configured, only pushed. The secret stays out of
 * `toString`, `util.inspect` and `JSON.stringify`.
 */
export class SdkConfig {
  readonly #managementSecret: string;

  constructor(
    managementSecret: string,
    /** Where the loop's state is kept across restarts, one directory per account. No secret is written there. */
    readonly dataDir: string,
    /** The management API's address. Loopback by default: the API accepts a trading key and a Steam token. */
    readonly listenHost: string,
    readonly listenPort: number,
    readonly dmarketBaseUrl: string,
    /** `false` for a buying bot's SDK: it then creates and cancels no Steam offer, whatever DMarket leases it. */
    readonly steamWrites: boolean,
    readonly prover: ProverConfig,
  ) {
    this.#managementSecret = managementSecret;
  }

  /** The bearer every management request must carry. */
  get managementSecret(): string {
    return this.#managementSecret;
  }

  toString(): string {
    return (
      `SdkConfig(managementSecret=<redacted>, dataDir=${this.dataDir}, listenHost=${this.listenHost}, ` +
      `listenPort=${String(this.listenPort)}, dmarketBaseUrl=${this.dmarketBaseUrl}, ` +
      `steamWrites=${String(this.steamWrites)}, prover=${JSON.stringify(this.prover)})`
    );
  }
}

/** Parses the config file's text. Throws `ConfigError`, whose message is safe to print, on anything it cannot use. */
export function parseConfig(text: string): SdkConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // JSON.parse's own message quotes the text around the error, which can be the secret.
    throw new ConfigError("config is not valid JSON");
  }
  const root = object(parsed, "config");
  only(root, "", [
    "managementSecret",
    "dataDir",
    "listenHost",
    "listenPort",
    "dmarketBaseUrl",
    "steamWrites",
    "prover",
  ]);

  const managementSecret = string(root, "managementSecret");
  check(
    managementSecret.length >= MIN_SECRET_LENGTH,
    `managementSecret must be at least ${String(MIN_SECRET_LENGTH)} characters`,
  );
  const dataDir = string(root, "dataDir");
  check(dataDir.trim() !== "", "dataDir must not be blank");
  const listenPort = integer(root, "listenPort", DEFAULT_PORT);
  check(listenPort >= 1 && listenPort <= 65_535, "listenPort must be a TCP port");

  return new SdkConfig(
    managementSecret,
    dataDir,
    string(root, "listenHost", "127.0.0.1"),
    listenPort,
    string(root, "dmarketBaseUrl", defaultBaseUrl()),
    boolean(root, "steamWrites", true),
    parseProver(root.prover === undefined ? {} : object(root.prover, "prover")),
  );
}

function parseProver(p: Record<string, unknown>): ProverConfig {
  only(p, "prover.", [
    "enabled",
    "notaryUrl",
    "maxConcurrency",
    "proofsPerChild",
    "threadCount",
    "peakMemoryMb",
    "assetsDir",
  ]);
  const notaryUrl = string(p, "notaryUrl", defaultNotaryUrl(), "prover.");
  check(
    notaryUrl.startsWith("wss://") || notaryUrl.startsWith("ws://"),
    "prover.notaryUrl must be a ws:// or wss:// URL",
  );
  const peakMemoryMb = integer(p, "peakMemoryMb", PROVER_DEFAULTS.peakMemoryMb, "prover.");
  check(peakMemoryMb > 0, "prover.peakMemoryMb must be positive");
  return Object.freeze({
    enabled: boolean(p, "enabled", PROVER_DEFAULTS.enabled, "prover."),
    notaryUrl,
    maxConcurrency: knob(p, "maxConcurrency", PROVER_DEFAULTS.maxConcurrency, MAX_CONCURRENCY),
    proofsPerChild: knob(p, "proofsPerChild", PROVER_DEFAULTS.proofsPerChild, MAX_PROOFS_PER_CHILD),
    threadCount: knob(p, "threadCount", PROVER_DEFAULTS.threadCount, MAX_THREADS),
    peakMemoryMb,
    assetsDir: p.assetsDir === undefined || p.assetsDir === null ? null : string(p, "assetsDir", undefined, "prover."),
  });
}

/** A prover limit from 1 to `max`. */
function knob(p: Record<string, unknown>, key: string, fallback: number, max: number): number {
  const v = integer(p, key, fallback, "prover.");
  check(v >= 1 && v <= max, `prover.${key} must be 1..${String(max)}`);
  return v;
}

function check(ok: boolean, message: string): void {
  if (!ok) throw new ConfigError(message);
}

function object(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ConfigError(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function only(o: Record<string, unknown>, prefix: string, known: readonly string[]): void {
  for (const key of Object.keys(o)) check(known.includes(key), `${prefix}${key} is not a config key`);
}

/** The key's value, or its default when the key is absent. `null` is a value, refused by the type check. */
function field(o: Record<string, unknown>, key: string, prefix: string, fallback: unknown): unknown {
  const v = o[key];
  if (v !== undefined) return v;
  if (fallback === undefined) throw new ConfigError(`${prefix}${key} is required`);
  return fallback;
}

function string(o: Record<string, unknown>, key: string, fallback?: string, prefix = ""): string {
  const v = field(o, key, prefix, fallback);
  if (typeof v !== "string") throw new ConfigError(`${prefix}${key} must be a string`);
  return v;
}

function integer(o: Record<string, unknown>, key: string, fallback: number, prefix = ""): number {
  const v = field(o, key, prefix, fallback);
  if (typeof v !== "number" || !Number.isSafeInteger(v)) throw new ConfigError(`${prefix}${key} must be an integer`);
  return v;
}

function boolean(o: Record<string, unknown>, key: string, fallback: boolean, prefix = ""): boolean {
  const v = field(o, key, prefix, fallback);
  if (typeof v !== "boolean") throw new ConfigError(`${prefix}${key} must be true or false`);
  return v;
}
