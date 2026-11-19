#!/usr/bin/env node
/**
 * `dmarket-p2p-sdk-multi <config.json>`: every Steam account of the config in one process, each in a worker thread
 * with its own tracker, data directory and proxy, behind one management API:
 *
 * - `PUT /v1/accounts/{id}/dmarket/key`, `PUT /v1/accounts/{id}/steam/session`, `GET /v1/accounts/{id}/health`:
 *   the single-account routes, answered exactly as the single-account SDK answers them.
 * - `GET /v1/health`: every account's status and problem codes, and the prover gate. `503` while any account is down.
 *
 * A worker that dies is started again after a pause; like a restarted single-account SDK it holds no secret, and the
 * bot pushes both again (its health says `DMARKET_KEY_MISSING`). The other accounts are not touched.
 */
import { timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Worker } from "node:worker_threads";

import { headlessVersion } from "@dmarket/p2p-tracker-headless";

import { ManagementApi, type ApiResponse, type ManagementActions, type PushOutcome } from "../api.js";
import { ConfigError } from "../config.js";
import type { Health } from "../health/tracker.js";
import { Log } from "../log.js";
import { cgroupMemoryLimit } from "../memory.js";
import { ManagementServer } from "../server.js";
import { sdkVersion } from "../version.js";
import type { WorkerInput, WorkerRequest } from "./account-worker.js";
import { parseMultiConfig, type AccountConfig, type MultiConfig } from "./config.js";
import { ProverGate } from "./gate.js";

const RESTART_DELAY_MS = 5_000;
const ACCOUNT_ROUTE = /^\/v1\/accounts\/([A-Za-z0-9_-]{1,64})(\/.*)$/;
const NOT_RUNNING: ApiResponse = {
  status: 503,
  body: JSON.stringify({ error: "ACCOUNT_STARTING", reason: "the account's worker is starting: push again shortly" }),
};

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void };

/** One account's worker, restarted when it dies; requests to it while it is down are refused, never queued. */
class AccountHost implements ManagementActions {
  #worker: Worker | null = null;
  #nextId = 1;
  readonly #pending = new Map<number, Pending>();
  #lastHealth: Health | null = null;
  #stopping = false;

  constructor(
    readonly account: AccountConfig,
    private readonly input: WorkerInput,
    private readonly log: Log,
  ) {}

  get running(): boolean {
    return this.#worker !== null;
  }

  start(): void {
    const worker = new Worker(new URL("./account-worker.js", import.meta.url), { workerData: this.input });
    this.#worker = worker;
    worker.on("message", (m: { id: number; result?: unknown; error?: string }) => {
      const pending = this.#pending.get(m.id);
      if (!pending) return;
      this.#pending.delete(m.id);
      if (m.error === undefined) pending.resolve(m.result);
      else pending.reject(new Error(m.error));
    });
    worker.on("error", (e) => {
      this.log.error("account worker failed", { account: this.account.id, reason: e.name });
    });
    worker.on("exit", (code) => {
      this.#worker = null;
      for (const p of this.#pending.values()) p.reject(new Error("worker exited"));
      this.#pending.clear();
      if (this.#stopping) return;
      this.log.error("account worker exited: restarting, its secrets must be pushed again", {
        account: this.account.id,
        code: String(code),
      });
      setTimeout(() => { this.start(); }, RESTART_DELAY_MS).unref();
    });
  }

  async stop(): Promise<void> {
    this.#stopping = true;
    const worker = this.#worker;
    if (worker === null) return;
    await this.#call({ op: "stop", args: [] }).catch(() => undefined);
    await worker.terminate();
  }

  putDmarketKey(publicKey: string, secretKey: string): Promise<PushOutcome> {
    return this.#call({ op: "key", args: [publicKey, secretKey] }) as Promise<PushOutcome>;
  }

  putSteamToken(accessToken: string): Promise<PushOutcome> {
    return this.#call({ op: "token", args: [accessToken] }) as Promise<PushOutcome>;
  }

  /** The last health the worker reported; `refreshHealth` keeps it current, so this answers without waiting. */
  health(): Health {
    if (this.#lastHealth === null) throw new Error("no health yet");
    return this.#lastHealth;
  }

  async refreshHealth(): Promise<Health | null> {
    if (this.#worker === null) return (this.#lastHealth = null);
    try {
      this.#lastHealth = (await this.#call({ op: "health", args: [] })) as Health;
    } catch {
      this.#lastHealth = null;
    }
    return this.#lastHealth;
  }

  #call(request: Omit<WorkerRequest, "id">): Promise<unknown> {
    const worker = this.#worker;
    if (worker === null) return Promise.reject(new Error("worker not running"));
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      worker.postMessage({ ...request, id });
    });
  }
}

/** Routes `/v1/accounts/{id}/…` to that account's single-account API, and answers the combined `/v1/health`. */
class MultiApi {
  readonly #secret: Buffer;
  readonly #apis = new Map<string, ManagementApi>();

