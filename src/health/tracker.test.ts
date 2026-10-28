import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { maxClockSkewMs, reasons, type ProofFailure, type TrackerState } from "@dmarket/p2p-tracker-headless";

import { goldenEvent as ev, goldenFailure } from "../test-support/golden.js";
import { isoInstant } from "../time.js";
import type { ProblemCode } from "./problems.js";
import { HealthTracker, type Health, type Problem } from "./tracker.js";

const T0 = Date.parse("2026-06-16T12:00:00Z");
const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const STEAM_ID = "76561198000000001";
const OTHER_STEAM_ID = "76561198000000099";

interface StateOptions {
  hasKey?: boolean;
  /** From T0; `null`: no token held. */
  tokenExpiresIn?: number | null;
  readySince?: number;
  tracked?: string[];
  clockOffset?: number;
  steamNotLinked?: boolean;
  updateRequired?: boolean;
  updateDueTime?: number;
  deadlines?: Record<string, number>;
}

/** What `trackerState()` gives, with a token for 24 hours and the key held unless told otherwise. */
function state(options: StateOptions = {}): TrackerState {
  const expiresIn = options.tokenExpiresIn === undefined ? 24 * HOUR : options.tokenExpiresIn;
  const offset = options.clockOffset ?? null;
  return {
    hasTradingApiKey: options.hasKey ?? true,
    steamTokenSteamId: expiresIn === null ? null : STEAM_ID,
    steamTokenExpiresAtMs: expiresIn === null ? null : T0 + expiresIn,
    linkedSteamId: STEAM_ID,
    readySinceMs: options.readySince ?? null,
    trackedDealIds: options.tracked ?? [],
    clockOffsetMs: offset,
    clockSkewed: offset !== null && Math.abs(offset) > maxClockSkewMs(),
    steamNotLinked: options.steamNotLinked ?? false,
    updateRequired: options.updateRequired ?? false,
    updateDueTimeMs: options.updateDueTime ?? null,
    dealDeadlines: options.deadlines ?? {},
  };
}

/** A health tracker on a clock that starts at T0, its SDK at 0.1.0 and its library at 1.2.3. */
function fresh() {
  const clock = { now: T0 };
  const health = new HealthTracker(() => clock.now, "0.1.0", "1.2.3");
  return {
    clock,
    health,
    advance: (ms: number) => (clock.now += ms),
    event: (json: string) => {
      health.onEvent(json);
    },
    codes: (at: TrackerState = state()): ProblemCode[] => health.snapshot(at).problems.map((it) => it.code),
    single: (at: TrackerState = state()): Problem => {
      const problems = health.snapshot(at).problems;
      assert.equal(problems.length, 1, JSON.stringify(problems));
      return problems[0] as Problem;
    },
  };
}

const deals = (problem: Problem | undefined) => problem?.affectedDeals.map((it) => it.dealId);
const heartbeat = (directives = 0) => ev("HeartbeatSent", { ttlSeconds: 100, tracking: 0, directives });
const cycleStarted = () => ev("CycleStarted");
const cycleCompleted = (watching = 0) =>
  ev("CycleCompleted", { directivesExecuted: 0, reportsSent: 0, proofsSubmitted: 0, watching });
const executed = (kind: string, status: string, dealId: string, error: string | null = null, offer: string | null = null) =>
  ev("DirectiveExecuted", { kind, status, steamOfferId: offer, dealId, error });
const dropped = (kind: string, directiveId: string, reason: string, dealId?: string) =>
  ev("DirectiveDropped", { kind, directiveId, reason, dealId });
const deferred = (kind: string, directiveId: string, reason: string, dealId: string) =>
  ev("SteamWriteDeferred", { kind, directiveId, reason, dealId });
const serverError = (statusCode: number) => ev("MarketplaceServerError", { endpoint: "heartbeat", statusCode });
const cancelChecked = (dealId: string, steamOfferId: string, kind: string, offerState: number) =>
  ev("FailedCancelChecked", { dealId, steamOfferId, kind, offerState });

test("a fresh start reports both missing secrets and is down", () => {
  const { health } = fresh();
  const snapshot = health.snapshot(state({ hasKey: false, tokenExpiresIn: null }));
  assert.deepEqual(
    snapshot.problems.map((it) => it.code),
    ["DMARKET_KEY_MISSING", "STEAM_TOKEN_MISSING"],
  );
  assert.deepEqual(
    snapshot.problems.map((it) => it.severity),
    ["down", "degraded"],
  );
  assert.equal(snapshot.status, "down");
  assert.equal(snapshot.version, "0.1.0");
  assert.equal(snapshot.libraryVersion, "1.2.3");
});

test("status is the worst open severity", () => {
  const { health, event } = fresh();
  event(executed("create_offer", "FAILED", "deal-1", "(26)"));
  assert.equal(health.snapshot(state()).status, "degraded");
  event(ev("ReLoginNeeded", { axis: "marketplace" }));
  const snapshot = health.snapshot(state());
  assert.equal(snapshot.status, "down");
  assert.deepEqual(
    snapshot.problems.map((it) => it.severity),
    ["down", "degraded"],
  );
});

