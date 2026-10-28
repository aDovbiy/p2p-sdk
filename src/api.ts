import { timingSafeEqual } from "node:crypto";

import type { Health } from "./health/tracker.js";

/** One answer of the management API: an HTTP status and a JSON body (empty for `204`). */
export interface ApiResponse {
  readonly status: number;
  readonly body: string;
}

/** The outcome of a push, as the API reports it. `reason` is the SDK's own and never echoes the secret. */
export type PushOutcome =
  | { readonly type: "held" }
  | {
      /** `invalid` is the push's own fault; `conflict` another account's; `unavailable` may pass if pushed again. */
      readonly type: "invalid" | "conflict" | "unavailable";
      readonly error: string;
      readonly reason: string;
    };

/** What the API acts on. Implemented by the SDK runtime. */
export interface ManagementActions {
  putDmarketKey(publicKey: string, secretKey: string): Promise<PushOutcome>;
  putSteamToken(accessToken: string): Promise<PushOutcome>;
  health(): Health;
}

export const KEY_PATH = "/v1/dmarket/key";
export const STEAM_PATH = "/v1/steam/session";
export const HEALTH_PATH = "/v1/health";

/** A push body is a key pair or one token: anything past this is not one. */
export const MAX_BODY_BYTES = 16 * 1024;

const BEARER = "Bearer ";
const STATUS = { held: 204, invalid: 400, conflict: 409, unavailable: 503 } as const;

/**
 * The local management API, as a function of one request: routing, the bearer check and the JSON in and out. The
 * listener that feeds it is `ManagementServer`.
 *
 * - `PUT /v1/dmarket/key {publicKey, secretKey}` → `204`; `400 INVALID_KEY` for a malformed pair or one DMarket
 *   refuses; `409 DMARKET_KEY_ACCOUNT_CHANGED` for a key of another DMarket account; `503 DMARKET_UNREACHABLE` when the
 *   key's check heartbeat does not come back, `503 CLOCK_SKEW` when it was refused while this host's clock is off
 *   DMarket's. The held key stays on every refusal.
 * - `PUT /v1/steam/session {accessToken}` → `204`; `400 INVALID_TOKEN` for a token the SDK will not hold; `409
 *   STEAM_WRONG_ACCOUNT` for a token of another Steam account (the held one stays).
 * - `GET /v1/health` → `Health`: `503` while it is `down` (the SDK counts as absent to DMarket), `200` otherwise.
 *
 * Every route requires `Authorization: Bearer <managementSecret>`; anything else is `401` before the body is looked
 * at. Both pushes are write-only: no answer, error or log line carries the secret key or the Steam token.
 */
export class ManagementApi {
  readonly #secret: Buffer;
  readonly #actions: ManagementActions;

  constructor(managementSecret: string, actions: ManagementActions) {
    this.#secret = Buffer.from(managementSecret, "utf8");
    this.#actions = actions;
  }

  async handle(method: string, path: string, authorization: string | undefined, body: string): Promise<ApiResponse> {
    if (!this.#authorized(authorization)) return error(401, "UNAUTHORIZED", "a valid bearer is required");
    const route = (path.split("?")[0] ?? "").replace(/\/+$/, "");
    switch (route) {
      case KEY_PATH:
        return method === "PUT" ? this.#putKey(body) : methodNotAllowed();
      case STEAM_PATH:
        return method === "PUT" ? this.#putSteam(body) : methodNotAllowed();
      case HEALTH_PATH:
        return method === "GET" ? this.#health() : methodNotAllowed();
      default:
        return error(404, "NOT_FOUND", "no such route");
    }
  }

  /** `down` answers 503, so a container health check marks the SDK unhealthy; the body is the same either way. */
  #health(): ApiResponse {
    const health = this.#actions.health();
    return { status: health.status === "down" ? 503 : 200, body: JSON.stringify(health) };
  }

  async #putKey(body: string): Promise<ApiResponse> {
    const request = decode(body, "publicKey", "secretKey");
    if (!request) return error(400, "INVALID_BODY", "expected {publicKey, secretKey}");
    return answer(await this.#actions.putDmarketKey(request.publicKey, request.secretKey));
  }

  async #putSteam(body: string): Promise<ApiResponse> {
    const request = decode(body, "accessToken");
    if (!request) return error(400, "INVALID_BODY", "expected {accessToken}");
    return answer(await this.#actions.putSteamToken(request.accessToken));
  }

  /** Compares in time independent of where the two differ, so the secret cannot be guessed a byte at a time. */
  #authorized(header: string | undefined): boolean {
    if (header?.startsWith(BEARER) !== true) return false;
    const presented = Buffer.from(header.slice(BEARER.length), "utf8");
    const sameLength = presented.length === this.#secret.length;
    // timingSafeEqual takes equal lengths only: a presented bearer of another length is compared as the secret itself.
    return timingSafeEqual(sameLength ? presented : this.#secret, this.#secret) && sameLength;
  }
}

function answer(outcome: PushOutcome): ApiResponse {
  return outcome.type === "held" ? { status: STATUS.held, body: "" } : error(STATUS[outcome.type], outcome.error, outcome.reason);
}

/**
 * The body's string fields `keys`, or `null` when it is not a JSON object with each of them a string. Other keys are
 * ignored. A parse error's message can quote the body, which holds the secret being pushed: it is never surfaced.
 */
function decode<K extends string>(body: string, ...keys: K[]): Record<K, string> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const fields = parsed as Record<string, unknown>;
  return keys.every((key) => typeof fields[key] === "string") ? (fields as Record<K, string>) : null;
}

function methodNotAllowed(): ApiResponse {
  return error(405, "METHOD_NOT_ALLOWED", "method not allowed on this route");
}

function error(status: number, code: string, reason: string): ApiResponse {
  return { status, body: JSON.stringify({ error: code, reason }) };
}
