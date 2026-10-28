import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { inspect } from "node:util";

import { createHeadlessTracker, stop, trackerState } from "@dmarket/p2p-tracker-headless";

test("a tracker builds from the package, holds no key, exposes nothing through its handle and stops", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "p2p-sdk-headless-"));
  try {
    // Never started: the test stays off the network.
    const handle = createHeadlessTracker({ dataDir });
    assert.equal(trackerState(handle).hasTradingApiKey, false);
    assert.equal(inspect(handle, { depth: null, showHidden: true }), "[Object: null prototype] {}");
    await stop(handle);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
