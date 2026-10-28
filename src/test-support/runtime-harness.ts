import "./offline.js";

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { headlessVersion } from "@dmarket/p2p-tracker-headless";

import { parseConfig } from "../config.js";
import { Log } from "../log.js";
import { SdkRuntime } from "../runtime.js";
import { DmarketStub, PUBLIC_KEY, SECRET_KEY, steamToken, T0 } from "./dmarket-stub.js";
import { refusedHosts } from "./offline.js";

export const MANAGEMENT_SECRET = "m".repeat(32);

export interface Harness {
  readonly sdk: SdkRuntime;
  readonly stub: DmarketStub;
  readonly clock: { now: number };
  /** Every log line so far. */
  readonly lines: string[];
  readonly codes: () => string[];
  /** Waits out the cycles pushes start in the background. */
  readonly settle: () => Promise<void>;
  /** Key, token, and the heartbeat they start: the key is bound to `STEAM_ID`. */
  readonly bind: () => Promise<void>;
}

/**
 * An SDK on a fresh data directory, a test clock at T0 and a DMarket stub on loopback, stopped after `run`. Checks
 * afterwards that nothing left the machine and that every heartbeat reported the library's version, the one DMarket
 * compares with its minimum.
 */
export async function withRuntime(run: (h: Harness) => Promise<void> | void): Promise<void> {
  const stub = await DmarketStub.start();
  const dataDir = await mkdtemp(join(tmpdir(), "p2p-sdk-runtime-"));
  const clock = { now: T0 };
  const lines: string[] = [];
  const config = parseConfig(
    JSON.stringify({ managementSecret: MANAGEMENT_SECRET, dataDir, dmarketBaseUrl: stub.baseUrl }),
  );
  const sdk = new SdkRuntime(config, new Log((line) => lines.push(line), () => clock.now), { nowMs: () => clock.now });
  const settle = async () => {
    // A push heartbeats at once in a cycle of its own, which may queue behind a file write: until two more cycles in
    // a row send DMarket as much (nothing with no heartbeat due, one each for a refused heartbeat retried every
    // cycle), one is still on its way.
    let previous = -1;
    for (let i = 0; i < 20; i++) {
      const sent = stub.requests.length;
      await sdk.cycle();
      await new Promise((resolve) => setTimeout(resolve, 20));
      const delta = stub.requests.length - sent;
      if (delta === previous && stub.inFlight === 0) return;
      previous = delta;
    }
    throw new Error("the tracker kept sending");
  };
  try {
    await run({
      sdk,
      stub,
      clock,
      lines,
      codes: () => sdk.health().problems.map((it) => it.code),
      settle,
      bind: async () => {
        assert.equal((await sdk.putDmarketKey(PUBLIC_KEY, SECRET_KEY)).type, "held");
        assert.equal((await sdk.putSteamToken(steamToken())).type, "held");
        await settle();
      },
    });
    assert.deepEqual(refusedHosts, [], "nothing but the stub was called");
    for (const version of stub.clientVersions()) assert.equal(version, headlessVersion());
  } finally {
    await sdk.stop();
    await stub.close();
    await rm(dataDir, { recursive: true, force: true });
  }
}
