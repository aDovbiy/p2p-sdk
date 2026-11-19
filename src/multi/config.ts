import { ConfigError, parseConfig, type SdkConfig } from "../config.js";
import { parseProxy } from "./tunnel.js";

/** One Steam account the process runs: its id in the API's routes, its proxy, and whether it sells. */
export interface AccountConfig {
  readonly id: string;
  /** `http://[user:pass@]host:port`: every byte of this account (DMarket, Steam, notary) leaves through it. */
  readonly proxy: string | null;
  readonly steamWrites: boolean;
}

/**
 * The multi-account config: the single-account file's keys (checked by `parseConfig`), plus `accounts` and two
 * prover keys that apply to the whole process.
 *
 * ```json
 * {
 *   "managementSecret": "…", "dataDir": "/data",
 *   "prover": { "globalConcurrency": 8, "connectDeadlineMs": 600000 },
 *   "accounts": [ { "id": "acc001", "proxy": "http://user:pass@10.0.0.1:3128" } ]
 * }
 * ```
 */
export interface MultiConfig {
  readonly base: SdkConfig;
  /** The base config's JSON with the multi-account keys taken out: what each worker parses for its account. */
  readonly baseJson: Record<string, unknown>;
  readonly accounts: readonly AccountConfig[];
  /** Proofs at once across all accounts; `null` for no process-wide limit. */
  readonly globalConcurrency: number | null;
  /** How long a prover process may wait for its slot and connect; the library's 30 s is too short behind a queue. */
  readonly connectDeadlineMs: number;
}

const ID = /^[A-Za-z0-9_-]{1,64}$/;
const DEFAULT_QUEUED_CONNECT_DEADLINE_MS = 10 * 60_000;
const LIBRARY_CONNECT_DEADLINE_MS = 30_000;

export function parseMultiConfig(text: string): MultiConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ConfigError("config is not valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new ConfigError("config must be an object");
  const { accounts: rawAccounts, ...rest } = parsed as Record<string, unknown>;
  const prover = typeof rest.prover === "object" && rest.prover !== null ? { ...(rest.prover as Record<string, unknown>) } : {};
  const { globalConcurrency: rawGlobal, connectDeadlineMs: rawDeadline, ...proverRest } = prover;
  const baseJson = { ...rest, prover: proverRest };
  const base = parseConfig(JSON.stringify(baseJson));

  if (!Array.isArray(rawAccounts) || rawAccounts.length === 0) throw new ConfigError("accounts must be a non-empty array");
  const seen = new Set<string>();
  const accounts = rawAccounts.map((raw, i): AccountConfig => {
    if (typeof raw !== "object" || raw === null) throw new ConfigError(`accounts[${String(i)}] must be an object`);
    const a = raw as Record<string, unknown>;
    for (const key of Object.keys(a)) {
      if (!["id", "proxy", "steamWrites"].includes(key)) throw new ConfigError(`accounts[${String(i)}].${key} is not a config key`);
    }
    if (typeof a.id !== "string" || !ID.test(a.id)) throw new ConfigError(`accounts[${String(i)}].id must match ${ID.source}`);
    if (seen.has(a.id)) throw new ConfigError(`accounts[${String(i)}].id is a duplicate`);
    seen.add(a.id);
    let proxy: string | null = null;
    if (a.proxy !== undefined && a.proxy !== null) {
      if (typeof a.proxy !== "string") throw new ConfigError(`accounts[${String(i)}].proxy must be a string`);
      try {
        parseProxy(a.proxy);
      } catch (e) {
        // parseProxy's messages never quote the URL, which can hold a password.
        throw new ConfigError(`accounts[${String(i)}].proxy: ${(e as Error).message}`);
      }
      proxy = a.proxy;
    }
    if (a.steamWrites !== undefined && typeof a.steamWrites !== "boolean") {
      throw new ConfigError(`accounts[${String(i)}].steamWrites must be true or false`);
    }
    return { id: a.id, proxy, steamWrites: (a.steamWrites) ?? base.steamWrites };
  });

  let globalConcurrency: number | null = null;
  if (rawGlobal !== undefined && rawGlobal !== null) {
    if (typeof rawGlobal !== "number" || !Number.isSafeInteger(rawGlobal) || rawGlobal < 1) {
      throw new ConfigError("prover.globalConcurrency must be a positive integer");
    }
    globalConcurrency = rawGlobal;
  }
  let connectDeadlineMs = globalConcurrency === null ? LIBRARY_CONNECT_DEADLINE_MS : DEFAULT_QUEUED_CONNECT_DEADLINE_MS;
  if (rawDeadline !== undefined) {
    if (typeof rawDeadline !== "number" || !Number.isSafeInteger(rawDeadline) || rawDeadline < 1_000) {
      throw new ConfigError("prover.connectDeadlineMs must be an integer of 1000 or more");
    }
    connectDeadlineMs = rawDeadline;
  }
  return { base, baseJson, accounts, globalConcurrency, connectDeadlineMs };
}
