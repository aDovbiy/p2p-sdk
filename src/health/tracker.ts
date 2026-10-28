import {
  directiveActions,
  failedCancelKinds,
  headlessVersion,
  reasons,
  type ProofFailure,
  type ProofOutcome,
  type SteamTokenPushResult,
  type TradingApiKeyPushResult,
  type TrackerState,
} from "@dmarket/p2p-tracker-headless";

import { isoInstant } from "../time.js";
import { sdkVersion } from "../version.js";
import { PROBLEMS, problemFor, SEVERITY_RANK, type ProblemCode, type Severity } from "./problems.js";

/** A deal a problem holds up, with the time it lapses when the SDK knows it. */
export interface AffectedDeal {
  readonly dealId: string;
  readonly deadline: string | null;
}

export interface Problem {
  readonly code: ProblemCode;
  readonly severity: Severity;
  readonly since: string;
  readonly message: string;
  readonly affectedDeals: readonly AffectedDeal[];
}

/**
 * The answer of `GET /v1/health`. `status` is the worst severity among the open problems: `down`, `degraded`, or `ok`
 * with none or with `info` ones only. `version` is the SDK's; `libraryVersion` is the tracker library's, the one
 * DMarket compares with its minimum. Carries no secret and no part of one.
 */
export interface Health {
  readonly status: "ok" | "degraded" | "down";
  readonly problems: readonly Problem[];
  readonly steamTokenExpiresAt: string | null;
  readonly lastHeartbeatAt: string | null;
  readonly version: string;
  readonly libraryVersion: string;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const MIB = 1024 * 1024;
const FAILED = "FAILED";
const HTTP_STATUS = /HTTP (\d{3})/;
const EXPIRING_WITHIN = 4 * HOUR;
const HEARTBEAT_STALE_AFTER = 5 * MINUTE;
/** Steam lets an unanswered offer lapse after 14 days, and DMarket keeps issuing its cancel as long. */
const CANCEL_OFFER_LIFETIME = 14 * DAY;
/**
 * DMarket re-issues an unfinished cancel about every 30 minutes, and a device sees it at its next heartbeat: past 35
 * minutes an issue is overdue. A failed directive of a deal no longer tracked lapses after as long without a lease.
 */
const CANCEL_REISSUED_WITHIN = 35 * MINUTE;
/** A trade made after its cancel is named for a day; the `warn` log line is its lasting record. */
const ACCEPTED_AFTER_CANCEL_SHOWN = DAY;

type Event = Readonly<Record<string, unknown>>;

/**
 * Turns the tracker's events, push results, proof outcomes and state into `Health`.
 *
 * Event-derived problems last as long as their cause: a heartbeat that round-trips clears the DMarket and account
 * problems, a cycle with no failed Steam read clears the read problem, and a per-deal failure clears when the same
 * deal's next attempt succeeds, when its offer turns out to be gone already, or once DMarket has stopped asking for it.
 * Each open problem keeps the time it was first seen in `since`.
 *
 * State is in memory only. Driven from Node's one event loop, so it needs no lock.
 */
export class HealthTracker {
  private lastHeartbeatAt: number | null = null;
  private dmarketAuthFailed = false;
  /** [linked, token] Steam ids. */
  private wrongAccount: [string | null, string] | null = null;
  private refusedPush: [string | null, string] | null = null;
  /** [linked, the key's linked] Steam ids. */
  private refusedKey: [string, string | null] | null = null;
  private steamRead: [ProblemCode, string] | null = null;
  private readFailedThisCycle = false;
  private readonly throttledDeals = new Set<string>();
  private throttledThisCycle = false;
  private readonly tokenHeldDeals = new Set<string>();
  private tokenHeldThisCycle = false;
  /** Each `cancel_offer` leased while no token was usable and not run since: when it was first and last issued. */
  private readonly cancelsAwaitingToken = new Map<string, { first: number; last: number }>();
  /** The deals `create_offer`s leased while writes are off named in the last two heartbeats. */
  private createsLeasedWhileDisabled = new Set<string>();
  private createsLeasedBefore = new Set<string>();
  /** Each `cancel_offer` leased while writes are off: when a heartbeat last carried it. */
  private readonly cancelsLeasedWhileDisabled = new Map<string, number>();
  /** Each deal whose cancelled offer Steam shows traded: the offer id and when it was last seen so. */
  private readonly acceptedAfterCancel = new Map<string, [string, number]>();
  /** Each deal's last failed directive: what failed, and when a directive was last leased for the deal. */
  private readonly directiveFailures = new Map<string, { message: string; leasedAt: number }>();
  private readonly proofFailures = new Map<string, string>();
  /** Each decisive transition whose proof is due with no prover, keyed by deal and axis: the deal. */
  private readonly proofsWithoutProver = new Map<string, string>();
  private readonly proverFailures = new Map<string, ProofFailure>();
  private readonly classifiedProofs = new Set<string>();
  private proverMemory: string | null = null;
  private readonly since = new Map<ProblemCode, number>();

