import assert from "node:assert/strict";
import { test } from "node:test";

import { HEALTH_PATH, KEY_PATH, ManagementApi, STEAM_PATH, type ManagementActions, type PushOutcome } from "./api.js";
import type { Health } from "./health/tracker.js";

const SECRET = "s".repeat(40);
const BEARER = `Bearer ${SECRET}`;

/** Records what reaches it and answers what a test sets. */
class RecordingActions implements ManagementActions {
  readonly keys: [string, string][] = [];
  readonly tokens: string[] = [];
  keyOutcome: PushOutcome = { type: "held" };
  steamOutcome: PushOutcome = { type: "held" };
  status: Health["status"] = "ok";

  putDmarketKey(publicKey: string, secretKey: string): Promise<PushOutcome> {
    this.keys.push([publicKey, secretKey]);
    return Promise.resolve(this.keyOutcome);
  }

  putSteamToken(accessToken: string): Promise<PushOutcome> {
    this.tokens.push(accessToken);
    return Promise.resolve(this.steamOutcome);
  }

  health(): Health {
    const status = this.status;
    return { status, problems: [], steamTokenExpiresAt: null, lastHeartbeatAt: null, version: "0.1.0", libraryVersion: "1.2.3" };
  }
}

test("every route requires the bearer", async () => {
  const actions = new RecordingActions();
  const api = new ManagementApi(SECRET, actions);
  for (const auth of [undefined, "Bearer wrong", SECRET, `${BEARER}x`, `bearer ${SECRET}`, `Bearer ${SECRET.slice(1)}`]) {
    assert.equal((await api.handle("GET", HEALTH_PATH, auth, "")).status, 401, `auth=${String(auth)}`);
    assert.equal((await api.handle("PUT", STEAM_PATH, auth, '{"accessToken":"t"}')).status, 401);
    assert.equal((await api.handle("PUT", KEY_PATH, auth, '{"publicKey":"p","secretKey":"s"}')).status, 401);
  }
  assert.deepEqual(actions.tokens, [], "an unauthorized push never reaches the SDK");
  assert.deepEqual(actions.keys, []);
});

test("a key push is accepted without echoing it", async () => {
  const actions = new RecordingActions();
  const api = new ManagementApi(SECRET, actions);
  const response = await api.handle("PUT", KEY_PATH, BEARER, '{"publicKey":"pub","secretKey":"sec","note":"ignored"}');
  assert.deepEqual(response, { status: 204, body: "" });
  assert.deepEqual(actions.keys, [["pub", "sec"]]);
});

test("a token for another account is a conflict", async () => {
  const actions = new RecordingActions();
  actions.steamOutcome = { type: "conflict", error: "STEAM_WRONG_ACCOUNT", reason: "the token is for 2, not 1" };
  const response = await new ManagementApi(SECRET, actions).handle("PUT", STEAM_PATH, BEARER, '{"accessToken":"eyJsecret"}');
  assert.equal(response.status, 409);
  assert.deepEqual(JSON.parse(response.body), { error: "STEAM_WRONG_ACCOUNT", reason: "the token is for 2, not 1" });
  assert.ok(!response.body.includes("eyJsecret"));
});

test("a key for another account is a conflict and an unchecked one is unavailable", async () => {
  const body = '{"publicKey":"pk","secretKey":"sk-secret"}';
  const actions = new RecordingActions();
  const api = new ManagementApi(SECRET, actions);
  actions.keyOutcome = { type: "conflict", error: "DMARKET_KEY_ACCOUNT_CHANGED", reason: "another account" };
  const conflict = await api.handle("PUT", KEY_PATH, BEARER, body);
  assert.equal(conflict.status, 409);
  assert.ok(conflict.body.includes("DMARKET_KEY_ACCOUNT_CHANGED"), conflict.body);

  actions.keyOutcome = { type: "unavailable", error: "DMARKET_UNREACHABLE", reason: "the key could not be checked" };
  const unavailable = await api.handle("PUT", KEY_PATH, BEARER, body);
  assert.equal(unavailable.status, 503);
  assert.ok(unavailable.body.includes("DMARKET_UNREACHABLE"), unavailable.body);
  assert.ok(!(conflict.body + unavailable.body).includes("sk-secret"));
});

test("a malformed body is refused without quoting it", async () => {
  const actions = new RecordingActions();
  const api = new ManagementApi(SECRET, actions);
  const bodies = [
    '{"publicKey":"pub","secretKey":"leaked-secret"',
    '{"publicKey":"pub"}',
    '{"publicKey":"pub","secretKey":12}',
    '{"publicKey":"pub","secretKey":null}',
    '["pub","leaked-secret"]',
  ];
  for (const body of bodies) {
    const response = await api.handle("PUT", KEY_PATH, BEARER, body);
    assert.deepEqual(JSON.parse(response.body), { error: "INVALID_BODY", reason: "expected {publicKey, secretKey}" }, body);
    assert.equal(response.status, 400);
  }
  const steam = await api.handle("PUT", STEAM_PATH, BEARER, '{"accessToken":"leaked-token"');
  assert.deepEqual(JSON.parse(steam.body), { error: "INVALID_BODY", reason: "expected {accessToken}" });
  assert.deepEqual([actions.keys, actions.tokens], [[], []]);
});

test("health answers 503 while down and 200 otherwise", async () => {
  const actions = new RecordingActions();
  const api = new ManagementApi(SECRET, actions);
  actions.status = "down";
  const down = await api.handle("GET", HEALTH_PATH, BEARER, "");
  assert.equal(down.status, 503);
  assert.deepEqual(JSON.parse(down.body), actions.health(), "the same body as 200");
  for (const status of ["degraded", "ok"] as const) {
    actions.status = status;
    assert.equal((await api.handle("GET", HEALTH_PATH, BEARER, "")).status, 200, status);
  }
});

test("health is served as json and unknown routes and methods are refused", async () => {
  const api = new ManagementApi(SECRET, new RecordingActions());
  const health = await api.handle("GET", `${HEALTH_PATH}/?verbose=1`, BEARER, "");
  assert.equal(health.status, 200);
  assert.equal(
    health.body,
    '{"status":"ok","problems":[],"steamTokenExpiresAt":null,"lastHeartbeatAt":null,"version":"0.1.0","libraryVersion":"1.2.3"}',
  );

  assert.equal((await api.handle("GET", "/v1/deals", BEARER, "")).status, 404);
  const keyRead = await api.handle("GET", KEY_PATH, BEARER, "");
  assert.equal(keyRead.status, 405, "the key is write-only");
  assert.deepEqual(JSON.parse(keyRead.body), { error: "METHOD_NOT_ALLOWED", reason: "method not allowed on this route" });
  assert.equal((await api.handle("POST", HEALTH_PATH, BEARER, "")).status, 405);
});
