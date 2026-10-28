import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

export const T0 = Date.parse("2026-06-16T12:00:00Z");
export const STEAM_ID = "76561198000000001";
export const OTHER_STEAM_ID = "76561198000000099";
/** RFC 8032 TEST 1: a key pair that signs. */
export const PUBLIC_KEY = "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a";
export const SECRET_KEY = "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60";
/** RFC 8032 TEST 2: another key pair that signs. */
export const OTHER_PUBLIC_KEY = "3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c";
export const OTHER_SECRET_KEY = "4ccd089b28ff96da9db6c346ec114e0f5b8a319f35aba624da8cf6ed4fb8a6fb";

/** A Steam access token shaped like Steam's: a JWT whose payload carries `sub`, `aud` and `exp`. Unsigned. */
export function steamToken(
  options: { sub?: string; aud?: readonly string[]; expiresAtMs?: number } = {},
): string {
  const payload = {
    iss: "r:test",
    sub: options.sub ?? STEAM_ID,
    aud: options.aud ?? ["web", "mobile"],
    exp: (options.expiresAtMs ?? T0 + 24 * 60 * 60_000) / 1000,
    iat: T0 / 1000,
  };
  const encode = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${encode({ alg: "EdDSA", typ: "JWT" })}.${encode(payload)}.c2lnbmF0dXJl`;
}

/** The part of a token that names its account and expiry: what must never show up anywhere. */
export function tokenPayload(token: string): string {
  return token.split(".")[1] ?? token;
}

/**
 * How a heartbeat is answered: `status` 200 by default, with `linkedSteamId` `STEAM_ID`; a refusal carries `code`.
 *
 * A 200 always carries empty `activeTracking` and `directives`, and there is no way to ask for anything else: with a
 * Steam token held, a tracked deal or a directive would make the library call Steam, which a test cannot stand in for.
 */
export interface HeartbeatReply {
  readonly status?: number;
  readonly linkedSteamId?: string;
  readonly updateRequired?: boolean;
  readonly code?: string;
}

export interface SeenRequest {
  readonly path: string;
  readonly apiKey: string | undefined;
  readonly body: string;
}

/** DMarket's gateway on loopback, for a tracker built with `baseUrl` set to `baseUrl`. */
export class DmarketStub {
  readonly requests: SeenRequest[] = [];
  inFlight = 0;
  heartbeat: HeartbeatReply = {};
  /** What a heartbeat signed with `OTHER_PUBLIC_KEY` gets instead of `heartbeat`, when set. */
  otherKeyHeartbeat: HeartbeatReply | undefined;
  /**
   * The `Date` every reply carries, in epoch ms; `null` sends none. Node would send its own, the real clock's, and a
   * tracker on a test clock would read that as a skewed clock.
   */
  serverDateMs: number | null = null;

  readonly #server = createServer((request, response) => {
    this.#serve(request, response);
  });

  static async start(): Promise<DmarketStub> {
    const stub = new DmarketStub();
    await new Promise<void>((resolve) => stub.#server.listen(0, "127.0.0.1", resolve));
    return stub;
  }

  get baseUrl(): string {
    const address = this.#server.address();
    if (typeof address !== "object" || address === null) throw new Error("the stub is not listening");
    return `http://127.0.0.1:${String(address.port)}`;
  }

  /** The `clientVersion` of each heartbeat so far. */
  clientVersions(): unknown[] {
    return this.requests
      .filter((it) => it.path.endsWith("/p2p/ext/heartbeat"))
      .map((it) => (JSON.parse(it.body) as Record<string, unknown>).clientVersion);
  }

  async close(): Promise<void> {
    this.#server.closeAllConnections();
    await new Promise((resolve) => this.#server.close(resolve));
  }

  #serve(request: IncomingMessage, response: ServerResponse): void {
    this.inFlight += 1;
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => (body += chunk));
    request.on("end", () => {
      const path = request.url ?? "";
      const apiKey = request.headers["x-api-key"];
      this.requests.push({ path, apiKey: typeof apiKey === "string" ? apiKey : undefined, body });
      const reply = path.endsWith("/p2p/ext/heartbeat")
        ? heartbeatAnswer((apiKey === OTHER_PUBLIC_KEY ? this.otherKeyHeartbeat : undefined) ?? this.heartbeat)
        : { status: 200, body: "{}" };
      response.sendDate = false;
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (this.serverDateMs !== null) headers.date = new Date(this.serverDateMs).toUTCString();
      response.writeHead(reply.status, headers);
      response.end(reply.body, () => (this.inFlight -= 1));
    });
  }
}

function heartbeatAnswer(reply: HeartbeatReply): { status: number; body: string } {
  const status = reply.status ?? 200;
  if (status !== 200) return { status, body: JSON.stringify(reply.code === undefined ? {} : { code: reply.code }) };
  const body = {
    activeTracking: [],
    directives: [],
    ttlSeconds: 100,
    linkedSteamId: reply.linkedSteamId ?? STEAM_ID,
    ...(reply.updateRequired === undefined ? {} : { updateRequired: reply.updateRequired }),
  };
  return { status, body: JSON.stringify(body) };
}