  constructor(
    private readonly nowMs: () => number = Date.now,
    private readonly version: string = sdkVersion(),
    private readonly libraryVersion: string = headlessVersion(),
  ) {}

  /** One of the tracker's events, the JSON string `onEvent` gives. */
  onEvent(json: string): void {
    const event = JSON.parse(json) as Event;
    const now = this.nowMs();
    const deal = text(event.dealId);
    if (deal !== null && LEASING_EVENTS.has(String(event.event))) {
      const failure = this.directiveFailures.get(deal);
      if (failure) failure.leasedAt = now;
    }
    switch (event.event) {
      case "CycleStarted":
        this.readFailedThisCycle = false;
        this.throttledThisCycle = false;
        this.tokenHeldThisCycle = false;
        break;
      case "HeartbeatSent":
        this.lastHeartbeatAt = now;
        this.dmarketAuthFailed = false;
        this.wrongAccount = null;
        this.createsLeasedBefore = this.createsLeasedWhileDisabled;
        this.createsLeasedWhileDisabled = new Set();
        break;
      case "DirectiveDropped": {
        if (deal === null) break;
        const cancel = event.kind === directiveActions().cancelOffer;
        if (event.reason === reasons().offerWritesDisabled) {
          if (cancel) this.cancelsLeasedWhileDisabled.set(deal, now);
          else this.createsLeasedWhileDisabled.add(deal);
        } else if (event.reason === reasons().steamSessionMissing && cancel) {
          this.cancelsAwaitingToken.set(deal, { first: this.cancelsAwaitingToken.get(deal)?.first ?? now, last: now });
        }
        break;
      }
      case "ReLoginNeeded":
        if (event.axis === "marketplace") this.dmarketAuthFailed = true;
        break;
      case "LinkedSteamIdMismatch":
        this.wrongAccount = [text(event.linkedSteamId), String(event.tokenSteamId)];
        break;
      case "SteamReadFailed": {
        const reason = text(event.reason);
        this.readFailedThisCycle = true;
        this.steamRead = [classifyRead(reason), `Steam ${String(event.axis)} read failed: ${reason ?? "no detail"}`];
        break;
      }
      // A create held back for the token's sake is STEAM_TOKEN_EXPIRING's story, not Steam's.
      case "SteamWriteDeferred":
        if (deal === null) break;
        if (event.reason === reasons().tokenExpiringDefer) {
          this.tokenHeldThisCycle = true;
          this.tokenHeldDeals.add(deal);
        } else {
          this.throttledThisCycle = true;
          this.throttledDeals.add(deal);
        }
        break;
      case "CycleCompleted":
        if (!this.readFailedThisCycle) this.steamRead = null;
        if (!this.throttledThisCycle) this.throttledDeals.clear();
        if (!this.tokenHeldThisCycle) this.tokenHeldDeals.clear();
        break;
      case "DirectiveExecuted":
        if (deal === null) break;
        // The cancel ran, however it ended: a failure is DIRECTIVE_FAILED's from here on.
        if (event.kind === directiveActions().cancelOffer) this.cancelsAwaitingToken.delete(deal);
        if (event.status === FAILED) {
          const message = `${String(event.kind)} failed: ${text(event.error) ?? "no detail"}`;
          this.directiveFailures.set(deal, { message, leasedAt: now });
        } else {
          this.directiveFailures.delete(deal);
        }
        break;
      // An offer gone already is what the cancel was for: nothing is left to fix, whatever the cancel reported.
      case "FailedCancelChecked":
        if (deal === null) break;
        if (event.kind === failedCancelKinds().alreadyInactive) this.directiveFailures.delete(deal);
        if (event.kind === failedCancelKinds().alreadyTraded) {
          this.acceptedAfterCancel.set(deal, [String(event.steamOfferId), now]);
        }
        break;
      case "ProofFailed": {
        if (deal === null) break;
        const reason = text(event.reason);
        // The prover's host already said how it ended (proofOutcome).
        if (this.classifiedProofs.delete(deal)) break;
        // Held back for the token's sake: STEAM_TOKEN_EXPIRING's story, like a held create.
        if (reason?.includes(reasons().proofTokenExpiring)) {
          this.tokenHeldThisCycle = true;
          this.tokenHeldDeals.add(deal);
        } else {
          this.proofFailures.set(deal, `proof failed: ${reason ?? "no detail"}`);
        }
        break;
      }
      case "ProofSubmitted":
        if (deal !== null && event.verified === true) this.proofFailures.delete(deal);
        break;
      case "ProofSuppressed":
        if (deal !== null && event.reason === reasons().noProver) {
          this.proofsWithoutProver.set(axisKey(deal, event.source), deal);
        }
        break;
      // The axis's report went: the proof it waited for is no longer due.
      case "TradeStatusReported":
        if (deal !== null) this.proofsWithoutProver.delete(axisKey(deal, event.source));
        break;
    }
  }

