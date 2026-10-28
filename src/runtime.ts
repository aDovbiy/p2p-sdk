import {
  createHeadlessTracker,
  cycle,
  pushSteamToken,
  pushTradingApiKey,
  start,
  stop,
  trackerState,
  type ProverOptions,
  type TrackerHandle,
} from "@dmarket/p2p-tracker-headless";

import type { ManagementActions, PushOutcome } from "./api.js";
import type { ProverConfig, SdkConfig } from "./config.js";
import { HealthTracker, type Health } from "./health/tracker.js";
import type { Log } from "./log.js";
import { isoInstant } from "./time.js";

export interface RuntimeOptions {
  /** With it the tracker proves, each proof in a prover process of its own. */
  readonly prover?: ProverOptions;
  /** The clock, in epoch milliseconds; the system clock by default. */
  readonly nowMs?: () => number;
}

const HELD: PushOutcome = { type: "held" };
const KEY_LINES = { FIRST: "dmarket key pushed", ROTATED: "dmarket key rotated", REPLACED: "dmarket key replaced" };
const MIB = 1024 * 1024;

/**
 * The tracker's `prover` option from the config's `prover`: none when proving is off, and the library's own prover
 * files unless `assetsDir` names others. The notary is the tracker's `notaryUrl`, which the runtime sets from it.
 */
export function proverOptions(prover: ProverConfig): ProverOptions | undefined {
  if (!prover.enabled) return undefined;
  return {
    maxConcurrency: prover.maxConcurrency,
    proofsPerChild: prover.proofsPerChild,
    threadCount: prover.threadCount,
    ...(prover.assetsDir === null ? {} : { assetsDir: prover.assetsDir }),
  };
}

/**
 * The SDK: the library's headless tracker behind the management API. The tracker holds the pushed secrets and runs
 * the loop; this answers the API's pushes, and feeds health and the log from the pushes and the loop's events. The
 * tracker's handle stays private: it is never logged or serialized.
 */
export class SdkRuntime implements ManagementActions {
  readonly #handle: TrackerHandle;
  readonly #health: HealthTracker;
  readonly #log: Log;
  readonly #peakMemoryBytes: number;

  constructor(config: SdkConfig, log: Log, options: RuntimeOptions = {}) {
    const nowMs = options.nowMs ?? Date.now;
    const health = new HealthTracker(nowMs);
    this.#health = health;
    this.#log = log;
    this.#peakMemoryBytes = config.prover.peakMemoryMb * MIB;
    this.#handle = createHeadlessTracker({
      dataDir: config.dataDir,
      baseUrl: config.dmarketBaseUrl,
      steamWrites: config.steamWrites,
      notaryUrl: config.prover.notaryUrl,
      ...(options.prover === undefined ? {} : { prover: options.prover }),
      onEvent: (json) => {
        health.onEvent(json);
        log.event(json);
      },
      onProofOutcome: (outcome) => {
        health.proofOutcome(outcome);
      },
      onProverLine: (stream, line) => {
        log.proverLine(stream, line);
      },
      nowMs,
    });
  }

  /** Starts the tracker, which waits for the bot's pushes before it heartbeats. */
  start(): void {
    start(this.#handle);
  }

  /** Runs one cycle now, behind the cycle in flight. */
  cycle(): Promise<void> {
    return cycle(this.#handle);
  }

  /** Stops the tracker and ends every prover process. */
  stop(): Promise<void> {
    return stop(this.#handle);
  }

  /** At start: the container's memory limit leaves less than one proof's peak beside the SDK. */
  proverMemoryLow(limitBytes: number, usedBytes: number): void {
    this.#health.proverMemoryLow(limitBytes, usedBytes, this.#peakMemoryBytes);
    this.#log.warn("prover memory low", { limitBytes: String(limitBytes), usedBytes: String(usedBytes) });
  }

  async putDmarketKey(publicKey: string, secretKey: string): Promise<PushOutcome> {
    const push = await pushTradingApiKey(this.#handle, publicKey, secretKey);
    this.#health.tradingApiKeyPushed(push);
    switch (push.type) {
      case "invalid":
        this.#log.warn("dmarket key refused", { reason: push.reason });
        return { type: "invalid", error: "INVALID_KEY", reason: push.reason };
      case "held":
        if (push.change !== "SAME") this.#log.info(KEY_LINES[push.change], { publicKey: push.publicKey });
        return HELD;
      case "accountChanged": {
        const theirs = push.keyLinkedSteamId === null ? "no Steam account" : `Steam account ${push.keyLinkedSteamId}`;
        this.#log.warn("dmarket key for another account refused", {
          publicKey: push.publicKey,
          heldPublicKey: push.heldPublicKey,
          linkedSteamId: push.linkedSteamId,
          keyLinkedSteamId: push.keyLinkedSteamId,
        });
        return {
          type: "conflict",
          error: "DMARKET_KEY_ACCOUNT_CHANGED",
          reason:
            `the key's account links ${theirs}, not ${push.linkedSteamId}; the held key stays: ` +
            "switching accounts takes a restart",
        };
      }
      case "unverified": {
        this.#log.warn("dmarket key unchecked", { publicKey: push.publicKey, reason: push.reason });
        const error = trackerState(this.#handle).clockSkewed ? "CLOCK_SKEW" : "DMARKET_UNREACHABLE";
        return { type: "unavailable", error, reason: `the key could not be checked: ${push.reason}; the held key stays` };
      }
    }
  }

  async putSteamToken(accessToken: string): Promise<PushOutcome> {
    const push = await pushSteamToken(this.#handle, accessToken);
    this.#health.steamTokenPushed(push);
    switch (push.type) {
      case "invalid":
        this.#log.warn("steam token refused", { reason: push.reason });
        return { type: "invalid", error: "INVALID_TOKEN", reason: push.reason };
      case "held":
        this.#log.info("steam token held", { steamId: push.steamId, expiresAt: isoInstant(push.expiresAtMs) });
        return HELD;
      case "wrongAccount": {
        const expected = push.linkedSteamId ?? "the account of the token already held";
        this.#log.warn("steam token for another account refused", { tokenSteamId: push.tokenSteamId, expected });
        return {
          type: "conflict",
          error: "STEAM_WRONG_ACCOUNT",
          reason: `the token is for ${push.tokenSteamId}, not ${expected}`,
        };
      }
    }
  }

  health(): Health {
    return this.#health.snapshot(trackerState(this.#handle));
  }
}