test("a token with less than four hours left or expired degrades", () => {
  const { health } = fresh();
  const expiring = health.snapshot(state({ tokenExpiresIn: 3 * HOUR }));
  assert.deepEqual(
    expiring.problems.map((it) => it.code),
    ["STEAM_TOKEN_EXPIRING"],
  );
  assert.equal(expiring.status, "degraded");
  assert.equal(expiring.steamTokenExpiresAt, isoInstant(T0 + 3 * HOUR));

  const expired = health.snapshot(state({ tokenExpiresIn: -MINUTE }));
  assert.deepEqual(
    expired.problems.map((it) => it.code),
    ["STEAM_TOKEN_EXPIRED"],
  );
  assert.equal(expired.status, "degraded", "the SDK still heartbeats without a usable token");
});

test("an expiring token names the tracked deals and the creates held back for it", () => {
  const { event, single } = fresh();
  event(cycleStarted());
  event(deferred("create_offer", "dir-9", reasons().tokenExpiringDefer, "deal-9"));
  event(cycleCompleted(2));
  const problem = single(state({ tokenExpiresIn: 20 * MINUTE, tracked: ["deal-1", "deal-9"] }));
  assert.equal(problem.code, "STEAM_TOKEN_EXPIRING");
  assert.deepEqual(deals(problem), ["deal-1", "deal-9"]);

  event(cycleStarted());
  event(cycleCompleted());
  const later = single(state({ tokenExpiresIn: 20 * MINUTE }));
  assert.deepEqual(deals(later), [], "a cycle with nothing held back and nothing tracked names no deal");
});

test("an affected deal carries its deadline when the heartbeat gave one", () => {
  const { event, single } = fresh();
  const deadline = T0 + 2 * HOUR;
  event(executed("create_offer", "FAILED", "deal-1", "(26)"));
  event(executed("create_offer", "FAILED", "deal-2", "(26)"));
  const problem = single(state({ deadlines: { "deal-1": deadline } }));
  assert.equal(problem.code, "DIRECTIVE_FAILED");
  assert.deepEqual(problem.affectedDeals, [
    { dealId: "deal-1", deadline: isoInstant(deadline) },
    { dealId: "deal-2", deadline: null },
  ]);
});

test("all clear is ok", () => {
  const snapshot = fresh().health.snapshot(state());
  assert.equal(snapshot.status, "ok");
  assert.deepEqual(snapshot.problems, []);
});

test("a wrong account lasts until a heartbeat comes back without it", () => {
  const { event, codes } = fresh();
  event(heartbeat());
  event(ev("LinkedSteamIdMismatch", { linkedSteamId: OTHER_STEAM_ID, tokenSteamId: STEAM_ID }));
  assert.deepEqual(codes(), ["STEAM_WRONG_ACCOUNT"]);

  event(heartbeat());
  assert.deepEqual(codes(), []);
});

test("a refused push is a wrong account until a token is held", () => {
  const { health, single, codes } = fresh();
  health.steamTokenPushed({ type: "wrongAccount", tokenSteamId: OTHER_STEAM_ID, linkedSteamId: STEAM_ID });
  const problem = single();
  assert.equal(problem.code, "STEAM_WRONG_ACCOUNT");
  assert.ok(problem.message.includes(OTHER_STEAM_ID) && problem.message.includes(STEAM_ID), problem.message);

  health.steamTokenPushed({ type: "held", steamId: STEAM_ID, expiresAtMs: T0 + DAY });
  assert.deepEqual(codes(), []);
});

test("a failed directive names its deal until that deal succeeds", () => {
  const { event, single, codes } = fresh();
  event(executed("create_offer", "FAILED", "deal-1", "Steam create returned HTTP 500: (26)"));
  const problem = single();
  assert.equal(problem.code, "DIRECTIVE_FAILED");
  assert.deepEqual(deals(problem), ["deal-1"]);
  assert.ok(problem.message.includes("(26)"));

  event(executed("create_offer", "NEEDS_CONFIRMATION", "deal-1", null, "555"));
  assert.deepEqual(codes(), []);
});

test("steam read failures are classified and clear on a clean cycle", () => {
  const { event, codes } = fresh();
  const cases: [string, ProblemCode][] = [
    ["HttpStatusException: HTTP 429 on GET https://api.steampowered.com/x", "STEAM_RATE_LIMITED"],
    ["HttpStatusException: HTTP 403 on GET https://api.steampowered.com/x", "STEAM_SESSION_REJECTED"],
    ["IOException: connection reset", "STEAM_UNREACHABLE"],
  ];
  for (const [reason, code] of cases) {
    event(cycleStarted());
    event(ev("SteamReadFailed", { axis: "offer", reason }));
    event(cycleCompleted(1));
    assert.deepEqual(codes(), [code], reason);
  }
  event(cycleStarted());
  event(cycleCompleted(1));
  assert.deepEqual(codes(), []);
});

test("a create held back for the token is not reported as steam throttling", () => {
  const { event, single } = fresh();
  event(cycleStarted());
  event(deferred("create_offer", "dir-1", reasons().tokenExpiringDefer, "deal-1"));
  event(deferred("create_offer", "dir-2", "partner cooling down", "deal-2"));
  const problem = single();
  assert.equal(problem.code, "STEAM_RATE_LIMITED");
  assert.deepEqual(deals(problem), ["deal-2"]);
});

