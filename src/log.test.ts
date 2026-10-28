import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { failedCancelKinds } from "@dmarket/p2p-tracker-headless";

import { Log } from "./log.js";
import { isoInstant } from "./time.js";

const T0 = Date.parse("2026-06-16T12:00:00Z");

/** A fixture file's lines: the library's golden files, copied as they are. */
function fixture(name: string): string[] {
  return readFileSync(join(process.cwd(), "fixtures", name), "utf8").split("\n").filter((line) => line !== "");
}

function logTo(lines: string[], nowMs: () => number = () => T0): Log {
  return new Log((line) => lines.push(line), nowMs);
}

function parsed(line: string | undefined): Record<string, unknown> {
  assert.ok(line !== undefined);
  return JSON.parse(line) as Record<string, unknown>;
}

const ERROR = ["CycleFailed", "LinkedSteamIdMismatch", "MarketplaceServerError", "ReLoginNeeded"];
const WARN = [
  "SteamReadFailed",
  "ProofFailed",
  "DirectiveReportFailed",
  "TradeStatusReportFailed",
  "LinkedSteamIdUnknown",
  "SteamWriteDeferred",
  "CreateUnanswered",
  // The golden directive is a failed one.
  "DirectiveExecuted",
];

test("each event is a line at its level with msg event and the event's own fields", () => {
  const events = fixture("lifecycle-events.golden.jsonl");
  assert.equal(events.length, 21);
  for (const json of events) {
    const lines: string[] = [];
    logTo(lines).event(json);
    const event = parsed(json);
    const name = String(event.event);
    const level = ERROR.includes(name) ? "error" : WARN.includes(name) ? "warn" : "info";
    assert.deepEqual(Object.entries(parsed(lines[0])), [
      ["ts", "2026-06-16T12:00:00Z"],
      ["level", level],
      ["msg", "event"],
      ...Object.entries(event),
    ]);
  }
  for (const name of [...ERROR, ...WARN]) assert.ok(events.some((json) => json.includes(`"event":"${name}"`)), name);
});

test("an executed directive is a warning only when it failed", () => {
  const golden = parsed(fixture("lifecycle-events.golden.jsonl").find((json) => json.includes('"DirectiveExecuted"')));
  assert.equal(golden.status, "FAILED");
  const lines: string[] = [];
  logTo(lines).event(JSON.stringify({ ...golden, status: "SUCCESS", error: null }));
  assert.equal(parsed(lines[0]).level, "info");
});

test("a line is exactly ts, level, msg and the fields in their order", () => {
  const lines: string[] = [];
  const log = logTo(lines);
  log.event('{"event":"HeartbeatSent","ttlSeconds":100,"tracking":2,"directives":1}');
  log.warn("dmarket key refused", { reason: "the key is not hex", publicKey: null });
  log.error("no config");
  assert.deepEqual(lines, [
    '{"ts":"2026-06-16T12:00:00Z","level":"info","msg":"event","event":"HeartbeatSent","ttlSeconds":100,"tracking":2,"directives":1}',
    '{"ts":"2026-06-16T12:00:00Z","level":"warn","msg":"dmarket key refused","reason":"the key is not hex","publicKey":null}',
    '{"ts":"2026-06-16T12:00:00Z","level":"error","msg":"no config"}',
  ]);
});

test("time is written as Kotlin writes an instant: milliseconds only when they are not zero", () => {
  assert.equal(isoInstant(T0), "2026-06-16T12:00:00Z");
  assert.equal(isoInstant(T0 + 500), "2026-06-16T12:00:00.500Z");
  assert.equal(isoInstant(T0 + 1), "2026-06-16T12:00:00.001Z");
  const lines: string[] = [];
  const log = logTo(lines, () => T0 + 500);
  log.info("half a second in");
  assert.equal(parsed(lines[0]).ts, "2026-06-16T12:00:00.500Z");
});

test("a trade after cancel is a warn line naming the deal and the offer", () => {
  const golden = fixture("lifecycle-events.golden.jsonl").find((json) => json.includes('"FailedCancelChecked"'));
  assert.ok(golden !== undefined && golden.includes(`"kind":"${failedCancelKinds().alreadyTraded}"`));
  const lines: string[] = [];
  const log = logTo(lines);
  log.event(golden);
  log.event(
    JSON.stringify({ ...parsed(golden), dealId: "deal-2", steamOfferId: "556", kind: failedCancelKinds().alreadyInactive }),
  );
  assert.deepEqual(
    lines.map((line) => parsed(line).level),
    ["info", "warn", "info"],
  );
  assert.equal(
    lines[1],
    '{"ts":"2026-06-16T12:00:00Z","level":"warn","msg":"offer accepted after cancel","dealId":"deal-1","offerId":"555","offerState":"3"}',
  );
});

test("the prover host's own lines are written with their message, level and fields in order", () => {
  const golden = fixture("prover-host-lines.golden.jsonl");
  assert.equal(golden.length, 6);
  const lines: string[] = [];
  const log = logTo(lines);
  for (const line of golden) log.proverLine("host", line);
  golden.forEach((line, i) => {
    const { msg, level, ...fields } = parsed(line);
    assert.deepEqual(Object.entries(parsed(lines[i])), [
      ["ts", "2026-06-16T12:00:00Z"],
      ["level", level],
      ["msg", msg],
      ...Object.entries(fields),
    ]);
  });
  assert.equal(
    lines[4],
    '{"ts":"2026-06-16T12:00:00Z","level":"warn","msg":"proof failed","dealId":"deal-1","pid":"<pid>","reason":"the prover was killed: still proving at the deadline"}',
  );
  assert.equal(
    lines[5],
    '{"ts":"2026-06-16T12:00:00Z","level":"info","msg":"prover exited","pid":"<pid>","code":null,"signal":"SIGKILL","killedBySdk":"true"}',
  );
});

test("a prover process's output is prover output with its stream, a warning from stderr", () => {
  const lines: string[] = [];
  const log = logTo(lines);
  log.proverLine("stdout", "prover: issuance started");
  log.proverLine("stderr", "panicked at <redacted>");
  assert.deepEqual(lines, [
    '{"ts":"2026-06-16T12:00:00Z","level":"info","msg":"prover output","stream":"stdout","line":"prover: issuance started"}',
    '{"ts":"2026-06-16T12:00:00Z","level":"warn","msg":"prover output","stream":"stderr","line":"panicked at <redacted>"}',
  ]);
});