  /**
   * How a proof the prover's host ran ended; it comes before the tracker's `ProofFailed` event and wins over it. A
   * proof made clears the notary's and the prover's problems; one held back without a prover changes nothing.
   */
  proofOutcome({ dealId, failure }: ProofOutcome): void {
    if (failure === null) {
      this.proverFailures.clear();
      this.proofFailures.delete(dealId);
      return;
    }
    this.classifiedProofs.add(dealId);
    const code = problemFor(failure);
    // The library gives every text in a failure redacted already.
    if (code === "PROOF_FAILED") this.proofFailures.set(dealId, `proof failed: ${failure.summary}`);
    else if (code !== null) this.proverFailures.set(dealId, failure);
  }

  /** At start: the memory limit leaves less than one proof's peak beside what the SDK uses. */
  proverMemoryLow(limitBytes: number, usedBytes: number, peakBytes: number): void {
    const mib = (bytes: number) => String(Math.floor(bytes / MIB));
    this.proverMemory =
      `the memory limit is ${mib(limitBytes)} MiB and the SDK uses ${mib(usedBytes)} MiB: ` +
      `one proof needs up to ${mib(peakBytes)} MiB beside it`;
  }

  /** A Steam token push: one for another account is a wrong account until a token is held. */
  steamTokenPushed(result: SteamTokenPushResult): void {
    if (result.type === "held") this.refusedPush = null;
    if (result.type === "wrongAccount") this.refusedPush = [result.linkedSteamId, result.tokenSteamId];
  }

  /** A Trading API key push: one for another account is named until a key is held. */
  tradingApiKeyPushed(result: TradingApiKeyPushResult): void {
    if (result.type === "held") this.refusedKey = null;
    if (result.type === "accountChanged") this.refusedKey = [result.linkedSteamId, result.keyLinkedSteamId];
  }