test("a problem keeps the time it was first seen", () => {
  const { event, single, advance } = fresh();
  event(ev("ReLoginNeeded", { axis: "marketplace" }));
  const first = single().since;
  advance(5 * MINUTE);
  event(ev("ReLoginNeeded", { axis: "marketplace" }));
  assert.equal(single().since, first);
  assert.equal(first, "2026-06-16T12:00:00Z");
});

test("the last heartbeat time is reported", () => {
  const { health, event, advance } = fresh();
  advance(2 * MINUTE);
  event(heartbeat());
  assert.equal(health.snapshot(state()).lastHeartbeatAt, isoInstant(T0 + 2 * MINUTE));
});

test("a heartbeat that stops coming back is reported before the loop gives up", () => {
  const { event, codes, advance } = fresh();
  const ready = state({ readySince: T0 });
  advance(4 * MINUTE);
  assert.deepEqual(codes(ready), [], "a first heartbeat may take a moment");
  advance(2 * MINUTE);
  assert.deepEqual(codes(ready), ["DMARKET_UNREACHABLE"]);

  event(heartbeat());
  assert.deepEqual(codes(ready), []);
  advance(6 * MINUTE);
  assert.deepEqual(codes(ready), ["DMARKET_UNREACHABLE"], "nor may a later one stop for long");

  assert.deepEqual(codes(state()), [], "an SDK that may not act owes no heartbeat");
});

test("a failed heartbeat is retried, not reported, until five minutes pass without one", () => {
  const { event, codes, advance } = fresh();
  const ready = state({ readySince: T0 });
  event(heartbeat());
  advance(2 * MINUTE);
  event(serverError(502));
  assert.deepEqual(codes(ready), [], "one 5xx is not down");
  advance(3 * MINUTE + SECOND);
  assert.deepEqual(codes(ready), ["DMARKET_UNREACHABLE"]);
});

test("a skewed clock is reported instead of a refused key", () => {
  const { health, event, codes, advance } = fresh();
  event(ev("ReLoginNeeded", { axis: "marketplace" }));
  assert.deepEqual(codes(state({ clockOffset: 59 * SECOND })), ["DMARKET_AUTH_FAILED"]);

  const snapshot = health.snapshot(state({ clockOffset: -3 * MINUTE, readySince: T0 }));
  assert.deepEqual(
    snapshot.problems.map((it) => it.code),
    ["CLOCK_SKEW"],
  );
  assert.ok(snapshot.problems[0]?.message.includes("180s"), snapshot.problems[0]?.message);
  assert.equal(snapshot.status, "down");
  advance(10 * MINUTE);
  assert.deepEqual(codes(state({ clockOffset: 3 * MINUTE, readySince: T0 })), ["CLOCK_SKEW"], "nor read as unreachable");
});

test("an unlinked account is reported instead of an unreachable dmarket", () => {
  const { health, event, codes, advance } = fresh();
  event(serverError(403));
  const snapshot = health.snapshot(state({ steamNotLinked: true, tracked: ["deal-1"] }));
  assert.deepEqual(
    snapshot.problems.map((it) => it.code),
    ["STEAM_NOT_LINKED"],
  );
  assert.deepEqual(deals(snapshot.problems[0]), ["deal-1"]);
  assert.equal(snapshot.status, "down");
  advance(10 * MINUTE);
  assert.deepEqual(codes(state({ steamNotLinked: true, readySince: T0 })), ["STEAM_NOT_LINKED"]);
});

test("a minimum in force degrades and a scheduled one is only news", () => {
  const { health } = fresh();
  const due: Health = health.snapshot(state({ updateDueTime: T0 + 72 * HOUR }));
  const news = due.problems[0];
  assert.ok(news && due.problems.length === 1);
  assert.equal(news.code, "SDK_UPDATE_DUE");
  assert.equal(news.severity, "info");
  assert.ok(news.message.includes(isoInstant(T0 + 72 * HOUR)), news.message);
  assert.equal(due.status, "ok", "info only is ok");

  const required = health.snapshot(state({ updateRequired: true, updateDueTime: T0 }));
  assert.deepEqual(
    required.problems.map((it) => it.code),
    ["SDK_UPDATE_REQUIRED"],
  );
  assert.equal(required.status, "degraded", "below the minimum the SDK still serves its deals");
});

test("the update problems quote the library's version, which DMarket compares, not the SDK's", () => {
  const { health } = fresh();
  for (const at of [state({ updateDueTime: T0 + HOUR }), state({ updateRequired: true })]) {
    const message = health.snapshot(at).problems[0]?.message ?? "";
    assert.ok(message.includes("1.2.3") && !message.includes("0.1.0"), message);
  }
});

type Fresh = ReturnType<typeof fresh>;

/**
 * Heartbeats every 100 s for `span`, each told whether it carries a cancel DMarket keeps issuing: five attempts in its
 * first five minutes, then one every 30 minutes, each leased for two minutes. `check` follows each.
 */
function heartbeatsOfAReissuedCancel(
  t: Fresh,
  span: number,
  heartbeatOnce: (carried: boolean) => void,
  check: (at: number) => void,
): void {
  const issues = [0, 1, 2, 3, 4].map((it) => it * MINUTE);
  for (let i = 1; i <= 12; i++) issues.push(5 * MINUTE + 30 * MINUTE * i);
  for (let at = 0; at <= span; at += 100 * SECOND) {
    heartbeatOnce(issues.some((it) => at >= it && at < it + 2 * MINUTE));
    check(at);
    t.advance(100 * SECOND);
  }
}

