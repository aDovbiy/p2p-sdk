import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { sdkVersion } from "./version.js";

test("sdkVersion is the version in the package root's package.json", () => {
  // Read from the working directory, not relative to this file, so a wrong relative path in sdkVersion fails here.
  const manifest = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")) as { version: string };
  assert.equal(sdkVersion(), manifest.version);
});