  /**
   * The health right now, given what the tracker holds. A problem that stops the SDK acting for every deal names
   * every deal the last heartbeat tracked. While the tracker is ready to act, a heartbeat that has not come back for
   * five minutes is reported: the loop itself only speaks up after several failures in a row.
   */
  snapshot(state: TrackerState): Health {
    const now = this.nowMs();
    const tracked = state.trackedDealIds;
    const expiresAt = state.steamTokenExpiresAtMs;
    const open = new Map<ProblemCode, { message: string; deals: readonly string[] }>();
    const raise = (code: ProblemCode, message: string, deals: Iterable<string> = []) => {
      open.set(code, { message, deals: [...deals] });
    };

    if (!state.hasTradingApiKey) raise("DMARKET_KEY_MISSING", "push the Trading API key: PUT /v1/dmarket/key", tracked);
    if (this.refusedKey) {
      const [linked, theirs] = this.refusedKey;
      const named = theirs === null ? "links no Steam account" : `links ${theirs}`;
      raise(
        "DMARKET_KEY_ACCOUNT_CHANGED",
        `a key for another account was refused: its account ${named}, not ${linked}; switching accounts takes a restart`,
      );
    }
    // A skewed clock is why every signature is refused: the key itself may be fine, so it is not blamed.
    if (state.clockSkewed && state.clockOffsetMs !== null) {
      const seconds = Math.floor(Math.abs(state.clockOffsetMs) / 1000);
      raise("CLOCK_SKEW", `this host's clock is ${String(seconds)}s off DMarket's: sync it`, tracked);
    }
    if (this.dmarketAuthFailed && !state.clockSkewed) {
      raise("DMARKET_AUTH_FAILED", "DMarket refused the Trading API key", tracked);
    }
    // A heartbeat refused for the account's missing Steam link is answered: DMarket is reachable.
    if (state.steamNotLinked) {
      raise("STEAM_NOT_LINKED", "the DMarket account has no Steam account linked: link one on DMarket", tracked);
    } else {
      // One failed call is retried at the next wake: only five minutes without an answered heartbeat is down.
      const ready = state.readySinceMs;
      const last = ready === null ? null : Math.max(ready, this.lastHeartbeatAt ?? ready);
      const explained = this.dmarketAuthFailed || state.clockSkewed;
      if (last !== null && !explained && now - last > HEARTBEAT_STALE_AFTER) {
        raise("DMARKET_UNREACHABLE", `no heartbeat has come back since ${isoInstant(last)}`, tracked);
      }
    }
    if (expiresAt === null) {
      raise("STEAM_TOKEN_MISSING", "push a Steam access token: PUT /v1/steam/session", tracked);
    } else if (expiresAt <= now) {
      raise("STEAM_TOKEN_EXPIRED", `the Steam token expired at ${isoInstant(expiresAt)}`, tracked);
    } else if (expiresAt - now < EXPIRING_WITHIN) {
      // Every tracked deal loses its Steam side when the token lapses; the creates already held back for it are named
      // even when their deal has left the tracking list.
      raise("STEAM_TOKEN_EXPIRING", `the Steam token expires at ${isoInstant(expiresAt)}`, [
        ...tracked,
        ...this.tokenHeldDeals,
      ]);
    }
    const wrong = this.wrongAccount ?? this.refusedPush;
    if (wrong) {
      const [linked, token] = wrong;
      const named = linked === null ? "DMarket has not named the linked account yet" : `DMarket links ${linked}`;
      raise("STEAM_WRONG_ACCOUNT", `the Steam token is for ${token}; ${named}`, tracked);
    }
    // DMarket compares its minimum with the library's version. Below it the SDK still finishes its deals: degraded,
    // not down. A scheduled minimum is only news.
    const library = `this SDK's library version (${this.libraryVersion})`;
    if (state.updateRequired) {
      raise("SDK_UPDATE_REQUIRED", `${library} is below DMarket's minimum: update the SDK`);
    } else if (state.updateDueTimeMs !== null) {
      const at = isoInstant(state.updateDueTimeMs);
      raise("SDK_UPDATE_DUE", `DMarket's minimum version moves above ${library} at ${at}: update the SDK before then`);
    }
    if (this.steamRead) raise(...this.steamRead);
    if (this.throttledDeals.size > 0) {
      raise("STEAM_RATE_LIMITED", "Steam offer creation is cooling down", this.throttledDeals);
    }
    this.raiseDealProblems(state, now, open, raise);
    return this.health(state, now, open);
  }

