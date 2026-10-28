import { failedCancelKinds, type ProverLineStream } from "@dmarket/p2p-tracker-headless";

import { isoInstant } from "./time.js";

export type Level = "info" | "warn" | "error";

/** A line's own fields: strings, or `null` for a value there is none of. */
export type Fields = Readonly<Record<string, string | null>>;

const ERROR_EVENTS: ReadonlySet<string> = new Set([
  "CycleFailed",
  "LinkedSteamIdMismatch",
  "MarketplaceServerError",
  "ReLoginNeeded",
]);
const WARN_EVENTS: ReadonlySet<string> = new Set([
  "SteamReadFailed",
  "ProofFailed",
  "DirectiveReportFailed",
  "TradeStatusReportFailed",
  "LinkedSteamIdUnknown",
  "SteamWriteDeferred",
  "CreateUnanswered",
]);

/**
 * Structured logs: one JSON object per line, `{ts, level, msg, …fields}`.
 *
 * Callers pass only what is safe to print: a public key, a Steam id, a deal id, never a secret. The tracker's events
 * and the prover's lines come from the library already free of secrets and are written as they are.
 */
export class Log {
  constructor(
    private readonly writeLine: (line: string) => void = (line) => process.stdout.write(line + "\n"),
    private readonly nowMs: () => number = Date.now,
  ) {}

  info(msg: string, fields: Fields = {}): void {
    this.write("info", msg, fields);
  }

  warn(msg: string, fields: Fields = {}): void {
    this.write("warn", msg, fields);
  }

  error(msg: string, fields: Fields = {}): void {
    this.write("error", msg, fields);
  }

  /** One of the tracker's events, the JSON string `onEvent` gives: `msg: "event"` and the event's own fields. */
  event(json: string): void {
    const payload = asObject(JSON.parse(json));
    this.write(levelOf(payload), "event", payload);
    // A trade that went through after DMarket gave up on the deal: no problem code is ever sent to DMarket, so this
    // line is the lasting record a person acts on.
    if (payload.event === "FailedCancelChecked" && payload.kind === failedCancelKinds().alreadyTraded) {
      this.warn("offer accepted after cancel", {
        dealId: text(payload.dealId),
        offerId: text(payload.steamOfferId),
        offerState: text(payload.offerState),
      });
    }
  }

  /**
   * A line `onProverLine` gives. A prover process's output is "prover output", a warning from stderr; the host's own
   * line is a JSON object `{msg, level, …fields}` and is written with that message, level and fields.
   */
  proverLine(stream: ProverLineStream, line: string): void {
    if (stream !== "host") {
      this.write(stream === "stderr" ? "warn" : "info", "prover output", { stream, line });
      return;
    }
    const { msg, level, ...fields } = asObject(JSON.parse(line));
    if (typeof msg !== "string" || (level !== "info" && level !== "warn")) {
      this.write("warn", "prover output", { stream, line });
      return;
    }
    this.write(level, msg, fields);
  }

  private write(level: Level, msg: string, fields: Readonly<Record<string, unknown>>): void {
    this.writeLine(JSON.stringify({ ts: isoInstant(this.nowMs()), level, msg, ...fields }));
  }
}

function levelOf(event: Readonly<Record<string, unknown>>): Level {
  const name = event.event;
  if (typeof name !== "string") return "info";
  if (ERROR_EVENTS.has(name)) return "error";
  if (WARN_EVENTS.has(name)) return "warn";
  return name === "DirectiveExecuted" && event.status === "FAILED" ? "warn" : "info";
}

function asObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("expected a JSON object");
  }
  return value as Record<string, unknown>;
}

/** An event's id or code as a line field: its text, or `null` when the event has none. */
function text(value: unknown): string | null {
  return typeof value === "string" || typeof value === "number" ? String(value) : null;
}
