import assert from "node:assert/strict";
import { test } from "node:test";
import { inspect } from "node:util";

import { defaultBaseUrl, defaultNotaryUrl } from "@dmarket/p2p-tracker-headless";

import { ConfigError, parseConfig } from "./config.js";

const SECRET = "management-secret-0123456789abcdef";

function configText(overrides: Record<string, unknown> = {}, prover?: Record<string, unknown>): string {
  return JSON.stringify({ managementSecret: SECRET, dataDir: "/data", ...overrides, ...(prover ? { prover } : {}) });
}

/** The error a config is refused with; it must never carry the secret. */
function refusal(text: string): ConfigError {
  try {
    parseConfig(text);
  } catch (e) {
    assert.ok(e instanceof ConfigError, String(e));
    assert.ok(!e.message.includes(SECRET) && !(e.stack ?? "").includes(SECRET), e.message);
    return e;
  }
  assert.fail(`accepted: ${text.replace(SECRET, "<secret>")}`);
}

test("only the secret and the data directory are required; everything else has the library's defaults", () => {
  const config = parseConfig(configText());
  assert.equal(config.managementSecret, SECRET);
  assert.equal(config.dataDir, "/data");
  assert.equal(config.listenHost, "127.0.0.1");
  assert.equal(config.listenPort, 8790);
  assert.equal(config.dmarketBaseUrl, defaultBaseUrl());
  assert.equal(config.steamWrites, true);
  assert.deepEqual(config.prover, {
    enabled: true,
    notaryUrl: defaultNotaryUrl(),
    maxConcurrency: 1,
    proofsPerChild: 1,
    threadCount: 2,
    peakMemoryMb: 640,
    assetsDir: null,
  });
  assert.equal(defaultNotaryUrl(), "wss://api.dmarket.com/provenance/v1/");
});

test("the prover config defaults to one proof per process and bounds its knobs", () => {
  const prover = parseConfig(
    configText({}, { notaryUrl: "wss://notary.example/provenance/v1/", maxConcurrency: 2, proofsPerChild: 5 }),
  ).prover;
  assert.equal(prover.notaryUrl, "wss://notary.example/provenance/v1/");
  assert.equal(prover.maxConcurrency, 2);
  assert.equal(prover.proofsPerChild, 5);
  assert.match(refusal(configText({}, { maxConcurrency: 3 })).message, /prover\.maxConcurrency/);
  assert.match(refusal(configText({}, { proofsPerChild: 6 })).message, /prover\.proofsPerChild/);
  assert.match(refusal(configText({}, { notaryUrl: "https://notary" })).message, /prover\.notaryUrl/);
});

test("every value set in the file is read", () => {
  const config = parseConfig(
    configText(
      { listenHost: "0.0.0.0", listenPort: 9000, dmarketBaseUrl: "http://127.0.0.1:1", steamWrites: false },
      { enabled: false, notaryUrl: "ws://127.0.0.1:2/", threadCount: 8, peakMemoryMb: 700, assetsDir: "/prover" },
    ),
  );
  assert.deepEqual(
    [config.listenHost, config.listenPort, config.dmarketBaseUrl, config.steamWrites],
    ["0.0.0.0", 9000, "http://127.0.0.1:1", false],
  );
  assert.deepEqual(config.prover, {
    enabled: false,
    notaryUrl: "ws://127.0.0.1:2/",
    maxConcurrency: 1,
    proofsPerChild: 1,
    threadCount: 8,
    peakMemoryMb: 700,
    assetsDir: "/prover",
  });
  assert.equal(parseConfig(configText({}, { assetsDir: null })).prover.assetsDir, null);
});

