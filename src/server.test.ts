import assert from "node:assert/strict";
import { request } from "node:http";
import { test } from "node:test";

import { MAX_BODY_BYTES, ManagementApi, type ManagementActions, type PushOutcome } from "./api.js";
import type { Health } from "./health/tracker.js";
import { Log } from "./log.js";
import { ManagementServer } from "./server.js";

const SECRET = "x".repeat(32);
const AUTH = { authorization: `Bearer ${SECRET}` };

function actions(overrides: Partial<ManagementActions> = {}): ManagementActions & { tokens: string[] } {
  const tokens: string[] = [];
  return {
    tokens,
    putDmarketKey: () => Promise.resolve<PushOutcome>({ type: "held" }),
    putSteamToken: (token) => {
      tokens.push(token);
      return Promise.resolve<PushOutcome>({ type: "held" });
    },
    health: (): Health => ({
      status: "ok",
      problems: [],
      steamTokenExpiresAt: null,
      lastHeartbeatAt: null,
      version: "0.1.0",
      libraryVersion: "1.2.3",
    }),
    ...overrides,
  };
}

/** A listener on loopback over `acting`, the log lines it writes, and its address. */
async function serving(acting: ManagementActions, run: (base: string, lines: string[]) => Promise<void>): Promise<void> {
  const lines: string[] = [];
  const server = new ManagementServer(new ManagementApi(SECRET, acting), new Log((line) => lines.push(line)));
  await server.listen("127.0.0.1", 0);
  try {
    await run(`http://127.0.0.1:${String(server.boundPort())}`, lines);
  } finally {
    server.close();
  }
}

const fields = (line: string | undefined) => {
  const { ts, ...rest } = JSON.parse(line ?? "{}") as Record<string, unknown>;
  assert.equal(typeof ts, "string");
  return rest;
};

test("the management listener serves the api on loopback", async () => {
  const acting = actions();
  await serving(acting, async (base, lines) => {
    const health = await fetch(`${base}/v1/health`, { headers: AUTH });
    assert.equal(health.status, 200);
    assert.ok((await health.text()).includes('"ok"'));

    const push = await fetch(`${base}/v1/steam/session`, {
      method: "PUT",
      headers: AUTH,
      body: '{"accessToken":"eyJ.secret.token"}',
    });
    assert.equal(push.status, 204);
    assert.deepEqual(acting.tokens, ["eyJ.secret.token"]);

    assert.equal((await fetch(`${base}/v1/health`)).status, 401);
    assert.ok(
      lines.every((line) => !line.includes("eyJ.secret.token") && !line.includes(SECRET)),
      "a request log never carries a header or a body",
    );
  });
});

test("each request is logged by method, route without its query, and status only", async () => {
  await serving(actions(), async (base, lines) => {
    await (await fetch(`${base}/v1/health?token=eyJ.query`, { headers: AUTH })).text();
    await (await fetch(`${base}/v1/steam/session`, { method: "PUT", body: "{}" })).text();
    assert.deepEqual(lines.map(fields), [
      { level: "info", msg: "management request", method: "GET", route: "/v1/health", status: "200" },
      { level: "info", msg: "management request", method: "PUT", route: "/v1/steam/session", status: "401" },
    ]);
  });
});

test("every answer is json and never cached", async () => {
  await serving(actions(), async (base) => {
    for (const response of [
      await fetch(`${base}/v1/health`, { headers: AUTH }),
      await fetch(`${base}/v1/steam/session`, { method: "PUT", headers: AUTH, body: '{"accessToken":"t"}' }),
      await fetch(`${base}/v1/nowhere`, { headers: AUTH }),
      await fetch(`${base}/v1/health`),
    ]) {
      assert.equal(response.headers.get("content-type"), "application/json", String(response.status));
      assert.equal(response.headers.get("cache-control"), "no-store", String(response.status));
    }
  });
});

test("a body past the limit is refused before the bearer is checked and is not logged", async () => {
  const acting = actions();
  await serving(acting, async (base, lines) => {
    const atLimit = JSON.stringify({ accessToken: "a".repeat(MAX_BODY_BYTES - '{"accessToken":""}'.length) });
    assert.equal(Buffer.byteLength(atLimit), MAX_BODY_BYTES);
    const ok = await fetch(`${base}/v1/steam/session`, { method: "PUT", headers: AUTH, body: atLimit });
    assert.equal(ok.status, 204, "a body of exactly the limit is read");

    const answer = await put(`${base}/v1/steam/session`, atLimit + " ");
    assert.deepEqual(answer, {
      status: 413,
      body: '{"error":"BODY_TOO_LARGE","reason":"the body exceeds the limit"}',
    });
    assert.equal(acting.tokens.length, 1, "the large body never reaches the SDK");
    assert.equal(lines.length, 1, `only the first request is logged: ${lines.join("\n")}`);
  });
});

test("a handler that throws answers 500 without its error", async () => {
  const acting = actions({ putSteamToken: () => Promise.reject(new Error("boom eyJ.secret.token")) });
  await serving(acting, async (base, lines) => {
    const response = await fetch(`${base}/v1/steam/session`, {
      method: "PUT",
      headers: AUTH,
      body: '{"accessToken":"eyJ.secret.token"}',
    });
    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), { error: "INTERNAL", reason: "the request could not be handled" });
    assert.deepEqual(fields(lines[0]), {
      level: "info",
      msg: "management request",
      method: "PUT",
      route: "/v1/steam/session",
      status: "500",
    });
    assert.ok(!lines.join("").includes("boom"));
  });
});

/** A PUT with no bearer through `node:http`: the answer to a body the server stops reading, or the socket error. */
function put(url: string, body: string): Promise<{ status: number | undefined; body: string }> {
  return new Promise((resolve, reject) => {
    const sent = request(url, { method: "PUT" }, (response) => {
      let text = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => (text += chunk));
      response.on("end", () => {
        resolve({ status: response.statusCode, body: text });
      });
    });
    sent.on("error", reject);
    sent.end(body);
  });
}