const cancelFailed = (t: Fresh, deal = "deal-1") => {
  t.event(executed("cancel_offer", "FAILED", deal, "HTTP 500"));
};

test("a failed directive of a deal no longer tracked lapses once dmarket stops issuing it", () => {
  const t = fresh();
  cancelFailed(t);
  assert.deepEqual(t.codes(), ["DIRECTIVE_FAILED"]);

  t.advance(35 * MINUTE);
  assert.deepEqual(t.codes(), ["DIRECTIVE_FAILED"], "the next issue may still be on its way");
  t.advance(SECOND);
  assert.deepEqual(t.codes(), [], "35 minutes without an issue: DMarket has given up on it");
});

test("a failed directive of a tracked deal stands until an attempt succeeds", () => {
  const t = fresh();
  cancelFailed(t);
  t.advance(2 * HOUR);
  assert.deepEqual(t.codes(state({ tracked: ["deal-1"] })), ["DIRECTIVE_FAILED"]);

  t.event(executed("cancel_offer", "SUCCESS", "deal-1"));
  assert.deepEqual(t.codes(state({ tracked: ["deal-1"] })), []);
});

test("a failed cancel issued every half hour does not blink out between issues", () => {
  const t = fresh();
  const since = new Set<string>();
  heartbeatsOfAReissuedCancel(
    t,
    3 * HOUR,
    (carried) => {
      t.event(heartbeat(carried ? 1 : 0));
      if (carried) cancelFailed(t);
    },
    (at) => {
      const problem = t.single();
      assert.equal(problem.code, "DIRECTIVE_FAILED", `at ${String(at)}`);
      since.add(problem.since);
    },
  );
  assert.deepEqual([...since], [isoInstant(T0)]);
});

test("any directive leased for the deal keeps its failure", () => {
  const t = fresh();
  cancelFailed(t);
  t.advance(30 * MINUTE);
  t.event(
    ev("DuplicateWriteSuppressed", {
      kind: "cancel_offer",
      dealId: "deal-1",
      directiveId: "dir-2",
      phase: "COMPLETED",
      steamOfferId: "555",
    }),
  );
  t.advance(30 * MINUTE);
  t.event(dropped("create_offer", "dir-3", "refused", "deal-1"));
  t.advance(30 * MINUTE);
  t.event(deferred("create_offer", "dir-4", "partner cooling down", "deal-1"));
  t.advance(30 * MINUTE);
  t.event(ev("CreateUnanswered", { dealId: "deal-1", directiveId: "dir-5" }));
  t.advance(30 * MINUTE);
  t.event(dropped("create_offer", "dir-6", "refused", "deal-2"));
  assert.ok(t.codes().includes("DIRECTIVE_FAILED"), "the last lease was 30 minutes ago");
  t.advance(5 * MINUTE + SECOND);
  assert.ok(!t.codes().includes("DIRECTIVE_FAILED"), "another deal's lease says nothing about this one");
});

test("a cancel whose offer is already inactive clears its failure", () => {
  const t = fresh();
  cancelFailed(t, "deal-1");
  cancelFailed(t, "deal-2");
  for (const kind of ["already_traded", "still_open", "unread"]) t.event(cancelChecked("deal-1", "555", kind, 3));
  const failed = () => t.health.snapshot(state()).problems.find((it) => it.code === "DIRECTIVE_FAILED");
  assert.deepEqual(deals(failed()), ["deal-1", "deal-2"]);

  t.event(cancelChecked("deal-1", "555", "already_inactive", 6));
  assert.deepEqual(deals(failed()), ["deal-2"]);
});

test("a cancelled offer steam shows traded needs a person for a day", () => {
  const t = fresh();
  t.event(cancelChecked("deal-1", "555", "already_traded", 3));
  t.event(cancelChecked("deal-2", "556", "already_inactive", 6));
  const problem = t.single();
  assert.equal(problem.code, "OFFER_ACCEPTED_AFTER_CANCEL");
  assert.equal(problem.severity, "degraded");
  assert.deepEqual(deals(problem), ["deal-1"]);
  assert.ok(problem.message.includes("555") && problem.message.includes("deal-1"), problem.message);

  t.advance(23 * HOUR);
  t.event(cancelChecked("deal-1", "555", "already_traded", 11));
  t.advance(23 * HOUR);
  const tokenHeld = state({ tokenExpiresIn: 7 * DAY });
  assert.deepEqual(t.codes(tokenHeld), ["OFFER_ACCEPTED_AFTER_CANCEL"], "seen again an hour ago");
  t.advance(HOUR + SECOND);
  assert.deepEqual(t.codes(tokenHeld), []);
});

// ---- a proof due with no prover ----

/** The loop's TradeStatusReportDeferred that follows the suppression is not read by health. */
const proofWithoutProver = (t: Fresh, dealId: string, source = "offer") => {
  t.event(ev("ProofSuppressed", { dealId, source, reason: reasons().noProver, retryAfterSeconds: undefined }));
};