  private raiseDealProblems(state: TrackerState, now: number, open: OpenProblems, raise: Raise): void {
    const expiresAt = state.steamTokenExpiresAtMs;
    // A waiting cancel stands until it runs, though its deal has usually left the tracking list and DMarket issues the
    // cancel only now and then: the offer may be open all that while. A token pushed meanwhile runs it at its next issue.
    deleteWhere(this.cancelsAwaitingToken, (issues) => now - issues.first >= CANCEL_OFFER_LIFETIME);
    if (this.cancelsAwaitingToken.size > 0) {
      const heldBack =
        "DMarket asks to cancel a Steam offer: with a usable Steam token held, it runs when DMarket issues it again";
      const overdue = [...this.cancelsAwaitingToken.values()].some((it) => now - it.last > CANCEL_REISSUED_WITHIN);
      const message =
        expiresAt === null || expiresAt <= now
          ? "DMarket asks to cancel a Steam offer and there is no usable Steam token: the offer stays open until one " +
            "is pushed (PUT /v1/steam/session)"
          : overdue
            ? `${heldBack}, which it has not for over ${String(CANCEL_REISSUED_WITHIN / MINUTE)} minutes: the offer ` +
              "can be cancelled by hand on Steam"
            : heldBack;
      raise("STEAM_CANCEL_PENDING", message, this.cancelsAwaitingToken.keys());
    }
    // A create is leased again every heartbeat while its window lasts; a cancel only now and then, so it stands until
    // its next issue is due rather than blinking out in between.
    deleteWhere(this.cancelsLeasedWhileDisabled, (leasedAt) => now - leasedAt > CANCEL_REISSUED_WITHIN);
    const writesNotRun = [
      ...this.createsLeasedBefore,
      ...this.createsLeasedWhileDisabled,
      ...this.cancelsLeasedWhileDisabled.keys(),
    ];
    if (writesNotRun.length > 0) {
      raise(
        "STEAM_WRITES_DISABLED",
        "DMarket leases Steam offer writes to this SDK, which runs with steamWrites: false; they lapse to another device",
        writesNotRun,
      );
    }
    deleteWhere(this.acceptedAfterCancel, ([, seen]) => now - seen > ACCEPTED_AFTER_CANCEL_SHOWN);
    const lastAccepted = [...this.acceptedAfterCancel].at(-1);
    if (lastAccepted) {
      const [deal, [offer]] = lastAccepted;
      raise(
        "OFFER_ACCEPTED_AFTER_CANCEL",
        `DMarket asked to cancel the Steam offer ${offer} of deal ${deal}, and Steam shows it accepted: the trade ` +
          "went through after the deal was cancelled, and a person has to look at it",
        this.acceptedAfterCancel.keys(),
      );
    }
    const firstProofFailure = this.proofFailures.values().next();
    if (!firstProofFailure.done) raise("PROOF_FAILED", firstProofFailure.value, this.proofFailures.keys());
    // A refused proof can name a problem a heartbeat already raised (a refused key, a skewed clock): its deals join.
    const byCode = new Map<ProblemCode, [string, ProofFailure][]>();
    for (const entry of this.proverFailures) {
      const code = problemFor(entry[1], state.clockSkewed);
      if (code !== null) byCode.set(code, [...(byCode.get(code) ?? []), entry]);
    }
    for (const [code, entries] of byCode) {
      const deals = entries.map(([deal]) => deal);
      const held = open.get(code);
      const last = entries.at(-1);
      if (held) open.set(code, { message: held.message, deals: [...held.deals, ...deals] });
      else if (last) raise(code, `proof: ${last[1].summary}`, deals);
    }
    if (this.proverMemory !== null) raise("PROVER_MEMORY_LOW", this.proverMemory);
    // A deal DMarket no longer tracks owes no proof.
    deleteWhere(this.proofsWithoutProver, (deal) => !state.trackedDealIds.includes(deal));
    if (this.proofsWithoutProver.size > 0) {
      raise(
        "PROVER_DISABLED",
        "DMarket requires a proof for these deals and this SDK has no prover (prover.enabled is false, or its files " +
          "were not found): they do not advance until the prover is enabled, or DMarket stops requiring the proof",
        this.proofsWithoutProver.values(),
      );
    }
    // A deal DMarket still tracks keeps its failure until an attempt succeeds. One it no longer tracks keeps it while
    // its directives are still issued: a create every heartbeat, a cancel about every 30 minutes. Past that DMarket has
    // given up on it, and so does the problem.
    for (const [deal, failure] of this.directiveFailures) {
      if (!state.trackedDealIds.includes(deal) && now - failure.leasedAt > CANCEL_REISSUED_WITHIN) {
        this.directiveFailures.delete(deal);
      }
    }
    const firstDirectiveFailure = this.directiveFailures.values().next();
    if (!firstDirectiveFailure.done) {
      raise("DIRECTIVE_FAILED", firstDirectiveFailure.value.message, this.directiveFailures.keys());
    }
  }

