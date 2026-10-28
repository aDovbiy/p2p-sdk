import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { ProofFailure } from "@dmarket/p2p-tracker-headless";

/**
 * The lines of a fixture file. `fixtures/*.golden.jsonl` are the library's golden files, copied byte for byte from
 * `headless-js/src/jsTest/resources/` of the tracker core repository: a change there is copied here by hand.
 */
export function fixtureLines(name: string): string[] {
  return readFileSync(join(process.cwd(), "fixtures", name), "utf8").split("\n").filter((line) => line !== "");
}

/**
 * The golden line whose `key` is `value`, with `changes` to fields that line has (`undefined` drops one): a key the
 * library renamed fails here rather than passing on a made-up one.
 */
function golden(file: string, key: string, value: string, changes: Readonly<Record<string, unknown>>): object {
  const line = fixtureLines(file)
    .map((it) => JSON.parse(it) as Record<string, unknown>)
    .find((it) => it[key] === value);
  assert.ok(line, `no golden ${value} in ${file}`);
  const changed: Record<string, unknown> = { ...line };
  for (const [field, to] of Object.entries(changes)) {
    assert.ok(field in line, `the golden ${value} has no ${field}`);
    if (to === undefined) Reflect.deleteProperty(changed, field);
    else changed[field] = to;
  }
  return changed;
}

/** One of the tracker's events, as the JSON string `onEvent` gives, from `lifecycle-events.golden.jsonl`. */
export function goldenEvent(name: string, changes: Readonly<Record<string, unknown>> = {}): string {
  return JSON.stringify(golden("lifecycle-events.golden.jsonl", "event", name, changes));
}

/** A proof failure of `type`, as `onProofOutcome` gives it, from `proof-failures.golden.jsonl`. */
export function goldenFailure(
  type: ProofFailure["type"],
  changes: Readonly<Record<string, unknown>> = {},
): ProofFailure {
  return golden("proof-failures.golden.jsonl", "type", type, changes) as ProofFailure;
}
