import { MANAGEMENT_SECRET, withRuntime } from "./test-support/runtime-harness.js";

import assert from "node:assert/strict";
import { test } from "node:test";

import { ManagementApi } from "./api.js";
import { Log } from "./log.js";
import { ManagementServer } from "./server.js";
import {
  OTHER_PUBLIC_KEY,
  OTHER_SECRET_KEY,
  OTHER_STEAM_ID,
  PUBLIC_KEY,
  SECRET_KEY,
  steamToken,
  T0,
  tokenPayload,
} from "./test-support/dmarket-stub.js";

test("no secret pushed through the api reaches a log line, an answer or health", () =>
  withRuntime(async ({ sdk, stub, lines, clock, settle }) => {
    const server = new ManagementServer(new ManagementApi(MANAGEMENT_SECRET, sdk), new Log((line) => lines.push(line)));
    await server.listen("127.0.0.1", 0);
    const base = `http://127.0.0.1:${String(server.boundPort())}`;
    const tokens = [
      steamToken(),
      steamToken({ sub: OTHER_STEAM_ID }),
      steamToken({ aud: ["web", "renew"] }),
      steamToken({ expiresAtMs: T0 + 60 * 60_000 }),
    ];
    const answers: string[] = [];
    const call = async (method: string, path: string, body?: string, bearer = MANAGEMENT_SECRET) => {
      const response = await fetch(`${base}${path}`, {
        method,
        headers: { authorization: `Bearer ${bearer}` },
        ...(body === undefined ? {} : { body }),
      });
      answers.push(`${String(response.status)} ${await response.text()}`);
      return response.status;
    };
    const key = (publicKey: string, secretKey: string) => JSON.stringify({ publicKey, secretKey });
    const token = (accessToken: string | undefined) => JSON.stringify({ accessToken });
    try {
      assert.equal(await call("PUT", "/v1/dmarket/key", key(PUBLIC_KEY, SECRET_KEY)), 204);
      assert.equal(await call("PUT", "/v1/steam/session", token(tokens[0])), 204);
      await settle();
      assert.equal(await call("PUT", "/v1/steam/session", token(tokens[1])), 409);
      assert.equal(await call("PUT", "/v1/steam/session", token(tokens[2])), 400);
      stub.otherKeyHeartbeat = { linkedSteamId: OTHER_STEAM_ID };
      assert.equal(await call("PUT", "/v1/dmarket/key", key(OTHER_PUBLIC_KEY, OTHER_SECRET_KEY)), 409);
      stub.otherKeyHeartbeat = { status: 502 };
      assert.equal(await call("PUT", "/v1/dmarket/key", key(OTHER_PUBLIC_KEY, OTHER_SECRET_KEY)), 503);
      assert.equal(await call("PUT", "/v1/dmarket/key", key(PUBLIC_KEY, `${SECRET_KEY}zz`)), 400);
      assert.equal(await call("PUT", "/v1/dmarket/key", `{"publicKey":"${PUBLIC_KEY}","secretKey":"${SECRET_KEY}`), 400);
      assert.equal(await call("PUT", "/v1/steam/session", token(tokens[0]), "wrong-bearer"), 401);
      assert.equal(await call("PUT", "/v1/steam/session", token(tokens[3])), 204);
      clock.now += 2 * 60 * 60_000;
      await settle();
      assert.equal(await call("GET", "/v1/health"), 200);
    } finally {
      server.close();
    }

    const health = JSON.stringify(sdk.health());
    assert.ok(health.includes("STEAM_TOKEN_EXPIRED"), health);
    const secrets = [SECRET_KEY, OTHER_SECRET_KEY, MANAGEMENT_SECRET, ...tokens.map(tokenPayload)];
    for (const text of [...lines, ...answers, health]) {
      for (const secret of secrets) assert.ok(!text.includes(secret), `a secret leaked: ${text}`);
    }
    assert.ok(lines.length > 10 && answers.length === 11, `${String(lines.length)} lines, ${String(answers.length)} answers`);
  }));