test("a proof due with no prover names its deals with their deadlines", () => {
  const t = fresh();
  const deadline = T0 + 18 * HOUR;
  proofWithoutProver(t, "deal-1");
  proofWithoutProver(t, "deal-1", "history");
  proofWithoutProver(t, "deal-2");

  const problem = t.single(state({ tracked: ["deal-1", "deal-2"], deadlines: { "deal-1": deadline } }));
  assert.equal(problem.code, "PROVER_DISABLED");
  assert.equal(problem.severity, "degraded");
  assert.deepEqual(problem.affectedDeals, [
    { dealId: "deal-1", deadline: isoInstant(deadline) },
    { dealId: "deal-2", deadline: null },
  ]);
  assert.ok(problem.message.includes("prover"), problem.message);
});

test("a proof without a prover clears once the report goes or the deal is untracked", () => {
  const t = fresh();
  const both = state({ tracked: ["deal-1", "deal-2"] });
  proofWithoutProver(t, "deal-1");
  proofWithoutProver(t, "deal-2");
  t.event(ev("TradeStatusReported", { dealId: "deal-1", source: "history", steamStatusCode: 2 }));
  assert.deepEqual(deals(t.single(both)), ["deal-1", "deal-2"], "another axis's report says nothing about this one");

  t.event(ev("TradeStatusReported", { dealId: "deal-1", source: "offer", steamStatusCode: 3 }));
  assert.deepEqual(deals(t.single(both)), ["deal-2"]);

  assert.deepEqual(t.codes(state({ tracked: ["deal-1"] })), [], "DMarket no longer tracks deal-2");
  proofWithoutProver(t, "deal-3");
  assert.deepEqual(t.codes(state({ tracked: ["deal-3"] })), ["PROVER_DISABLED"], "an untracked deal does not come back");
});

test("a proof held back for another reason is not a missing prover", () => {
  const t = fresh();
  // The library's other proof skip reasons; it exports only the one for a missing prover.
  const others = [
    "an identical proof for this transition was already refused",
    "the backend already verified a proof for this transition",
    "the demanded fresh proof was refused; its retry window has not elapsed",
    "the prover is parked after repeated proof failures",
    "this cycle's proving budget is spent; the next heartbeat is due",
  ];
  for (const reason of others) t.event(ev("ProofSuppressed", { dealId: "deal-1", source: "offer", reason }));
  assert.deepEqual(t.codes(state({ tracked: ["deal-1"] })), []);
});

// ---- leased writes this SDK does not run ----

const heartbeatWithoutToken = (t: Fresh, ...cancels: string[]) => {
  t.event(cycleStarted());
  t.event(heartbeat(cancels.length));
  for (const deal of cancels) t.event(dropped("cancel_offer", `dir-${deal}`, reasons().steamSessionMissing, deal));
};

/** A heartbeat cycle with a usable token: the loop completes it, running whatever cancel the heartbeat carried. */
const heartbeatWithToken = (t: Fresh) => {
  t.event(cycleStarted());
  t.event(heartbeat());
  t.event(cycleCompleted());
};

const heartbeatWithWritesOff = (t: Fresh, ...cancels: string[]) => {
  t.event(heartbeat(cancels.length));
  for (const deal of cancels) t.event(dropped("cancel_offer", `dir-${deal}`, reasons().offerWritesDisabled, deal));
};

const tokenMissing = () => state({ tokenExpiresIn: null });
const tokenHeld = (t: Fresh) => state({ tokenExpiresIn: t.clock.now - T0 + 24 * HOUR });
const cancelPending = (t: Fresh, at: TrackerState) =>
  t.health.snapshot(at).problems.find((it) => it.code === "STEAM_CANCEL_PENDING");

test("a cancel leased with no usable token is reported by deal", () => {
  const t = fresh();
  heartbeatWithoutToken(t, "deal-1", "deal-2");
  t.event(dropped("create_offer", "dir-3", reasons().steamSessionMissing, "deal-3"));

  const problem = cancelPending(t, state({ tokenExpiresIn: -HOUR }));
  assert.ok(problem);
  assert.equal(problem.severity, "degraded");
  assert.deepEqual(deals(problem), ["deal-1", "deal-2"], "a create held back is not a waiting cancel");
  assert.ok(problem.message.includes("PUT /v1/steam/session"), problem.message);
});

test("a waiting cancel stands through heartbeats that no longer carry it and keeps its since", () => {
  const t = fresh();
  heartbeatWithoutToken(t, "deal-1");
  const first = cancelPending(t, tokenMissing());
  assert.ok(first);
  for (let i = 0; i < 12; i++) {
    t.advance(10 * MINUTE);
    heartbeatWithoutToken(t);
    const problem = cancelPending(t, tokenMissing());
    assert.ok(problem, "neither tracked nor leased, its offer may still be open");
    assert.deepEqual(deals(problem), ["deal-1"]);
    assert.equal(problem.since, first.since);
  }
});