  constructor(
    secret: string,
    private readonly hosts: ReadonlyMap<string, AccountHost>,
    private readonly gate: ProverGate | null,
  ) {
    this.#secret = Buffer.from(secret, "utf8");
    for (const [id, host] of hosts) this.#apis.set(id, new ManagementApi(secret, host));
  }

  async handle(method: string, path: string, authorization: string | undefined, body: string): Promise<ApiResponse> {
    if (!this.#authorized(authorization)) return json(401, { error: "UNAUTHORIZED", reason: "a valid bearer is required" });
    const route = (path.split("?")[0] ?? "").replace(/\/+$/, "");
    if (route === "/v1/health") return method === "GET" ? this.#health() : json(405, { error: "METHOD_NOT_ALLOWED", reason: "method not allowed on this route" });
    const match = ACCOUNT_ROUTE.exec(route);
    const host = match ? this.hosts.get(match[1] ?? "") : undefined;
    const api = match ? this.#apis.get(match[1] ?? "") : undefined;
    if (!match || !host || !api) return json(404, { error: "NOT_FOUND", reason: "no such route or account" });
    if (!host.running) return NOT_RUNNING;
    if (match[2] === "/health") await host.refreshHealth();
    try {
      return await api.handle(method, `/v1${match[2] ?? ""}`, authorization, body);
    } catch {
      return NOT_RUNNING;
    }
  }

  async #health(): Promise<ApiResponse> {
    const accounts: Record<string, unknown> = {};
    let worst = "ok" as "ok" | "degraded" | "down";
    const rank = { ok: 0, degraded: 1, down: 2 } as const;
    await Promise.all(
      [...this.hosts].map(async ([id, host]) => {
        const h = await host.refreshHealth();
        const status = h === null ? "down" : h.status;
        if (rank[status] > rank[worst]) worst = status;
        accounts[id] = h === null
          ? { status: "down", problems: ["WORKER_NOT_RUNNING"], lastHeartbeatAt: null, steamTokenExpiresAt: null }
          : { status: h.status, problems: h.problems.map((p) => p.code), lastHeartbeatAt: h.lastHeartbeatAt, steamTokenExpiresAt: h.steamTokenExpiresAt };
      }),
    );
    return json(worst === "down" ? 503 : 200, {
      status: worst,
      accounts,
      prover: this.gate?.stats() ?? null,
      version: sdkVersion(),
      libraryVersion: headlessVersion(),
    });
  }

  #authorized(header: string | undefined): boolean {
    if (header?.startsWith("Bearer ") !== true) return false;
    const presented = Buffer.from(header.slice(7), "utf8");
    const same = presented.length === this.#secret.length;
    return timingSafeEqual(same ? presented : this.#secret, this.#secret) && same;
  }
}

function json(status: number, body: unknown): ApiResponse {
  return { status, body: JSON.stringify(body) };
}

async function main(): Promise<void> {
  const log = new Log();
  const path = process.argv[2] ?? process.env.DMARKET_SDK_CONFIG;
  if (path === undefined) {
    log.error("no config: pass its path as the first argument or in DMARKET_SDK_CONFIG");
    process.exitCode = 2;
    return;
  }
  let config: MultiConfig;
  try {
    config = parseMultiConfig(await readFile(path, "utf8"));
  } catch (e) {
    log.error("config is invalid", { path, reason: e instanceof ConfigError ? e.message : null });
    process.exitCode = 2;
    return;
  }

  const gate = config.globalConcurrency === null || !config.base.prover.enabled
    ? null
    : await ProverGate.open(join(config.base.dataDir, "prover-gate.sock"), config.globalConcurrency);
  if (gate !== null) {
    const limit = await cgroupMemoryLimit();
    const need = gate.capacity * config.base.prover.peakMemoryMb * 1024 * 1024;
    if (limit !== null && limit < need) {
      log.warn("memory limit is below globalConcurrency proofs at their peak", { limitBytes: String(limit), needBytes: String(need) });
    }
  }

  const preloadUrl = new URL("./prover-preload.js", import.meta.url).href;
  const hosts = new Map<string, AccountHost>();
  for (const account of config.accounts) {
    const host = new AccountHost(account, {
      account,
      baseJson: config.baseJson,
      preloadUrl,
      gatePath: gate?.path ?? null,
      connectDeadlineMs: config.connectDeadlineMs,
    }, log);
    hosts.set(account.id, host);
    host.start();
  }

  const server = new ManagementServer(new MultiApi(config.base.managementSecret, hosts, gate), log);
  await server.listen(config.base.listenHost, config.base.listenPort);
  log.info("sdk started", {
    mode: "multi-account",
    accounts: String(hosts.size),
    proverGlobalConcurrency: gate === null ? null : String(gate.capacity),
    version: sdkVersion(),
    libraryVersion: headlessVersion(),
    listen: `${config.base.listenHost}:${String(config.base.listenPort)}`,
  });

  const shutdown = () => {
    log.info("sdk stopping");
    server.close();
    gate?.close();
    void Promise.all([...hosts.values()].map((h) => h.stop())).finally(() => process.exit(0));
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
}

await main();
