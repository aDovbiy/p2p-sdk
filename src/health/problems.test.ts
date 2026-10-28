import assert from "node:assert/strict";
import { test } from "node:test";

import type { ProofFailure } from "@dmarket/p2p-tracker-headless";

import { goldenFailure } from "../test-support/golden.js";
import { PROBLEMS, problemFor, type ProblemCode } from "./problems.js";

test("down is only what stops the heartbeat and info is only a scheduled update", () => {
  const codes = (severity: string) => Object.entries(PROBLEMS).filter(([, it]) => it === severity).map(([code]) => code);
  assert.deepEqual(
    new Set(codes("down")),
    new Set(["DMARKET_KEY_MISSING", "DMARKET_AUTH_FAILED", "CLOCK_SKEW", "DMARKET_UNREACHABLE", "STEAM_NOT_LINKED"]),
  );
  assert.deepEqual(codes("info"), ["SDK_UPDATE_DUE"]);
  assert.equal(PROBLEMS.SDK_UPDATE_REQUIRED, "degraded", "below the minimum the SDK still serves its deals");
});

test("each failure raises its problem", () => {
  const table: [ProofFailure, ProblemCode | null][] = [
    [goldenFailure("upgrade_refused", { status: 401 }), "DMARKET_AUTH_FAILED"],
    [goldenFailure("upgrade_refused", { status: 503 }), "NOTARY_UNAVAILABLE"],
    [goldenFailure("upgrade_refused", { status: 502 }), "NOTARY_UNAVAILABLE"],
    [goldenFailure("session_closed", { code: 1013, reason: "queue full" }), "NOTARY_UNAVAILABLE"],
    [goldenFailure("notary_unreachable", { detail: "ECONNREFUSED" }), "NOTARY_UNAVAILABLE"],
    // Sent only by the deferred admission gate: mapped now, so its return needs no SDK release.
    [goldenFailure("upgrade_refused", { status: 403 }), "NOTARY_NOT_ADMITTED"],
    [goldenFailure("session_closed", { code: 4029 }), "NOTARY_NOT_ADMITTED"],
    [goldenFailure("session_closed", { code: 4008, reason: null }), "PROOF_FAILED"],
    [goldenFailure("version_mismatch"), "SDK_UPDATE_REQUIRED"],
    [goldenFailure("steam_failed", { status: 401 }), "STEAM_SESSION_REJECTED"],
    [goldenFailure("steam_failed", { status: 429 }), "STEAM_RATE_LIMITED"],
    [goldenFailure("steam_failed", { status: null, detail: "ECONNRESET" }), "STEAM_UNREACHABLE"],
    [goldenFailure("limits_exceeded"), "PROOF_FAILED"],
    [goldenFailure("prover_killed", { cause: "out_of_memory" }), "PROVER_KILLED"],
    [goldenFailure("prover_killed", { cause: "session_deadline" }), "PROVER_KILLED"],
    [goldenFailure("other", { detail: "context mux error" }), "PROOF_FAILED"],
    [goldenFailure("upgrade_refused", { status: 400 }), "PROOF_FAILED"],
    [goldenFailure("not_started", { reason: "backoff" }), null],
  ];
  for (const [failure, code] of table) assert.equal(problemFor(failure), code, JSON.stringify(failure));
});

test("a notary 401 on a skewed clock is the clock", () => {
  assert.equal(problemFor(goldenFailure("upgrade_refused", { status: 401 }), true), "CLOCK_SKEW");
});
