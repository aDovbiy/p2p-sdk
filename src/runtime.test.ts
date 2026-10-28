import { MANAGEMENT_SECRET, withRuntime } from "./test-support/runtime-harness.js";

import assert from "node:assert/strict";
import { test } from "node:test";

import { headlessVersion, steamNotLinkedCode } from "@dmarket/p2p-tracker-headless";

import type { PushOutcome } from "./api.js";
import { parseConfig } from "./config.js";
import {
  OTHER_PUBLIC_KEY,
  OTHER_SECRET_KEY,
  OTHER_STEAM_ID,
  PUBLIC_KEY,
  SECRET_KEY,
  STEAM_ID,
  steamToken,
  T0,
  tokenPayload,
} from "./test-support/dmarket-stub.js";
import { proverOptions } from "./runtime.js";
import { isoInstant } from "./time.js";
import { sdkVersion } from "./version.js";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

const invalid = (error: string, reason: string): PushOutcome => ({ type: "invalid", error, reason });
const conflict = (error: string, reason: string): PushOutcome => ({ type: "conflict", error, reason });
const msg = (line: string) => (JSON.parse(line) as { msg: string }).msg;

test("a key push answers held or invalid without quoting the secret", () =>
  withRuntime(async ({ sdk }) => {
    const answers = [
      await sdk.putDmarketKey(PUBLIC_KEY, `${SECRET_KEY}zz`),
      await sdk.putDmarketKey(PUBLIC_KEY, SECRET_KEY),
      await sdk.putDmarketKey(PUBLIC_KEY, SECRET_KEY),
      await sdk.putDmarketKey(PUBLIC_KEY, OTHER_SECRET_KEY),
    ];
    assert.deepEqual(answers, [
      invalid("INVALID_KEY", "expected a hex Ed25519 key pair: a 32-byte public key and its secret"),
      { type: "held" },
      { type: "held" },
      invalid("INVALID_KEY", "the secret key cannot sign"),
    ]);
    const text = JSON.stringify(answers);
    assert.ok(!text.includes(SECRET_KEY) && !text.includes(OTHER_SECRET_KEY));
  }));

test("a token push answers held, invalid or conflict", () =>
  withRuntime(async ({ sdk, settle }) => {
    assert.deepEqual(
      await sdk.putSteamToken(steamToken({ aud: ["web", "renew"] })),
      invalid("INVALID_TOKEN", "a refresh token is never accepted"),
    );
    assert.deepEqual(await sdk.putSteamToken(steamToken()), { type: "held" });
    assert.deepEqual(
      await sdk.putSteamToken(steamToken({ sub: OTHER_STEAM_ID })),
      conflict("STEAM_WRONG_ACCOUNT", `the token is for ${OTHER_STEAM_ID}, not the account of the token already held`),
    );

    await sdk.putDmarketKey(PUBLIC_KEY, SECRET_KEY);
    await settle();
    assert.deepEqual(
      await sdk.putSteamToken(steamToken({ sub: OTHER_STEAM_ID })),
      conflict("STEAM_WRONG_ACCOUNT", `the token is for ${OTHER_STEAM_ID}, not ${STEAM_ID}`),
      "once DMarket names the account, the refusal names it too",
    );
  }));

test("a fresh start is down with both secrets missing", () =>
  withRuntime(({ sdk }) => {
    const health = sdk.health();
    assert.deepEqual(
      health.problems.map((it) => it.code),
      ["DMARKET_KEY_MISSING", "STEAM_TOKEN_MISSING"],
    );
    assert.equal(health.status, "down");
    assert.equal(health.version, sdkVersion());
    assert.equal(health.libraryVersion, headlessVersion());
  }));

test("a refused token is a wrong account until one is held", () =>
  withRuntime(async ({ sdk, codes, bind }) => {
    await bind();
    await sdk.putSteamToken(steamToken({ sub: OTHER_STEAM_ID }));
    assert.deepEqual(codes(), ["STEAM_WRONG_ACCOUNT"]);

    await sdk.putSteamToken(steamToken());
    assert.deepEqual(codes(), []);
  }));

test("a key for the same account rotates", () =>
  withRuntime(async ({ sdk, lines, codes, bind }) => {
    await bind();
    assert.deepEqual(await sdk.putDmarketKey(OTHER_PUBLIC_KEY, OTHER_SECRET_KEY), { type: "held" });
    const rotated = lines.filter((line) => msg(line) === "dmarket key rotated");
    assert.equal(rotated.length, 1, lines.join("\n"));
    assert.ok(rotated[0]?.includes(OTHER_PUBLIC_KEY));
    // The stub sends no `Date`: a tracker on a clock months behind the real one is not skewed.
    assert.deepEqual(codes(), []);
  }));