test("a token held before the cancel is issued again changes the message and not the problem", () => {
  const t = fresh();
  heartbeatWithoutToken(t, "deal-1");
  const waiting = cancelPending(t, tokenMissing());
  assert.ok(waiting);

  t.advance(5 * MINUTE);
  heartbeatWithToken(t);
  const held = cancelPending(t, tokenHeld(t));
  assert.ok(held, "a heartbeat with a token runs only the cancels it carries");
  assert.equal(held.since, waiting.since);
  assert.deepEqual(deals(held), ["deal-1"]);
  assert.ok(held.message.includes("issues it again") && !held.message.includes("PUT /v1/steam/session"), held.message);
  assert.ok(!held.message.includes("by hand"), held.message);

  t.advance(30 * MINUTE);
  heartbeatWithToken(t);
  assert.ok(!cancelPending(t, tokenHeld(t))?.message.includes("by hand"), "35 minutes since its issue: still between two");
  t.advance(SECOND);
  const overdue = cancelPending(t, tokenHeld(t));
  assert.ok(overdue);
  assert.ok(overdue.message.includes("35 minutes") && overdue.message.includes("cancelled by hand on Steam"));
  assert.equal(overdue.since, waiting.since);
});

test("a cancel no longer issued is overdue as soon as a token is held", () => {
  const t = fresh();
  heartbeatWithoutToken(t, "deal-1");
  t.advance(2 * HOUR);
  heartbeatWithToken(t);
  const problem = cancelPending(t, tokenHeld(t));
  assert.ok(problem?.message.includes("cancelled by hand on Steam"), problem?.message);
});

test("a cancel issued again with a token clears once it runs whatever steam answers", () => {
  const t = fresh();
  heartbeatWithoutToken(t, "deal-1", "deal-2");
  t.advance(30 * MINUTE);
  t.event(cycleStarted());
  t.event(heartbeat(2));
  t.event(executed("cancel_offer", "SUCCESS", "deal-1"));
  assert.deepEqual(deals(cancelPending(t, tokenHeld(t))), ["deal-2"]);

  t.event(executed("cancel_offer", "FAILED", "deal-2", "Steam cancel refused with EResult 16"));
  t.event(ev("CycleCompleted", { directivesExecuted: 2, reportsSent: 0, proofsSubmitted: 0, watching: 0 }));
  const codes = t.codes(tokenHeld(t));
  assert.ok(!codes.includes("STEAM_CANCEL_PENDING"), `a cancel that ran and failed is DIRECTIVE_FAILED's: ${codes.join()}`);
  assert.ok(codes.includes("DIRECTIVE_FAILED"));
});

test("a waiting cancel lapses fourteen days after its first issue", () => {
  const t = fresh();
  heartbeatWithoutToken(t, "deal-1");
  t.advance(13 * DAY);
  heartbeatWithoutToken(t, "deal-1");
  t.advance(DAY - SECOND);
  assert.ok(cancelPending(t, tokenMissing()), "a later issue does not move the offer's own lapse");
  t.advance(SECOND);
  assert.equal(cancelPending(t, tokenMissing()), undefined, "Steam has let the offer lapse");
  heartbeatWithoutToken(t);
  assert.equal(cancelPending(t, tokenMissing()), undefined, "and once gone it does not come back");
});

test("a cancel issued every half hour does not blink out between issues", () => {
  const t = fresh();
  const since = new Set<string>();
  heartbeatsOfAReissuedCancel(
    t,
    3 * HOUR,
    (carried) => {
      if (carried) heartbeatWithoutToken(t, "deal-1");
      else heartbeatWithoutToken(t);
    },
    (at) => {
      const problem = cancelPending(t, tokenMissing());
      assert.ok(problem, `at ${String(at)}`);
      assert.deepEqual(deals(problem), ["deal-1"], `at ${String(at)}`);
      since.add(problem.since);
    },
  );
  assert.deepEqual([...since], [isoInstant(T0)]);
});

test("a cancel leased to an sdk without steam writes does not blink out between issues", () => {
  const t = fresh();
  const since = new Set<string>();
  heartbeatsOfAReissuedCancel(
    t,
    3 * HOUR,
    (carried) => {
      if (carried) heartbeatWithWritesOff(t, "deal-2");
      else heartbeatWithWritesOff(t);
    },
    (at) => {
      const problem = t.single(tokenHeld(t));
      assert.equal(problem.code, "STEAM_WRITES_DISABLED", `at ${String(at)}`);
      assert.deepEqual(deals(problem), ["deal-2"], `at ${String(at)}`);
      since.add(problem.since);
    },
  );
  assert.deepEqual([...since], [isoInstant(T0)]);
});

test("writes leased to an sdk without steam writes are their own problem until no longer leased", () => {
  const t = fresh();
  const off = reasons().offerWritesDisabled;
  t.event(ev("HeartbeatSent", { ttlSeconds: 100, tracking: 1, directives: 2 }));
  t.event(dropped("create_offer", "dir-1", off, "deal-1"));
  t.event(dropped("cancel_offer", "dir-2", off, "deal-2"));
  t.event(dropped("create_offer", "dir-3", "refused: malformed"));
  const problem = t.single();
  assert.equal(problem.code, "STEAM_WRITES_DISABLED");
  assert.equal(problem.severity, "degraded");
  assert.deepEqual(deals(problem), ["deal-1", "deal-2"]);
  assert.ok(problem.message.includes("steamWrites: false"), problem.message);

  // A create is leased again every heartbeat while its window lasts: it goes a heartbeat after its last lease.
  t.advance(100 * SECOND);
  t.event(ev("HeartbeatSent", { ttlSeconds: 100, tracking: 1, directives: 1 }));
  t.event(dropped("create_offer", "dir-1", off, "deal-1"));
  assert.deepEqual(deals(t.single()), ["deal-1", "deal-2"]);
  t.advance(100 * SECOND);
  t.event(ev("HeartbeatSent", { ttlSeconds: 100, tracking: 1, directives: 0 }));
  assert.deepEqual(deals(t.single()), ["deal-1", "deal-2"]);
  t.advance(100 * SECOND);
  t.event(ev("HeartbeatSent", { ttlSeconds: 100, tracking: 1, directives: 0 }));
  assert.deepEqual(deals(t.single()), ["deal-2"], "a cancel is issued only now and then: it stands until its next issue");

  // A cancel stands until its next issue is overdue: 35 minutes after its last lease.
  t.advance(35 * MINUTE - 300 * SECOND);
  assert.deepEqual(deals(t.single()), ["deal-2"]);
  t.advance(SECOND);
  assert.deepEqual(t.codes(), []);
});