test("each bound holds on its edge and refuses past it, naming the field", () => {
  const cases: [string, Record<string, unknown>, Record<string, unknown> | undefined, boolean][] = [
    ["managementSecret", { managementSecret: "s".repeat(32) }, undefined, true],
    ["managementSecret", { managementSecret: "s".repeat(31) }, undefined, false],
    ["dataDir", { dataDir: "d" }, undefined, true],
    ["dataDir", { dataDir: "" }, undefined, false],
    ["dataDir", { dataDir: " \t" }, undefined, false],
    ["listenPort", { listenPort: 1 }, undefined, true],
    ["listenPort", { listenPort: 65_535 }, undefined, true],
    ["listenPort", { listenPort: 0 }, undefined, false],
    ["listenPort", { listenPort: 65_536 }, undefined, false],
    ["listenPort", { listenPort: 8790.5 }, undefined, false],
    ["prover.maxConcurrency", {}, { maxConcurrency: 1 }, true],
    ["prover.maxConcurrency", {}, { maxConcurrency: 2 }, true],
    ["prover.maxConcurrency", {}, { maxConcurrency: 0 }, false],
    ["prover.maxConcurrency", {}, { maxConcurrency: 3 }, false],
    ["prover.proofsPerChild", {}, { proofsPerChild: 1 }, true],
    ["prover.proofsPerChild", {}, { proofsPerChild: 5 }, true],
    ["prover.proofsPerChild", {}, { proofsPerChild: 0 }, false],
    ["prover.proofsPerChild", {}, { proofsPerChild: 6 }, false],
    ["prover.threadCount", {}, { threadCount: 1 }, true],
    ["prover.threadCount", {}, { threadCount: 16 }, true],
    ["prover.threadCount", {}, { threadCount: 0 }, false],
    ["prover.threadCount", {}, { threadCount: 17 }, false],
    ["prover.peakMemoryMb", {}, { peakMemoryMb: 1 }, true],
    ["prover.peakMemoryMb", {}, { peakMemoryMb: 0 }, false],
    ["prover.notaryUrl", {}, { notaryUrl: "ws://n/" }, true],
    ["prover.notaryUrl", {}, { notaryUrl: "wss://n/" }, true],
    ["prover.notaryUrl", {}, { notaryUrl: "https://n/" }, false],
  ];
  for (const [field, top, prover, accepted] of cases) {
    const text = configText(top, prover);
    if (accepted) {
      assert.doesNotThrow(() => parseConfig(text), `${field} ${JSON.stringify({ ...top, ...prover })}`);
    } else {
      assert.ok(refusal(text).message.startsWith(`${field} `), `${field} ${JSON.stringify({ ...top, ...prover })}`);
    }
  }
});

test("a missing field, a value of the wrong type and null are refused by name", () => {
  const cases: [string, string][] = [
    [JSON.stringify({ dataDir: "/data" }), "managementSecret is required"],
    [JSON.stringify({ managementSecret: SECRET }), "dataDir is required"],
    [configText({ managementSecret: null }), "managementSecret must be a string"],
    [configText({ listenPort: "8790" }), "listenPort must be an integer"],
    [configText({ steamWrites: "yes" }), "steamWrites must be true or false"],
    [configText({ listenHost: null }), "listenHost must be a string"],
    [configText({ prover: [] }), "prover must be an object"],
    [configText({ prover: null }), "prover must be an object"],
    [configText({}, { enabled: 1 }), "prover.enabled must be true or false"],
    [configText({}, { assetsDir: 7 }), "prover.assetsDir must be a string"],
  ];
  for (const [text, message] of cases) assert.equal(refusal(text).message, message);
});

test("an unknown key is refused by its name, at the top and in the prover", () => {
  assert.equal(refusal(configText({ listenAddress: "x" })).message, "listenAddress is not a config key");
  assert.equal(refusal(configText({}, { notary: "wss://n/" })).message, "prover.notary is not a config key");
});

test("a file that is not a JSON object is refused without quoting it", () => {
  const broken = `{"managementSecret": "${SECRET}" "dataDir": "/data"}`;
  assert.equal(refusal(broken).message, "config is not valid JSON");
  assert.equal(refusal(`{"managementSecret": "${SECRET}`).message, "config is not valid JSON");
  assert.equal(refusal(`["${SECRET}"]`).message, "config must be an object");
  assert.equal(refusal("null").message, "config must be an object");
});

test("the secret stays out of the config's string, inspection and JSON", () => {
  const config = parseConfig(configText());
  for (const shown of [String(config), inspect(config, { depth: null, showHidden: true }), JSON.stringify(config)]) {
    assert.ok(!shown.includes(SECRET), shown);
  }
  assert.ok(String(config).startsWith("SdkConfig(managementSecret=<redacted>, dataDir=/data,"), String(config));
});