test("a key for another account is a conflict until a key is held", () =>
  withRuntime(async ({ sdk, stub, lines, codes, bind }) => {
    await bind();
    stub.otherKeyHeartbeat = { linkedSteamId: OTHER_STEAM_ID };
    assert.deepEqual(
      await sdk.putDmarketKey(OTHER_PUBLIC_KEY, OTHER_SECRET_KEY),
      conflict(
        "DMARKET_KEY_ACCOUNT_CHANGED",
        `the key's account links Steam account ${OTHER_STEAM_ID}, not ${STEAM_ID}; the held key stays: ` +
          "switching accounts takes a restart",
      ),
    );
    const health = sdk.health();
    assert.deepEqual(
      health.problems.map((it) => it.code),
      ["DMARKET_KEY_ACCOUNT_CHANGED"],
    );
    assert.equal(health.status, "degraded", "the held key still serves its own account");
    const refused = lines.filter((line) => msg(line) === "dmarket key for another account refused");
    assert.equal(refused.length, 1);
    assert.deepEqual(JSON.parse(refused[0] ?? ""), {
      ts: isoInstant(T0),
      level: "warn",
      msg: "dmarket key for another account refused",
      publicKey: OTHER_PUBLIC_KEY,
      heldPublicKey: PUBLIC_KEY,
      linkedSteamId: STEAM_ID,
      keyLinkedSteamId: OTHER_STEAM_ID,
    });

    assert.deepEqual(await sdk.putDmarketKey(PUBLIC_KEY, SECRET_KEY), { type: "held" });
    assert.deepEqual(codes(), [], "a held key ends the refusal");
  }));

test("a key that cannot be checked is refused by why", () =>
  withRuntime(async ({ sdk, stub, lines, codes, bind }) => {
    await bind();
    stub.otherKeyHeartbeat = { status: 401 };
    assert.deepEqual(
      await sdk.putDmarketKey(OTHER_PUBLIC_KEY, OTHER_SECRET_KEY),
      invalid("INVALID_KEY", "DMarket refused the key"),
    );
    stub.otherKeyHeartbeat = { status: 502 };
    assert.deepEqual(await sdk.putDmarketKey(OTHER_PUBLIC_KEY, OTHER_SECRET_KEY), {
      type: "unavailable",
      error: "DMARKET_UNREACHABLE",
      reason: "the key could not be checked: its heartbeat failed: HTTP 502; the held key stays",
    });
    assert.ok(lines.some((line) => msg(line) === "dmarket key unchecked"), lines.join("\n"));
    assert.deepEqual(codes(), [], "a key that was never held raises nothing");
  }));

test("an account with no steam link is down with steam not linked", () =>
  withRuntime(async ({ sdk, stub, settle }) => {
    stub.heartbeat = { status: 403, code: steamNotLinkedCode() };
    await sdk.putDmarketKey(PUBLIC_KEY, SECRET_KEY);
    await sdk.putSteamToken(steamToken());
    await settle();

    const health = sdk.health();
    assert.deepEqual(
      health.problems.map((it) => it.code),
      ["STEAM_NOT_LINKED"],
    );
    assert.equal(health.status, "down");
  }));

test("a key refused on a skewed clock answers clock skew", () =>
  withRuntime(async ({ sdk, stub, codes, bind }) => {
    await bind();
    stub.serverDateMs = T0 + 5 * MINUTE;
    stub.otherKeyHeartbeat = { status: 401 };

    const answer = await sdk.putDmarketKey(OTHER_PUBLIC_KEY, OTHER_SECRET_KEY);
    assert.ok(answer.type === "unavailable" && answer.error === "CLOCK_SKEW", JSON.stringify(answer));
    assert.deepEqual(codes(), ["CLOCK_SKEW"]);
  }));

test("a lapsed token degrades while the sdk keeps heartbeating", () =>
  withRuntime(async ({ sdk, stub, clock, settle }) => {
    await sdk.putDmarketKey(PUBLIC_KEY, SECRET_KEY);
    await sdk.putSteamToken(steamToken({ expiresAtMs: T0 + HOUR }));
    await settle();
    const heartbeats = stub.clientVersions().length;
    clock.now += 2 * HOUR;
    await settle();

    const health = sdk.health();
    assert.deepEqual(
      health.problems.map((it) => it.code),
      ["STEAM_TOKEN_EXPIRED"],
    );
    assert.equal(health.status, "degraded");
    assert.equal(health.lastHeartbeatAt, isoInstant(T0 + 2 * HOUR), "the heartbeat went on without a token");
    assert.ok(stub.clientVersions().length > heartbeats);
  }));

