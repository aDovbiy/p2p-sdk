// A minimal seller bot for the DMarket P2P SDK: Node.js 22 or newer, no dependencies.
//
// It keeps the SDK supplied with both credentials and accepts every deal that waits for the seller, while the SDK can
// deliver. It does not confirm trades: when the Steam offer the SDK created waits for its Steam Guard confirmation, it
// logs the offer, and that is where your bot hands `steamOfferId` to its Steam Guard emulator (for example
// node-steamcommunity's acceptConfirmationForObject). A real bot also checks before accepting that the item is not
// sold elsewhere.
//
// Environment:
//   SDK_MANAGEMENT_SECRET     the SDK's managementSecret
//   DMARKET_PUBLIC_KEY        Trading API public key, hex
//   DMARKET_SECRET_KEY        Trading API secret key, hex (64 bytes, or its 32-byte seed)
//   STEAM_ACCESS_TOKEN_FILE   a file holding the Steam access token; replace it with a fresh one to rotate the token
//   SDK_URL                   default http://127.0.0.1:8790
//   DMARKET_BASE_URL          default https://api.dmarket.com
//   POLL_SECONDS              default 30

import { Buffer } from "node:buffer";
import { createPrivateKey, sign } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { URLSearchParams } from "node:url";

function setting(name, fallback) {
  const value = process.env[name] ?? fallback;
  if (value === undefined || value === "") {
    log("error", `${name} is not set`);
    process.exit(2);
  }
  return value;
}

function log(level, msg, fields = {}) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), level, msg, ...fields }));
}

const SDK_URL = setting("SDK_URL", "http://127.0.0.1:8790").replace(/\/+$/, "");
const SDK_SECRET = setting("SDK_MANAGEMENT_SECRET");
const DMARKET_BASE_URL = setting("DMARKET_BASE_URL", "https://api.dmarket.com").replace(/\/+$/, "");
const PUBLIC_KEY = setting("DMARKET_PUBLIC_KEY");
const SECRET_KEY = setting("DMARKET_SECRET_KEY");
const TOKEN_FILE = setting("STEAM_ACCESS_TOKEN_FILE");
const POLL_SECONDS = Number(setting("POLL_SECONDS", "30"));
if (!Number.isFinite(POLL_SECONDS) || POLL_SECONDS < 5) {
  log("error", "POLL_SECONDS is not a number of seconds, 5 or more");
  process.exit(2);
}
const REQUEST_TIMEOUT_MS = 30_000;

// An Ed25519 private key from the secret key's 32-byte seed, wrapped as PKCS#8 for node:crypto.
const signingKey = (() => {
  const raw = Buffer.from(SECRET_KEY, "hex");
  if (raw.length !== 32 && raw.length !== 64) {
    log("error", "DMARKET_SECRET_KEY is not 32 or 64 bytes of hex");
    process.exit(2);
  }
  const pkcs8Prefix = Buffer.from("302e020100300506032b657004220420", "hex");
  return createPrivateKey({ key: Buffer.concat([pkcs8Prefix, raw.subarray(0, 32)]), format: "der", type: "pkcs8" });
})();

async function call(url, init) {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    // Not JSON: a proxy's error page, say. The status says enough.
  }
  return { status: response.status, json };
}

// --- The SDK's management API ---

function sdk(method, path, body) {
  return call(SDK_URL + path, { method, headers: { Authorization: `Bearer ${SDK_SECRET}` }, body });
}

async function pushKey() {
  const { status, json } = await sdk("PUT", "/v1/dmarket/key", JSON.stringify({ publicKey: PUBLIC_KEY, secretKey: SECRET_KEY }));
  log(status === 204 ? "info" : "error", "trading api key pushed", { status, error: json?.error });
}

// The token file's mtime when it was last pushed with a definite answer: a refused token is not pushed again until the
// file changes.
let pushedTokenMtime = 0;

async function pushToken() {
  const { mtimeMs } = await stat(TOKEN_FILE);
  const token = (await readFile(TOKEN_FILE, "utf8")).trim();
  const { status, json } = await sdk("PUT", "/v1/steam/session", JSON.stringify({ accessToken: token }));
  if (status === 204 || (status >= 400 && status < 500)) pushedTokenMtime = mtimeMs;
  log(status === 204 ? "info" : "error", "steam token pushed", { status, error: json?.error });
}

const STEAM_BLOCKERS = ["STEAM_TOKEN_MISSING", "STEAM_TOKEN_EXPIRED", "STEAM_SESSION_REJECTED", "STEAM_WRONG_ACCOUNT"];

// Whether the SDK can deliver now: it heartbeats and holds a Steam token with more than 30 minutes left. An accepted
// deal must get its Steam offer within two hours, so the bot accepts only while this holds.
let canDeliver = false;

// Push whatever the SDK lacks: after every SDK restart it holds neither credential. Never restart the SDK over its
// health; a restart only turns any problem into a missing key.
async function superviseSdk() {
  canDeliver = false;
  const { status, json } = await sdk("GET", "/v1/health");
  const codes = new Set((json?.problems ?? []).map((p) => p.code));
  if (json?.status !== "ok") log("warn", "sdk health", { status: json?.status ?? status, problems: [...codes] });
  if (codes.has("DMARKET_KEY_MISSING")) await pushKey();
  const tokenChanged = (await stat(TOKEN_FILE)).mtimeMs !== pushedTokenMtime;
  if (tokenChanged || codes.has("STEAM_TOKEN_MISSING") || codes.has("STEAM_TOKEN_EXPIRED")) await pushToken();
  const tokenMinutesLeft = (Date.parse(json?.steamTokenExpiresAt ?? "") - Date.now()) / 60_000;
  canDeliver = json?.status !== "down" && !STEAM_BLOCKERS.some((c) => codes.has(c)) && tokenMinutesLeft > 30;
}

