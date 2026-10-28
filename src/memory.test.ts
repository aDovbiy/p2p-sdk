import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

import { HealthTracker } from "./health/tracker.js";
import { cgroupMemoryLimit, isLow, limitBytes } from "./memory.js";
import { STEAM_ID, T0 } from "./test-support/dmarket-stub.js";

const MIB = 1024 * 1024;

/** A fake cgroup filesystem holding `files`, removed after `run`. */
async function withCgroup(files: Record<string, string>, run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "p2p-sdk-cgroup-"));
  try {
    for (const [name, text] of Object.entries(files)) {
      const path = join(root, name);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, text);
    }
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("a cgroup limit is read from either version", () => {
  assert.equal(limitBytes("536870912\n", null), 536_870_912);
  assert.equal(limitBytes("max\n", "1"), null);
  assert.equal(limitBytes(null, "805306368"), 805_306_368);
  assert.equal(limitBytes(null, "9223372036854771712"), null);
  assert.equal(limitBytes(null, null), null);
  assert.equal(limitBytes("", "1"), null, "an empty memory.max is not a limit of 0");
});

test("memory is low when one peak does not fit beside the sdk", () => {
  assert.equal(isLow(512 * MIB, 120 * MIB, 768 * MIB), true);
  assert.equal(isLow(1024 * MIB, 120 * MIB, 768 * MIB), false);
  assert.equal(isLow(null, 120 * MIB, 768 * MIB), false);
});

test("a 512 MiB container cannot hold a proof beside the sdk", () =>
  withCgroup({ "memory.max": "536870912\n" }, async (root) => {
    const limit = await cgroupMemoryLimit(root);
    assert.equal(limit, 536_870_912);
    assert.equal(isLow(limit, 100 * MIB, 768 * MIB), true);

    const health = new HealthTracker(() => T0, "1.2.3", "1.2.3");
    health.proverMemoryLow(536_870_912, 100 * MIB, 768 * MIB);
    const problem = health
      .snapshot({
        hasTradingApiKey: true,
        steamTokenSteamId: STEAM_ID,
        steamTokenExpiresAtMs: T0 + 24 * 60 * 60_000,
        linkedSteamId: STEAM_ID,
        readySinceMs: null,
        trackedDealIds: [],
        clockOffsetMs: 0,
        clockSkewed: false,
        steamNotLinked: false,
        updateRequired: false,
        updateDueTimeMs: null,
        dealDeadlines: {},
      })
      .problems.find((it) => it.code === "PROVER_MEMORY_LOW");
    assert.equal(
      problem?.message,
      "the memory limit is 512 MiB and the SDK uses 100 MiB: one proof needs up to 768 MiB beside it",
    );
  }));

test("cgroup v1 and no limit are read too", async () => {
  await withCgroup({ "memory/memory.limit_in_bytes": "805306368\n" }, async (root) => {
    assert.equal(await cgroupMemoryLimit(root), 805_306_368);
  });
  await withCgroup({ "memory.max": "max\n" }, async (root) => {
    assert.equal(await cgroupMemoryLimit(root), null);
  });
  await withCgroup({}, async (root) => {
    assert.equal(await cgroupMemoryLimit(root), null);
  });
});