test("below the minimum version the sdk is degraded and quotes the library's version", () =>
  withRuntime(async ({ sdk, stub, settle }) => {
    stub.heartbeat = { updateRequired: true };
    await sdk.putDmarketKey(PUBLIC_KEY, SECRET_KEY);
    await sdk.putSteamToken(steamToken());
    await settle();

    const health = sdk.health();
    const first = health.problems[0];
    assert.equal(first?.code, "SDK_UPDATE_REQUIRED", JSON.stringify(health.problems));
    assert.ok(first.message.includes(`(${headlessVersion()})`), first.message);
    assert.equal(health.status, "degraded");
  }));

test("the log records every push and no secret reaches it or health", () =>
  withRuntime(async ({ sdk, stub, lines, settle }) => {
    const token = steamToken();
    const answers = [
      await sdk.putDmarketKey(PUBLIC_KEY, SECRET_KEY + PUBLIC_KEY),
      await sdk.putSteamToken(steamToken({ aud: ["web", "renew"] })),
      await sdk.putSteamToken(token),
    ];
    await settle();
    answers.push(await sdk.putSteamToken(steamToken({ sub: OTHER_STEAM_ID })));
    stub.otherKeyHeartbeat = { linkedSteamId: OTHER_STEAM_ID };
    answers.push(await sdk.putDmarketKey(OTHER_PUBLIC_KEY, OTHER_SECRET_KEY));
    stub.otherKeyHeartbeat = { status: 502 };
    answers.push(await sdk.putDmarketKey(OTHER_PUBLIC_KEY, OTHER_SECRET_KEY));

    const messages = lines.map(msg);
    for (const expected of [
      "dmarket key pushed",
      "steam token refused",
      "steam token held",
      "steam token for another account refused",
      "dmarket key for another account refused",
      "dmarket key unchecked",
      "event",
    ]) {
      assert.ok(messages.includes(expected), `no "${expected}" in ${messages.join(", ")}`);
    }
    const held = lines.find((line) => msg(line) === "steam token held");
    assert.ok(held?.includes(`"expiresAt":"${isoInstant(T0 + 24 * HOUR)}"`), held);
    for (const text of [...lines, JSON.stringify(sdk.health()), JSON.stringify(answers)]) {
      for (const secret of [SECRET_KEY, OTHER_SECRET_KEY, tokenPayload(token), MANAGEMENT_SECRET]) {
        assert.ok(!text.includes(secret), `a secret leaked: ${text}`);
      }
    }
  }));

test("the config's prover becomes the tracker's prover option, and none when it is off", () => {
  const prover = (p: Record<string, unknown>) =>
    proverOptions(parseConfig(JSON.stringify({ managementSecret: MANAGEMENT_SECRET, dataDir: "/data", prover: p })).prover);
  assert.deepEqual(prover({}), { maxConcurrency: 1, proofsPerChild: 1, threadCount: 2 });
  assert.deepEqual(prover({ maxConcurrency: 2, proofsPerChild: 5, threadCount: 8, assetsDir: "/prover" }), {
    maxConcurrency: 2,
    proofsPerChild: 5,
    threadCount: 8,
    assetsDir: "/prover",
  });
  assert.equal(prover({ enabled: false, assetsDir: "/prover" }), undefined);
});

test("low prover memory is a health problem in MiB and a warning with the bytes", () =>
  withRuntime(({ sdk, lines, codes }) => {
    const mib = 1024 * 1024;
    sdk.proverMemoryLow(512 * mib, 100 * mib);
    assert.ok(codes().includes("PROVER_MEMORY_LOW"));
    assert.equal(
      sdk.health().problems.find((it) => it.code === "PROVER_MEMORY_LOW")?.message,
      "the memory limit is 512 MiB and the SDK uses 100 MiB: one proof needs up to 640 MiB beside it",
    );
    const line = JSON.parse(lines.at(-1) ?? "{}") as Record<string, unknown>;
    assert.deepEqual(
      { level: line.level, msg: line.msg, limitBytes: line.limitBytes, usedBytes: line.usedBytes },
      { level: "warn", msg: "prover memory low", limitBytes: "536870912", usedBytes: "104857600" },
    );
  }));