// ---- how a proof's end changes health: the host's classification wins over the loop's generic ProofFailed ----

const proverState = (options: StateOptions = {}) => state({ tracked: ["deal-1"], ...options });

/** The order the two arrive in: the host's outcome, then the loop's event for the thrown failure. */
const proofFailedAfterOutcome = (t: Fresh, dealId: string, failure: ProofFailure) => {
  t.health.proofOutcome({ dealId, failure });
  t.event(proofFailed(dealId, `HostedProofException: ${failure.summary}`));
};
const proofFailed = (dealId: string, reason: string) => ev("ProofFailed", { dealId, source: "offer", reason });
const openProblems = (t: Fresh, at: TrackerState = proverState()) =>
  new Map(t.health.snapshot(at).problems.map((it) => [it.code, it]));

test("each refusal raises its code naming the deal and not proof failed", () => {
  const cases: [ProofFailure, ProblemCode][] = [
    [goldenFailure("upgrade_refused", { status: 503 }), "NOTARY_UNAVAILABLE"],
    [goldenFailure("session_closed", { code: 1013 }), "NOTARY_UNAVAILABLE"],
    [goldenFailure("upgrade_refused", { status: 403 }), "NOTARY_NOT_ADMITTED"],
    [goldenFailure("session_closed", { code: 4029 }), "NOTARY_NOT_ADMITTED"],
    [goldenFailure("prover_killed", { cause: "out_of_memory" }), "PROVER_KILLED"],
    [goldenFailure("version_mismatch"), "SDK_UPDATE_REQUIRED"],
    [goldenFailure("upgrade_refused", { status: 401 }), "DMARKET_AUTH_FAILED"],
    [goldenFailure("session_closed", { code: 4008, reason: null }), "PROOF_FAILED"],
  ];
  for (const [failure, code] of cases) {
    const t = fresh();
    proofFailedAfterOutcome(t, "deal-1", failure);
    const open = openProblems(t);
    assert.deepEqual(deals(open.get(code)), ["deal-1"], JSON.stringify(failure));
    if (code !== "PROOF_FAILED") assert.ok(!open.has("PROOF_FAILED"), JSON.stringify(failure));
  }
});

test("a notary 401 on a skewed clock is clock skew", () => {
  const t = fresh();
  proofFailedAfterOutcome(t, "deal-1", goldenFailure("upgrade_refused", { status: 401 }));
  const skewed = proverState({ clockOffset: 5 * MINUTE });
  const open = openProblems(t, skewed);
  assert.ok(open.has("CLOCK_SKEW"));
  assert.ok(!open.has("DMARKET_AUTH_FAILED"));
  assert.equal(t.health.snapshot(skewed).status, "down");
});

test("a proof that comes back clears the provers problems", () => {
  const t = fresh();
  proofFailedAfterOutcome(t, "deal-1", goldenFailure("upgrade_refused", { status: 503 }));
  proofFailedAfterOutcome(t, "deal-2", goldenFailure("prover_killed", { cause: "session_deadline" }));
  t.health.proofOutcome({ dealId: "deal-1", failure: null });
  const open = openProblems(t);
  assert.ok(!open.has("NOTARY_UNAVAILABLE") && !open.has("PROVER_KILLED"), JSON.stringify([...open.keys()]));
});

test("a proof held back for the token is the tokens problem", () => {
  const t = fresh();
  t.event(cycleStarted());
  t.event(proofFailed("deal-9", `HostedProofException: proof not started: ${reasons().proofTokenExpiring}`));
  const open = openProblems(t, proverState({ tokenExpiresIn: 20 * MINUTE }));
  assert.ok(!open.has("PROOF_FAILED"));
  assert.ok(deals(open.get("STEAM_TOKEN_EXPIRING"))?.includes("deal-9"));
});

test("a delivery failure the host did not see is proof failed", () => {
  const t = fresh();
  t.health.proofOutcome({ dealId: "deal-1", failure: null });
  t.event(proofFailed("deal-1", "MarketplaceServerErrorException: HTTP 502"));
  assert.ok(openProblems(t).has("PROOF_FAILED"));
});

test("a proof the backoff held back changes nothing", () => {
  const t = fresh();
  proofFailedAfterOutcome(t, "deal-1", goldenFailure("upgrade_refused", { status: 503 }));
  proofFailedAfterOutcome(t, "deal-2", goldenFailure("not_started"));
  const open = openProblems(t);
  assert.deepEqual(deals(open.get("NOTARY_UNAVAILABLE")), ["deal-1"]);
  assert.ok(!open.has("PROOF_FAILED"));
});

