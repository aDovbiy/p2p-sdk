import type { ProofFailure } from "@dmarket/p2p-tracker-headless";

/**
 * How much a problem stops: `info`, nothing blocked yet; `degraded`, the SDK heartbeats but some or all Steam work or
 * proofs are blocked; `down`, the SDK cannot heartbeat as the account, so DMarket counts it absent.
 */
export type Severity = "info" | "degraded" | "down";

/** Orders severities, worst last. */
export const SEVERITY_RANK: Readonly<Record<Severity, number>> = { info: 0, degraded: 1, down: 2 };

/**
 * The closed vocabulary the SDK reports problems in, on `GET /v1/health` and in the logs and nowhere else: no problem
 * code travels to DMarket. Each code with its severity.
 */
export const PROBLEMS = {
  /** No Trading API key pushed since start: the SDK does not heartbeat. */
  DMARKET_KEY_MISSING: "down",
  /** A pushed key signs for another DMarket account and was refused; the held key still serves its own. */
  DMARKET_KEY_ACCOUNT_CHANGED: "degraded",
  /** DMarket refused the pushed key (invalid, revoked or banned). */
  DMARKET_AUTH_FAILED: "down",
  /** The host's clock is off DMarket's by more than a minute: past the signing window every signed call is refused. */
  CLOCK_SKEW: "down",
  /** No heartbeat has come back for five minutes: a network error, a timeout or a server error. */
  DMARKET_UNREACHABLE: "down",
  /** The DMarket account has no Steam account linked: link one on DMarket. */
  STEAM_NOT_LINKED: "down",
  /** No Steam token pushed since start. */
  STEAM_TOKEN_MISSING: "degraded",
  /** The held Steam token has expired: push a fresh one. */
  STEAM_TOKEN_EXPIRED: "degraded",
  /** Less than four hours left on the held Steam token; under thirty minutes no create is started. */
  STEAM_TOKEN_EXPIRING: "degraded",
  /** The Steam account of the token is not the one DMarket links to this key's account. */
  STEAM_WRONG_ACCOUNT: "degraded",
  /** Steam refused the session (revoked, or logged out elsewhere). */
  STEAM_SESSION_REJECTED: "degraded",
  /** Steam is throttling reads or offer creation. */
  STEAM_RATE_LIMITED: "degraded",
  /** Steam could not be read. */
  STEAM_UNREACHABLE: "degraded",
  /** The library is below DMarket's minimum version. The SDK still finishes the deals it has. */
  SDK_UPDATE_REQUIRED: "degraded",
  /** DMarket has scheduled a minimum version the library is below. */
  SDK_UPDATE_DUE: "info",
  /** The notary cannot be reached, or is busy (a 503 before the upgrade, a close 1013 after it): proofs back off. */
  NOTARY_UNAVAILABLE: "degraded",
  /** The notary did not admit the session (a 403, or a close 4029 at the account's cap): proofs wait a minute. */
  NOTARY_NOT_ADMITTED: "degraded",
  /** A prover process was killed: out of memory, or past its deadline. The SDK lives and proves again later. */
  PROVER_KILLED: "degraded",
  /** The container's memory limit leaves less than one proof's peak beside the SDK. */
  PROVER_MEMORY_LOW: "degraded",
  /** A proof for a deal could not be produced or delivered. */
  PROOF_FAILED: "degraded",
  /** A `create_offer` or `cancel_offer` failed (item gone, trade hold, a Steam EResult). */
  DIRECTIVE_FAILED: "degraded",
  /**
   * DMarket leases offer writes to this SDK, which runs with `steamWrites: false`: they lapse to another device. A
   * leased cancel is named until its next issue is due, as DMarket issues it only now and then.
   */
  STEAM_WRITES_DISABLED: "degraded",
  /**
   * DMarket leased a `cancel_offer` when there was no usable Steam token to run it: the offer stays open on Steam,
   * where the seller could still confirm it. Named until the cancel runs, which a pushed token does at DMarket's next
   * issue of it, or for 14 days, when the offer lapses on Steam.
   */
  STEAM_CANCEL_PENDING: "degraded",
  /**
   * DMarket requires a proof for a tracked deal and this SDK has no prover: the deal's decisive report is held back,
   * and the deal does not advance until its deadline. Named until the report goes or DMarket no longer tracks the deal.
   */
  PROVER_DISABLED: "degraded",
  /**
   * DMarket asked to cancel a deal's Steam offer, and Steam shows the offer accepted or in escrow: the items changed
   * hands after DMarket gave up on the deal. A person has to look at the deal. Named for a day after it was last seen.
   */
  OFFER_ACCEPTED_AFTER_CANCEL: "degraded",
} as const satisfies Record<string, Severity>;

export type ProblemCode = keyof typeof PROBLEMS;

const UNAUTHORIZED = 401;
const FORBIDDEN = 403;
const TOO_MANY_REQUESTS = 429;
const TRY_AGAIN_LATER = 1013;
const AT_CAP = 4029;

/**
 * The problem a failed proof raises, or `null` for one that was never started; when the next proof may start is the
 * library's. The notary's refusals follow its own table: a 503 before the upgrade or a close 1013 after it is the
 * notary busy or down; a 403 or a close 4029 is admission; a 401 is the key, or the clock when it is skewed; the
 * protocol's version error only an update fixes; a close 4008 and everything else is that proof's failure.
 */
export function problemFor(failure: ProofFailure, clockSkewed = false): ProblemCode | null {
  switch (failure.type) {
    case "upgrade_refused":
      if (failure.status === UNAUTHORIZED) return clockSkewed ? "CLOCK_SKEW" : "DMARKET_AUTH_FAILED";
      if (failure.status === FORBIDDEN) return "NOTARY_NOT_ADMITTED";
      return failure.status >= 500 && failure.status <= 599 ? "NOTARY_UNAVAILABLE" : "PROOF_FAILED";
    case "session_closed":
      if (failure.code === TRY_AGAIN_LATER) return "NOTARY_UNAVAILABLE";
      return failure.code === AT_CAP ? "NOTARY_NOT_ADMITTED" : "PROOF_FAILED";
    case "notary_unreachable":
      return "NOTARY_UNAVAILABLE";
    case "version_mismatch":
      return "SDK_UPDATE_REQUIRED";
    case "steam_failed":
      if (failure.status === UNAUTHORIZED || failure.status === FORBIDDEN) return "STEAM_SESSION_REJECTED";
      return failure.status === TOO_MANY_REQUESTS ? "STEAM_RATE_LIMITED" : "STEAM_UNREACHABLE";
    case "prover_killed":
      return "PROVER_KILLED";
    case "not_started":
      return null;
    case "limits_exceeded":
    case "other":
      return "PROOF_FAILED";
  }
}
