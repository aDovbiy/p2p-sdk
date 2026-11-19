/**
 * One Steam account, in a worker thread of its own: the unchanged single-account runtime, with every connection of
 * this account sent through its proxy.
 *
 * - The tracker's HTTP (DMarket and Steam) goes through `fetch`, whose dispatcher is per thread: this thread's is a
 *   `ProxyAgent` for the account's proxy.
 * - Prover processes are forked with an allowlisted environment and no `execArgv`; this thread's `child_process.fork`
 *   adds the proxy and the gate to the environment and `--import`s `prover-preload.js` (see there).
 *
 * The parent talks to it with `{ id, op, args }` messages and gets `{ id, result }` or `{ id, error }` back.
 */
import childProcess from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { parentPort, workerData } from "node:worker_threads";

import { ProxyAgent, setGlobalDispatcher } from "undici";

import { parseConfig } from "../config.js";
import { Log } from "../log.js";
import { SdkRuntime } from "../runtime.js";
import type { AccountConfig } from "./config.js";

export interface WorkerInput {
  readonly account: AccountConfig;
  readonly baseJson: Record<string, unknown>;
  readonly preloadUrl: string;
  readonly gatePath: string | null;
  readonly connectDeadlineMs: number;
}

export type WorkerRequest =
  | { readonly id: number; readonly op: "key"; readonly args: [string, string] }
  | { readonly id: number; readonly op: "token"; readonly args: [string] }
  | { readonly id: number; readonly op: "health"; readonly args: [] }
  | { readonly id: number; readonly op: "stop"; readonly args: [] };

const input = workerData as WorkerInput;
const port = parentPort;
if (port === null) throw new Error("account-worker runs in a worker thread only");
const { account } = input;

if (account.proxy !== null) setGlobalDispatcher(new ProxyAgent(account.proxy));

// The library calls `fork` on the `node:child_process` default export at the time of the call: this thread's copy.
const originalFork = childProcess.fork.bind(childProcess);
childProcess.fork = ((modulePath: string, args?: readonly string[], options?: childProcess.ForkOptions) => {
  const env: NodeJS.ProcessEnv = { ...(options?.env ?? {}) };
  if (account.proxy !== null) env.P2P_PROXY_URL = account.proxy;
  if (input.gatePath !== null) env.P2P_PROVER_GATE = input.gatePath;
  return originalFork(modulePath, args ?? [], { ...options, env, execArgv: ["--import", input.preloadUrl] });
}) as typeof childProcess.fork;

const dataDir = join(String(input.baseJson.dataDir), account.id);
mkdirSync(dataDir, { recursive: true, mode: 0o700 });
const config = parseConfig(JSON.stringify({ ...input.baseJson, dataDir, steamWrites: account.steamWrites }));

// Every line names its account. The library's lines carry no secret; the proxy URL is never written.
const log = new Log((line) => {
  process.stdout.write(`{"account":${JSON.stringify(account.id)},${line.slice(1)}\n`);
});

function createRuntime(): SdkRuntime {
  if (!config.prover.enabled) return new SdkRuntime(config, log);
  const prover = {
    maxConcurrency: config.prover.maxConcurrency,
    proofsPerChild: config.prover.proofsPerChild,
    threadCount: config.prover.threadCount,
    connectDeadlineMs: input.connectDeadlineMs,
    ...(config.prover.assetsDir === null ? {} : { assetsDir: config.prover.assetsDir }),
  };
  try {
    return new SdkRuntime(config, log, { prover });
  } catch (e) {
    if (!(e instanceof Error) || !e.message.startsWith("prover files not found")) throw e;
    log.error("prover files not found: no proofs will be made", { reason: e.message });
    return new SdkRuntime(config, log);
  }
}

const runtime = createRuntime();
runtime.start();
log.info("account started", { proxied: String(account.proxy !== null), steamWrites: String(account.steamWrites) });

port.on("message", (request: WorkerRequest) => {
  void (async () => {
    try {
      let result: unknown;
      switch (request.op) {
        case "key":
          result = await runtime.putDmarketKey(...request.args);
          break;
        case "token":
          result = await runtime.putSteamToken(...request.args);
          break;
        case "health":
          result = runtime.health();
          break;
        case "stop":
          await runtime.stop();
          result = null;
          break;
      }
      port.postMessage({ id: request.id, result });
    } catch {
      // The error may quote what was pushed: only its fact goes back.
      port.postMessage({ id: request.id, error: "INTERNAL" });
    }
  })();
});