test("low memory is reported from start", () => {
  const t = fresh();
  const mib = 1024 * 1024;
  t.health.proverMemoryLow(512 * mib, 120 * mib, 768 * mib);
  const problem = openProblems(t).get("PROVER_MEMORY_LOW");
  assert.equal(problem?.severity, "degraded");
  assert.ok(problem.message.includes("512 MiB"), problem.message);
});

// ---- whole snapshots, byte for byte as the Kotlin SDK's HealthTracker wrote them on the same inputs ----

/**
 * `fixtures/health/<name>.json`, written by the Kotlin SDK's `HealthTracker` (version 1.2.3) on these inputs. Edited by
 * hand for what this SDK does on purpose: `version` is the SDK's (0.1.0), `libraryVersion` the library's (1.2.3), and the
 * update problems name the library's version.
 */
function assertMatchesFixture(name: string, snapshot: Health): void {
  const expected = readFileSync(join(process.cwd(), "fixtures", "health", `${name}.json`), "utf8");
  assert.equal(JSON.stringify(snapshot) + "\n", expected);
}

test("an expiring token names its deals with their deadlines as the Kotlin SDK did", () => {
  const t = fresh();
  t.event(cycleStarted());
  t.event(ev("HeartbeatSent", { ttlSeconds: 100, tracking: 2, directives: 1 }));
  t.event(deferred("create_offer", "dir-9", reasons().tokenExpiringDefer, "deal-9"));
  t.event(cycleCompleted(2));
  t.advance(MINUTE);
  const at = state({
    tokenExpiresIn: 20 * MINUTE,
    readySince: T0,
    tracked: ["deal-1", "deal-2"],
    updateDueTime: T0 + 72 * HOUR,
    deadlines: { "deal-1": T0 + 2 * HOUR, "deal-9": T0 + 90 * MINUTE + 500 },
  });
  assertMatchesFixture("token-expiring", t.health.snapshot(at));
});

test("a waiting cancel past its next issue and a failed one read as the Kotlin SDK did", () => {
  const t = fresh();
  heartbeatWithoutToken(t, "deal-1", "deal-2");
  t.health.snapshot(tokenMissing());
  t.advance(5 * MINUTE);
  t.event(cycleStarted());
  t.event(ev("HeartbeatSent", { ttlSeconds: 100, tracking: 1, directives: 1 }));
  t.event(executed("cancel_offer", "FAILED", "deal-3", "Steam cancel refused with EResult 16", "555"));
  t.event(ev("CycleCompleted", { directivesExecuted: 1, reportsSent: 0, proofsSubmitted: 0, watching: 1 }));
  t.advance(30 * MINUTE + SECOND);
  const at = state({ tokenExpiresIn: t.clock.now - T0 + 24 * HOUR, tracked: ["deal-3"] });
  assertMatchesFixture("cancel-pending", t.health.snapshot(at));
});

test("proofs with no prover, a busy notary, a failed delivery and low memory read as the Kotlin SDK did", () => {
  const t = fresh();
  proofWithoutProver(t, "deal-1");
  proofWithoutProver(t, "deal-1", "history");
  proofWithoutProver(t, "deal-2");
  t.event(ev("TradeStatusReported", { dealId: "deal-2", source: "history", steamStatusCode: 2 }));
  const mib = 1024 * 1024;
  t.health.proverMemoryLow(512 * mib, 120 * mib, 768 * mib);
  proofFailedAfterOutcome(t, "deal-4", goldenFailure("upgrade_refused", { status: 503 }));
  t.event(proofFailed("deal-5", "MarketplaceServerErrorException: HTTP 502"));
  t.advance(2 * MINUTE);
  const at = state({
    tokenExpiresIn: 2 * MINUTE + 24 * HOUR,
    tracked: ["deal-1", "deal-2", "deal-4"],
    deadlines: { "deal-1": T0 + 18 * HOUR },
  });
  assertMatchesFixture("prover-disabled", t.health.snapshot(at));
});

test("a skewed clock with a refused key, token and proof is down as the Kotlin SDK was", () => {
  const t = fresh();
  t.event(ev("HeartbeatSent", { ttlSeconds: 100, tracking: 2, directives: 0 }));
  t.event(ev("ReLoginNeeded", { axis: "marketplace" }));
  proofFailedAfterOutcome(
    t,
    "deal-2",
    goldenFailure("upgrade_refused", { status: 401, summary: "the notary refused the upgrade: HTTP 401" }),
  );
  t.health.steamTokenPushed({ type: "wrongAccount", tokenSteamId: OTHER_STEAM_ID, linkedSteamId: STEAM_ID });
  t.health.tradingApiKeyPushed({
    type: "accountChanged",
    publicKey: "new",
    heldPublicKey: "held",
    linkedSteamId: STEAM_ID,
    keyLinkedSteamId: null,
  });
  t.advance(10 * MINUTE);
  const at = state({
    tokenExpiresIn: 10 * MINUTE + 24 * HOUR,
    readySince: T0,
    tracked: ["deal-1", "deal-2"],
    clockOffset: -3 * MINUTE,
    updateRequired: true,
  });
  assertMatchesFixture("clock-skew-down", t.health.snapshot(at));
});