// --- The Trading API ---

function tradingApi(method, pathAndQuery, body = "") {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const signature = sign(null, Buffer.from(method + pathAndQuery + body + timestamp), signingKey).toString("hex");
  return call(DMARKET_BASE_URL + pathAndQuery, {
    method,
    headers: {
      "X-Api-Key": PUBLIC_KEY,
      "X-Sign-Date": timestamp,
      "X-Request-Sign": `dmar ed25519 ${signature}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body || undefined,
  });
}

const DEALS = "/marketplace-api/v2/p2p/deals";
const CLOSED = new Set(["COMPLETED", "CANCELLED"]);
// Refusals that will not change on a retry: the deal has moved on, or is not this account's to act on.
const FINAL_REFUSALS = new Set(["PRECOMMIT_WINDOW_CLOSED", "DELIVERY_WINDOW_CLOSED", "NOT_SELLER", "Forbidden", "Not Found"]);

// Deals whose action has not gone through yet, by dealId: retried every round until it does or the deal moves on.
// A refused action writes nothing to the feed, so the feed alone would never show such a deal again.
const pending = new Map();

async function signal(deal, action) {
  const { status, json } = await tradingApi("POST", `${DEALS}/${deal.dealId}:${action}`, "{}");
  const fields = { dealId: deal.dealId, status, code: json?.Code };
  if (status === 202) {
    log("info", action, fields);
    return "done";
  }
  if (FINAL_REFUSALS.has(json?.Code) || status === 403 || status === 404) {
    log("warn", `${action} refused`, fields);
    return "done";
  }
  log("warn", `${action} not sent, will retry`, fields);
  return "retry";
}

// Acts on one deal; answers "retry" when the action has to be tried again next round.
async function act(deal) {
  if (deal.phase === "UNSPECIFIED" || (!deal.nextAction && !CLOSED.has(deal.phase))) {
    // The feed item does not carry the next action: the deal's own read does.
    const { status, json } = await tradingApi("GET", `${DEALS}/${deal.dealId}`);
    if (status !== 200 || !json?.deal) {
      log("warn", "deal read", { dealId: deal.dealId, status, code: json?.Code });
      return status === 404 ? "done" : "retry";
    }
    const read = json.deal;
    deal = { ...deal, phase: read.phase, nextAction: read.nextAction, steamOfferId: read.steamOfferId || deal.steamOfferId };
  }

  if (deal.phase === "AWAITING_SELLER_ACCEPT") {
    if (!canDeliver) {
      log("warn", "accept deferred until the SDK can deliver", { dealId: deal.dealId });
      return "retry";
    }
    return signal(deal, "accept");
  }
  if (deal.nextAction === "SELLER_CREATE_TRADE" && !deal.deliveryConsented && deal.acceptedViaApi) {
    // The offer failed and DMarket allows a replacement: consent to a new attempt.
    return signal(deal, "createTrade");
  }
  if (deal.nextAction === "SELLER_CONFIRM_TRADE") {
    log("warn", "confirm this offer in Steam Guard", {
      dealId: deal.dealId,
      steamOfferId: deal.steamOfferId,
      steamAssetIds: deal.steamAssetIds,
      buyerSteamId: deal.buyerSteamId,
      deadline: deal.offerCreateDeadlineTime,
    });
  } else if (deal.phase === "FROZEN") {
    log("warn", "deal frozen: keep the SDK online", { dealId: deal.dealId, frozenFrom: deal.frozenFrom });
  }
  return "done";
}

async function handle(deal) {
  if ((await act(deal)) === "retry") pending.set(deal.dealId, deal);
  else pending.delete(deal.dealId);
}

// The cursor lives in memory: after a restart the feed is read from the beginning, which is safe, since an action on
// a deal that has moved on is refused.
let cursor = "";

async function pollDeals() {
  for (const deal of [...pending.values()]) await handle(deal);
  for (;;) {
    const query = new URLSearchParams({ role: "SELLER", limit: "100", cursor });
    const { status, json } = await tradingApi("GET", `${DEALS}?${query}`);
    if (status !== 200) {
      log("warn", "deal feed", { status, code: json?.Code });
      return;
    }
    const items = json?.items ?? [];
    for (const deal of items) await handle(deal);
    cursor = json?.cursor || cursor;
    if (items.length < 100) return;
  }
}

// --- Main loop ---

for (const name of ["SIGINT", "SIGTERM"]) process.on(name, () => process.exit(0));

log("info", "seller bot started", { sdk: SDK_URL, dmarket: DMARKET_BASE_URL });
for (;;) {
  let sdkReached = true;
  for (const step of [superviseSdk, pollDeals]) {
    try {
      await step();
    } catch (error) {
      if (step === superviseSdk) sdkReached = false;
      log("warn", `${step.name} failed`, { reason: error.cause?.code ?? error.code ?? error.name });
    }
  }
  // Right after a start the SDK may not listen yet: try again soon rather than in a full round.
  await sleep(sdkReached ? POLL_SECONDS * 1000 : 3000);
}
