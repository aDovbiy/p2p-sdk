#!/usr/bin/env node
import { readFile } from "node:fs/promises";

import { headlessVersion } from "@dmarket/p2p-tracker-headless";

import { ManagementApi } from "./api.js";
import { ConfigError, parseConfig, type SdkConfig } from "./config.js";
import { Log } from "./log.js";
import { cgroupMemoryLimit, isLow, residentBytes } from "./memory.js";
import { proverOptions, SdkRuntime } from "./runtime.js";
import { ManagementServer } from "./server.js";
import { sdkVersion } from "./version.js";

/**
 * The process: `dmarket-p2p-sdk <config.json>`, or the path in `DMARKET_SDK_CONFIG`.
 *
 * Reads the config, checks the container's memory for the prover, starts the management API and then the tracker,
 * which waits for the bot's pushes before it heartbeats. Exits 2 on a config it cannot use, and 0 on SIGTERM or
 * SIGINT.
 */
async function main(): Promise<void> {
  const log = new Log();
  const path = process.argv[2] ?? process.env.DMARKET_SDK_CONFIG;
  if (path === undefined) {
    log.error("no config: pass its path as the first argument or in DMARKET_SDK_CONFIG");
    process.exitCode = 2;
    return;
  }
  const config = await readConfig(path, log);
  if (config === null) {
    process.exitCode = 2;
    return;
  }
  const runtime = createRuntime(config, log);
  if (config.prover.enabled) {
    const limit = await cgroupMemoryLimit();
    const used = residentBytes();
    if (limit !== null && isLow(limit, used, config.prover.peakMemoryMb * 1024 * 1024)) {
      runtime.proverMemoryLow(limit, used);
    }
  }
  const server = new ManagementServer(new ManagementApi(config.managementSecret, runtime), log);
  await server.listen(config.listenHost, config.listenPort);
  runtime.start();
  log.info("sdk started", {
    version: sdkVersion(),
    libraryVersion: headlessVersion(),
    listen: `${config.listenHost}:${String(config.listenPort)}`,
  });

  const shutdown = () => {
    log.info("sdk stopping");
    server.close();
    // Ends every prover process too.
    void runtime.stop().finally(() => process.exit(0));
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
}

/** The parsed config, or `null` after logging why not. */
async function readConfig(path: string, log: Log): Promise<SdkConfig | null> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    log.error("config file cannot be read", { path });
    return null;
  }
  try {
    return parseConfig(text);
  } catch (e) {
    // A ConfigError names the field and never its value; anything else may quote the file, secret included.
    log.error("config is invalid", { path, reason: e instanceof ConfigError ? e.message : null });
    return null;
  }
}

/** The runtime with the config's prover, or without one when the prover's files are not there. */
function createRuntime(config: SdkConfig, log: Log): SdkRuntime {
  const prover = proverOptions(config.prover);
  if (prover === undefined) return new SdkRuntime(config, log);
  try {
    return new SdkRuntime(config, log, { prover });
  } catch (e) {
    if (!(e instanceof Error) || !e.message.startsWith("prover files not found")) throw e;
    log.error("prover files not found: no proofs will be made", {
      assetsDir: config.prover.assetsDir,
      reason: e.message,
    });
    return new SdkRuntime(config, log);
  }
}

await main();