  private health(state: TrackerState, now: number, open: OpenProblems): Health {
    for (const code of this.since.keys()) if (!open.has(code)) this.since.delete(code);
    const problems = [...open].map(([code, { message, deals }]): Problem => {
      const first = this.since.get(code) ?? now;
      this.since.set(code, first);
      const deadline = (deal: string) => {
        const at = Object.hasOwn(state.dealDeadlines, deal) ? state.dealDeadlines[deal] : undefined;
        return at === undefined ? null : isoInstant(at);
      };
      return {
        code,
        severity: PROBLEMS[code],
        since: isoInstant(first),
        message,
        affectedDeals: [...new Set(deals)].map((dealId) => ({ dealId, deadline: deadline(dealId) })),
      };
    });
    const worst = Math.max(SEVERITY_RANK.info, ...problems.map((it) => SEVERITY_RANK[it.severity]));
    const status = worst === SEVERITY_RANK.down ? "down" : worst === SEVERITY_RANK.degraded ? "degraded" : "ok";
    const expiresAt = state.steamTokenExpiresAtMs;
    return {
      status,
      problems,
      steamTokenExpiresAt: expiresAt === null ? null : isoInstant(expiresAt),
      lastHeartbeatAt: this.lastHeartbeatAt === null ? null : isoInstant(this.lastHeartbeatAt),
      version: this.version,
      libraryVersion: this.libraryVersion,
    };
  }
}

type OpenProblems = Map<ProblemCode, { message: string; deals: readonly string[] }>;
type Raise = (code: ProblemCode, message: string, deals?: Iterable<string>) => void;

function deleteWhere<K, V>(map: Map<K, V>, test: (value: V) => boolean): void {
  for (const [key, value] of map) if (test(value)) map.delete(key);
}

/** The events that show a directive leased for their deal, run or not. */
const LEASING_EVENTS: ReadonlySet<string> = new Set([
  "DirectiveExecuted",
  "DirectiveDropped",
  "SteamWriteDeferred",
  "DuplicateWriteSuppressed",
  "CreateUnanswered",
]);

function text(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function axisKey(deal: string, source: unknown): string {
  return JSON.stringify([deal, source]);
}

function classifyRead(reason: string | null): ProblemCode {
  switch (HTTP_STATUS.exec(reason ?? "")?.[1]) {
    case "401":
    case "403":
      return "STEAM_SESSION_REJECTED";
    case "429":
      return "STEAM_RATE_LIMITED";
    default:
      return "STEAM_UNREACHABLE";
  }
}
