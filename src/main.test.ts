import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { headlessVersion } from "@dmarket/p2p-tracker-headless";

import { DmarketStub } from "./test-support/dmarket-stub.js";
import { sdkVersion } from "./version.js";

const MAIN = fileURLToPath(new URL("./main.js", import.meta.url));
const SECRET = "p".repeat(16) + "-management-secret-" + "q".repeat(16);

type Line = Readonly<Record<string, unknown>>;

/** `node main.js …args`, without `DMARKET_SDK_CONFIG` from this process's environment. */
function sdk(...args: string[]) {
  const env = { ...process.env };
  delete env.DMARKET_SDK_CONFIG;
  const child = spawn(process.execPath, [MAIN, ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
  const output = { stdout: "", stderr: "" };
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => (output.stdout += chunk));
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => (output.stderr += chunk));
  const exit = once(child, "exit") as Promise<[number | null, NodeJS.Signals | null]>;
  const lines = (): Line[] =>
    output.stdout
      .split("\n")
      .filter((it) => it !== "")
      .map((it) => JSON.parse(it) as Line);
  return {
    child,
    output,
    exit,
    lines,
    /** The first log line with `msg`, once the process has written it. */
    async line(msg: string, timeoutMs = 15_000): Promise<Line> {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const found = lines().find((it) => it.msg === msg);
        if (found !== undefined) return found;
        if (child.exitCode !== null || Date.now() > deadline) {
          throw new Error(`no "${msg}" line: ${output.stdout}${output.stderr}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    },
  };
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  await new Promise((resolve) => server.close(resolve));
  if (typeof address !== "object" || address === null) throw new Error("no port");
  return address.port;
}

/** A data directory, a config file for it with `config` on top, and a DMarket stub, all removed after `run`. */
async function withConfig(
  config: Record<string, unknown>,
  run: (path: string, port: number) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "p2p-sdk-main-"));
  const stub = await DmarketStub.start();
  try {
    const port = await freePort();
    const path = join(dir, "config.json");
    await writeFile(
      path,
      JSON.stringify({
        managementSecret: SECRET,
        dataDir: join(dir, "data"),
        listenPort: port,
        dmarketBaseUrl: stub.baseUrl,
        ...config,
      }),
    );
    await run(path, port);
  } finally {
    await stub.close();
    await rm(dir, { recursive: true, force: true });
  }
}

test("the process serves health once started and exits 0 on SIGTERM", () =>
  withConfig({}, async (path, port) => {
    const p = sdk(path);
    try {
      const started = await p.line("sdk started");
      assert.deepEqual(
        { version: started.version, libraryVersion: started.libraryVersion, listen: started.listen },
        { version: sdkVersion(), libraryVersion: headlessVersion(), listen: `127.0.0.1:${String(port)}` },
      );
      assert.ok(!p.lines().some((it) => it.msg === "prover files not found: no proofs will be made"));

      const response = await fetch(`http://127.0.0.1:${String(port)}/v1/health`, {
        headers: { authorization: `Bearer ${SECRET}` },
      });
      assert.equal(response.status, 503);
      const health = (await response.json()) as { problems: { code: string }[] };
      assert.ok(health.problems.some((it) => it.code === "DMARKET_KEY_MISSING"), JSON.stringify(health));

      const stopping = Date.now();
      p.child.kill("SIGTERM");
      assert.deepEqual(await p.exit, [0, null]);
      assert.ok(Date.now() - stopping < 5_000, `stopped in ${String(Date.now() - stopping)} ms`);
      assert.ok(p.lines().some((it) => it.msg === "sdk stopping"));
      assert.ok(!(p.output.stdout + p.output.stderr).includes(SECRET));
    } finally {
      p.child.kill("SIGKILL");
    }
  }));

test("without its prover files the process starts with no prover", async () => {
  const assetsDir = await mkdtemp(join(tmpdir(), "p2p-sdk-no-prover-"));
  try {
    await withConfig({ prover: { assetsDir } }, async (path) => {
      const p = sdk(path);
      try {
        const missing = await p.line("prover files not found: no proofs will be made");
        assert.equal(missing.level, "error");
        assert.equal(missing.assetsDir, assetsDir);
        await p.line("sdk started");
        p.child.kill("SIGINT");
        assert.deepEqual(await p.exit, [0, null]);
      } finally {
        p.child.kill("SIGKILL");
      }
    });
  } finally {
    await rm(assetsDir, { recursive: true, force: true });
  }
});

test("without a config the process exits 2", async () => {
  const p = sdk();
  assert.deepEqual(await p.exit, [2, null]);
  assert.deepEqual(
    p.lines().map((it) => [it.level, it.msg]),
    [["error", "no config: pass its path as the first argument or in DMARKET_SDK_CONFIG"]],
  );
});

test("a config it cannot use exits 2 and never prints the secret", async () => {
  const dir = await mkdtemp(join(tmpdir(), "p2p-sdk-bad-config-"));
  try {
    const cases: [string, string | null, string | null][] = [
      ["truncated.json", `{"managementSecret":"${SECRET}","dataDir":`, "config is not valid JSON"],
      ["short.json", `{"managementSecret":"${SECRET.slice(0, 20)}","dataDir":"/data"}`, null],
      ["typed.json", `{"managementSecret":"${SECRET}","dataDir":"/data","listenPort":"${SECRET}"}`, null],
      ["missing.json", null, null],
    ];
    for (const [name, text, reason] of cases) {
      const path = join(dir, name);
      if (text !== null) await writeFile(path, text);
      const p = sdk(path);
      assert.deepEqual(await p.exit, [2, null], name);
      const [line, ...rest] = p.lines();
      assert.ok(line !== undefined && rest.length === 0, name);
      assert.equal(line.level, "error", name);
      assert.equal(line.path, path, name);
      assert.equal(line.msg, text === null ? "config file cannot be read" : "config is invalid", name);
      if (reason !== null) assert.equal(line.reason, reason, name);
      const printed = p.output.stdout + p.output.stderr;
      for (const secret of [SECRET, SECRET.slice(0, 20)]) assert.ok(!printed.includes(secret), `${name}: ${printed}`);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
