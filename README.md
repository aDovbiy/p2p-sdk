# dmarket-p2p-sdk

[![Release](https://img.shields.io/github/v/release/dmarket/p2p-sdk?label=release&include_prereleases)](https://github.com/dmarket/p2p-sdk/releases)
[![GHCR](https://ghcr-badge.egpl.dev/dmarket/p2p-sdk/latest_tag?ignore=latest,snapshot&label=ghcr.io)](https://github.com/orgs/dmarket/packages/container/package/p2p-sdk)

A headless seller client for DMarket P2P trading. It runs next to your trading bot, one process per Steam account,
and keeps that account's DMarket P2P deals in sync with Steam: it heartbeats to DMarket as the account, creates and
cancels the trade offers DMarket asks for, and proves and reports their Steam status back.

**The SDK sells nothing by itself.** Your bot lists items and accepts deals through the DMarket Trading API, and
confirms each trade offer the SDK creates with its own Steam Guard emulator. The SDK does the part in between: the
Steam offers and the proofs.

> The trade-tracker logic lives in a separate library, [dmarket/p2p-tracker-core](https://github.com/dmarket/p2p-tracker-core),
> the same core the [DMarket P2P browser extension](https://github.com/dmarket/p2p-extension) runs, consumed as its npm
> package [`@dmarket/p2p-tracker-headless`](https://www.npmjs.com/package/@dmarket/p2p-tracker-headless) and pinned to
> an exact version. This repository owns the process around it: the config file, the logs, health, the local
> management API, the container image and the Linux archive.

**Start here:** [How it fits](#how-it-fits) · [Before you start](#before-you-start) · [Quick start](#quick-start) ·
[Wire it into your bot](#wire-it-into-your-bot) · [Selling](#selling) · [Buying](#buying) ·
[Several Steam accounts](#several-steam-accounts) · [Troubleshooting](#troubleshooting)

**Reference:** [Verify what you run](#verify-what-you-run) · [Install from the archive](#install-from-the-archive) ·
[Configuration](#configuration) · [Management API](#management-api) · [Health](#health) · [Proofs](#proofs) ·
[Security](#security) · [Versions and updates](#versions-and-updates) · [Running from source](#running-from-source)

## How it fits

```
          Trading API (list, accept, deal feed)
 your bot ─────────────────────────────────────▶ DMarket
    │                                               ▲
    │ push key + token, read health                 │ heartbeat, offer status, proofs
    ▼                                               │
   SDK  ────────────────────────────────────────────┘
    │
    │ create / cancel / read trade offers
    ▼
  Steam ◀──── your bot's Steam Guard emulator confirms the offer
```

| Who | Does |
|---|---|
| Your bot | Lists items, reads the deal feed, accepts or declines deals, pushes both credentials to the SDK, watches its health |
| Your bot's Steam Guard emulator | Confirms the trade offer the SDK created. The SDK never confirms a trade |
| The SDK | Heartbeats to DMarket, creates and cancels the Steam offers DMarket asks for, watches them, proves and reports their status |

## Before you start

- A DMarket account with your Steam account linked to it. Without the link the SDK reports `STEAM_NOT_LINKED`.
- A DMarket Trading API key pair (public and secret, hex): the same pair your bot signs its Trading API calls with.
- A way for your bot to get a Steam access token for that Steam account, with the `web` or `web:community` audience.
  A refresh token or a `web:store` token is refused. Tokens expire: the bot pushes a fresh one before the SDK warns
  (`STEAM_TOKEN_EXPIRING`, under four hours left).
- A Steam Guard emulator in your bot, holding the account's `identity_secret`, to confirm the offers the SDK creates:
  for example [`node-steamcommunity`](https://github.com/DoctorMcKay/node-steamcommunity)'s
  `acceptConfirmationForObject(identitySecret, steamOfferId)`. The SDK never sees that secret and never confirms.
- A host with Docker on `linux/amd64` or `linux/arm64`, or a Linux host for the [archive](#install-from-the-archive).
  At least 768 MB of memory per Steam account (see [Proofs](#proofs)).
- A synchronized clock (NTP). More than a minute off DMarket's and every signed request is refused (`CLOCK_SKEW`).

## Quick start

One Steam account, with Docker Compose. The SDK and your bot share one network namespace, owned by a container that
does nothing else, so the SDK's API is on `127.0.0.1:8790` for the bot and nowhere else, and either one can restart
without cutting the other off. Nothing is published on the host.

1. Make a directory with [`examples/compose.yaml`](examples/compose.yaml) and [`examples/seller.mjs`](examples/seller.mjs)
   in it. The `bot` service runs the example seller bot; swap it for your own bot later.

2. Generate a management secret. It guards the SDK's local API:

   ```bash
   openssl rand -hex 32
   ```

3. Write `config.json`. Leave `listenHost` out: in the shared namespace the default, `127.0.0.1`, is right.

   ```json
   {
     "managementSecret": "<the generated secret>",
     "dataDir": "/data"
   }
   ```

4. The image runs as user `node` (uid and gid 1000). Let it read the config, and nobody else:

   ```bash
   chmod 640 config.json && sudo chgrp 1000 config.json
   ```

   Under rootless Docker or user-namespace remapping, host gid 1000 is not the container's: there, give the file the
   group your remapping maps to the container's gid 1000.

5. Give the example bot its credentials. Set `DMARKET_PUBLIC_KEY`, `DMARKET_SECRET_KEY` (your Trading API key pair)
   and `STEAM_ACCESS_TOKEN` in your shell first; `seller.env` gets the secrets, `steam/token` the Steam access token:

   ```bash
   umask 077
   printf 'SDK_MANAGEMENT_SECRET=%s\nDMARKET_PUBLIC_KEY=%s\nDMARKET_SECRET_KEY=%s\n' \
     '<the generated secret>' "$DMARKET_PUBLIC_KEY" "$DMARKET_SECRET_KEY" > seller.env
   mkdir -p steam && printf '%s' "$STEAM_ACCESS_TOKEN" > steam/token
   ```

6. Start it:

   ```bash
   docker compose up -d
   ```

   The SDK logs `sdk started`. The bot logs `trading api key pushed` and `steam token pushed`, both with `status: 204`,
   within a few seconds: until the SDK listens, the bot logs `superviseSdk failed` with `ECONNREFUSED` and retries.

7. Check the health from the bot's side of the namespace:

   ```bash
   docker compose exec bot node -e 'fetch("http://127.0.0.1:8790/v1/health", { headers: { Authorization: `Bearer ${process.env.SDK_MANAGEMENT_SECRET}` } }).then((r) => r.text()).then(console.log)'
   ```

   Success looks like `"status": "ok"`, `"problems": []` and a `lastHeartbeatAt` that is not `null`. Anything else:
   see [Troubleshooting](#troubleshooting).

8. List an item for P2P sale through the Trading API (`POST /marketplace-api/v2/offers:batchCreate`, each offer
   with `"offerType": "p2p"`). When someone buys it, the bot accepts the deal, the SDK creates
   the Steam offer, and the bot logs `confirm this offer in Steam Guard` with the offer id. The example bot stops
   there: your own bot hands that `steamOfferId` to its Steam Guard emulator, which confirms it.

To rotate the Steam token, replace `steam/token`: the bot pushes the new one on its next round. To change the
config, `docker compose restart sdk`: the SDK reads it only at start, and the bot pushes both credentials to the
new SDK by itself.

**A bot on the host instead of in a container:** run the SDK alone, listening on `0.0.0.0` inside the container
(`"listenHost": "0.0.0.0"` in `config.json`) and published on the host's loopback only:

```bash
docker run -d --name dmarket-p2p-sdk --restart unless-stopped --memory 768m \
  -p 127.0.0.1:8790:8790 \
  -v "$PWD/config.json:/config/config.json:ro" -v dmarket-p2p-sdk-data:/data \
  -e DMARKET_SDK_CONFIG=/config/config.json \
  ghcr.io/dmarket/p2p-sdk:1.0.0-beta
```

Never publish the port on a public interface: the API takes your Trading API key and Steam token.

## Wire it into your bot

[`examples/seller.mjs`](examples/seller.mjs) does all of this in dependency-free JavaScript. What
your bot must do:

1. **At start:** start the SDK, push the Trading API key, push the Steam token, then read `GET /v1/health` every 30–60
   seconds.
2. **After every SDK restart, push both again.** The SDK keeps them in memory only, so a restarted SDK has neither:
   health shows `DMARKET_KEY_MISSING` and `STEAM_TOKEN_MISSING`. Without the key the SDK cannot heartbeat, DMarket
   counts you absent, and a deal waiting for your accept times out at your fault.
3. **Keep the Steam token fresh.** Push a new one before `STEAM_TOKEN_EXPIRING` (under four hours left). Under 30
   minutes the SDK creates no offer and starts no proof.
4. **Never restart the SDK over its health.** A restart turns any problem into a missing key. Use health for alerts
   and for deciding what to push; for liveness, check that the port accepts connections. No auto-heal containers.
5. **Confirm the SDK's offers with your Steam Guard emulator.** When the feed shows `nextAction:
   SELLER_CONFIRM_TRADE`, confirm the Steam offer `steamOfferId`, within two hours of the accept. The SDK creates the
   offer and never confirms it.
6. **One SDK per Steam account,** and one DMarket account per SDK. A key for another DMarket account is refused:
   switching accounts is a restart.
7. **Keep the secrets out of your logs.** Do not log request bodies to the SDK. The SDK's own log shows which key and
   account it holds (the key's `publicKey`, the Steam id), never a secret.

```
start SDK
loop every 30–60 s:
    health = GET /v1/health
    if DMARKET_KEY_MISSING in health.problems: PUT /v1/dmarket/key
    if STEAM_TOKEN_MISSING or STEAM_TOKEN_EXPIRED in health.problems, or the token is near expiry: PUT /v1/steam/session
    alert on any other problem (see Troubleshooting)
    for each deal in GET /marketplace-api/v2/p2p/deals?role=SELLER&cursor=…: act on it (see Selling)
```

## Selling

Your bot reads the deal feed, `GET /marketplace-api/v2/p2p/deals?role=SELLER&cursor=<cursor>`, every 30–60 seconds,
and keeps the `cursor` each page returns. An empty cursor reads the account's whole history. Items are snapshots
delivered at least once: key them on `recordId`, not `dealId`. `GET /marketplace-api/v2/p2p/deals/{dealId}` reads one
deal.

Where your bot or you have something to do:

| The feed shows | Do | Deadline |
|---|---|---|
| `phase: AWAITING_SELLER_ACCEPT` | make sure the item is not sold elsewhere, then `POST …/p2p/deals/{dealId}:accept` or `:decline` | 12 hours (`sellerAcceptDeadlineTime`) |
| `nextAction: SELLER_CONFIRM_TRADE` | your Steam Guard emulator confirms offer `steamOfferId` | 2 hours from the accept, confirmation included (`offerCreateDeadlineTime`) |
| `nextAction: SELLER_CREATE_TRADE`, `deliveryConsented: false`, `acceptedViaApi: true` | the offer failed and a new one is allowed: `POST …/p2p/deals/{dealId}:createTrade` | the same 2 hours |
| `phase: FROZEN` | bring the SDK back online: a freeze almost always means it was offline | — |

Everything else is the SDK's or the buyer's move: wait. After the buyer accepts, the item sits under Steam's 7-day
trade protection (`AWAITING_TERMINAL`); keep the SDK online until the deal is `COMPLETED`, since the release needs a
fresh proof from it.

An action answers `202` when it was sent; its outcome shows in the feed. A refusal answers `403`, `404` or `409` with
`{"Code": "…", "Message": "…"}`, for example `409 SELLER_OFFLINE` when the SDK is not heartbeating. A refusal writes
nothing to the feed, so the deal will not show up again by itself: retry a refused `:accept` until it is sent, the deal
moves on, or its deadline passes.

Accept only while the SDK can deliver: health not `down`, no `STEAM_TOKEN_MISSING`, `STEAM_TOKEN_EXPIRED`,
`STEAM_SESSION_REJECTED` or `STEAM_WRONG_ACCOUNT`, and more than 30 minutes left on the token
(`steamTokenExpiresAt`). An accepted deal has two hours to get its Steam offer.

When a feed item has `phase: UNSPECIFIED`, or an open deal comes with an empty `nextAction`, read
`GET …/p2p/deals/{dealId}` and act on its `phase` and `nextAction`.

## Buying

A buying account does not need the SDK: buying, the deal feed (`role=BUYER`) and `:cancel` are plain Trading API
calls, and accepting the Steam offer that arrives is your Steam client's job. Accept only offer `steamOfferId` that
gives exactly `steamAssetIds` and asks for nothing.

Run the SDK for a buying account anyway if you want a Steam trade reversal on your side proven: only a party that runs
the SDK proves one. Set `"steamWrites": false` so it never creates or cancels an offer for that account.

## Several Steam accounts

One SDK per Steam account, each with its own config, data volume, credentials and memory. The simplest layout is one
directory per account, each a copy of the [Quick start](#quick-start) directory, started as its own Compose project:

```bash
docker compose -p account-a -f account-a/compose.yaml up -d
docker compose -p account-b -f account-b/compose.yaml up -d
```

Every project has its own network namespace, so all of them keep port `8790`. Give each account its own management
secret. Budget 768 MB of memory per account.

## Troubleshooting

`GET /v1/health` lists the open problems; each clears by itself once its cause is gone. Grouped by what to do:

**Push or fix a credential:** `DMARKET_KEY_MISSING`, `DMARKET_AUTH_FAILED`, `DMARKET_KEY_ACCOUNT_CHANGED`,
`STEAM_TOKEN_MISSING`, `STEAM_TOKEN_EXPIRED`, `STEAM_TOKEN_EXPIRING`, `STEAM_WRONG_ACCOUNT`, `STEAM_SESSION_REJECTED`.

**Fix the host:** `CLOCK_SKEW` (sync the clock), `DMARKET_UNREACHABLE` and `STEAM_UNREACHABLE` (network),
`PROVER_MEMORY_LOW` and `PROVER_KILLED` (memory).

**Fix the account on DMarket:** `STEAM_NOT_LINKED`.

**Fix the config:** `STEAM_WRITES_DISABLED`, `PROVER_DISABLED`.

**Update the SDK:** `SDK_UPDATE_DUE`, `SDK_UPDATE_REQUIRED`.

**Waits by itself:** `STEAM_RATE_LIMITED`, `NOTARY_UNAVAILABLE`, `NOTARY_NOT_ADMITTED`, `PROOF_FAILED`,
`DIRECTIVE_FAILED`. Look closer only if one stays.

**Act now:** `STEAM_CANCEL_PENDING`: push a Steam token, and do not confirm that offer. `OFFER_ACCEPTED_AFTER_CANCEL`:
contact DMarket support with the deal id.

The full table is in [Health](#health).

## Verify what you run

Every release's image is signed by digest with [cosign](https://docs.sigstore.dev/cosign/) (3 or later), keyless
through Sigstore, by the CircleCI project that builds it. The **Verify** section of each
[GitHub Release](https://github.com/dmarket/p2p-sdk/releases) prints these commands with the exact signer and issuer:

```bash
cosign verify ghcr.io/dmarket/p2p-sdk:1.0.0-beta \
  --certificate-identity https://circleci.com/api/v2/projects/<project-id>/pipeline-definitions/<pipeline-definition-id> \
  --certificate-oidc-issuer https://oidc.circleci.com/org/<organization-id>
```

`cosign verify` prints the verified `docker-manifest-digest`. Pin the image to it, so what runs is what was verified:

```yaml
    image: ghcr.io/dmarket/p2p-sdk:1.0.0-beta@sha256:<the verified digest>
```

The Linux archives come with `SHA256SUMS` and its Sigstore bundle. Verify the list, then the archive:

```bash
cosign verify-blob SHA256SUMS --bundle SHA256SUMS.sigstore.json \
  --certificate-identity https://circleci.com/api/v2/projects/<project-id>/pipeline-definitions/<pipeline-definition-id> \
  --certificate-oidc-issuer https://oidc.circleci.com/org/<organization-id>
sha256sum -c SHA256SUMS --ignore-missing
```

## Install from the archive

Each release also ships a self-contained Linux archive per architecture,
`dmarket-p2p-sdk-<version>-linux-<amd64|arm64>.tar.gz`: Node.js (the version the image runs), the built SDK and its
production dependencies, nothing to install. [Verify it](#verify-what-you-run) first, then:

```bash
sudo tar -xzf dmarket-p2p-sdk-1.0.0-beta-linux-amd64.tar.gz -C /opt
sudo ln -sfn /opt/dmarket-p2p-sdk-1.0.0-beta-linux-amd64 /opt/dmarket-p2p-sdk
/opt/dmarket-p2p-sdk/bin/dmarket-p2p-sdk /etc/dmarket-p2p-sdk/config.json
```

Outside a container, keep `listenHost` at its default, `127.0.0.1`, and run your bot on the same host. Under systemd,
with a user of its own that owns `dataDir` and alone can read the config:

```ini
[Unit]
Description=DMarket P2P SDK
After=network-online.target
Wants=network-online.target

[Service]
User=dmarket-p2p
ExecStart=/opt/dmarket-p2p-sdk/bin/dmarket-p2p-sdk /etc/dmarket-p2p-sdk/config.json
Restart=on-failure
MemoryMax=768M
NoNewPrivileges=yes

[Install]
WantedBy=multi-user.target
```

`systemctl stop` sends `SIGTERM`: the SDK ends its prover processes and exits with code 0.

## Configuration

One JSON file, read once at start; its path is the first argument or `DMARKET_SDK_CONFIG`. An unknown key, a value
of the wrong type or one out of range stops the SDK with exit code 2 and the log line `config is invalid`; the error
names the key and never quotes its value.

| Key | Default | Allowed |
|---|---|---|
| `managementSecret` | required | at least 32 characters; the bearer of every management request |
| `dataDir` | required | not blank; each Steam account's loop state goes in an owner-only directory of its own under it |
| `listenHost` | `127.0.0.1` | the address the management API listens on |
| `listenPort` | `8790` | 1–65535 |
| `dmarketBaseUrl` | `https://api.dmarket.com` | the DMarket API |
| `steamWrites` | `true` | `false` creates and cancels no Steam offer, whatever DMarket asks: for an account that only buys |
| `prover.enabled` | `true` | `false` makes no proof, and without one no deal advances (see [Proofs](#proofs)) |
| `prover.notaryUrl` | `wss://api.dmarket.com/provenance/v1/` | a `ws://` or `wss://` URL |
| `prover.maxConcurrency` | `1` | 1–2 proofs at once |
| `prover.proofsPerChild` | `1` | 1–5 proofs per prover process before it is ended |
| `prover.threadCount` | `2` | 1–16 prover threads per process; each adds about 12 MB to a proof's memory peak |
| `prover.peakMemoryMb` | `640` | above 0; one proof's memory peak, for the start-up memory check |
| `prover.assetsDir` | `null` | where the prover's files are; the tracker library's own by default |

The config file holds the management secret: keep it readable by the SDK's user only. The data directory keeps each
account's loop state across restarts; no credential is written there.

## Management API

Three routes, each requiring `Authorization: Bearer <managementSecret>`. Your bot calls them from its own code; the
examples below use shell variables, and `printf` (a shell builtin) keeps the secrets out of the process list.

```bash
export SDK=http://127.0.0.1:8790 SDK_SECRET='<managementSecret>'
```

Push the DMarket Trading API key pair, hex: the 32-byte public key and the secret key as DMarket gives it (64 bytes),
or its 32-byte seed. Push it at every start, and again whenever you rotate the key.

```bash
printf '{"publicKey":"%s","secretKey":"%s"}' "$DMARKET_PUBLIC_KEY" "$DMARKET_SECRET_KEY" |
  curl -sS -i -X PUT "$SDK/v1/dmarket/key" -H "Authorization: Bearer $SDK_SECRET" --data-binary @-
```

Push the Steam access token: at every start, and with a fresh one before the held one expires.

```bash
printf '{"accessToken":"%s"}' "$STEAM_ACCESS_TOKEN" |
  curl -sS -i -X PUT "$SDK/v1/steam/session" -H "Authorization: Bearer $SDK_SECRET" --data-binary @-
```

Read the health (see [Health](#health)):

```bash
curl -sS -i "$SDK/v1/health" -H "Authorization: Bearer $SDK_SECRET"
```

| Status | When | `error` |
|---|---|---|
| `204` | a push is held | — |
| `200` | health, unless it is `down` | — |
| `400` | the body is not the JSON object the route takes | `INVALID_BODY` |
| `400` | the key pair is malformed, or DMarket refused it | `INVALID_KEY` |
| `400` | the token is not a Steam access token the SDK will hold: neither the `web` nor the `web:community` audience, a refresh token, expired | `INVALID_TOKEN` |
| `401` | no bearer, or the wrong one; checked before anything else | `UNAUTHORIZED` |
| `404` | no such route | `NOT_FOUND` |
| `405` | a method the route does not take | `METHOD_NOT_ALLOWED` |
| `409` | the key signs for another DMarket account; the held key stays | `DMARKET_KEY_ACCOUNT_CHANGED` |
| `409` | the token is for another Steam account than the one DMarket links; the held token stays | `STEAM_WRONG_ACCOUNT` |
| `413` | the body is over 16 KiB | `BODY_TOO_LARGE` |
| `500` | the request could not be handled | `INTERNAL` |
| `503` | a key other than the held one could not be checked with DMarket; the held key stays, push again | `DMARKET_UNREACHABLE`, or `CLOCK_SKEW` when this host's clock is off |
| `503` | health while it is `down` | — |

An error answers `{"error": "<code>", "reason": "<text>"}`. No answer, error or log line carries the secret key or the
Steam token. A request's log line records its method, route and status, never its body; a key line names the key's
`publicKey` and a token line its Steam account, so the log shows which key and account are held.

## Health

`GET /v1/health` right after a start, before any push (`503`, since it is `down`):

```json
{
  "status": "down",
  "problems": [
    {
      "code": "DMARKET_KEY_MISSING",
      "severity": "down",
      "since": "2026-10-23T18:16:23.455Z",
      "message": "push the Trading API key: PUT /v1/dmarket/key",
      "affectedDeals": []
    },
    {
      "code": "STEAM_TOKEN_MISSING",
      "severity": "degraded",
      "since": "2026-10-23T18:16:23.455Z",
      "message": "push a Steam access token: PUT /v1/steam/session",
      "affectedDeals": []
    }
  ],
  "steamTokenExpiresAt": null,
  "lastHeartbeatAt": null,
  "version": "1.0.0-beta",
  "libraryVersion": "1.1.0-beta"
}
```

`status` is the worst open problem: `down` (the SDK cannot heartbeat as the account, so DMarket counts it absent;
answered with `503`), `degraded` (it heartbeats, but some Steam work or proofs are blocked), or `ok` (no problem, or
`info` ones only). Each problem keeps the time it was first seen in `since`, and `affectedDeals` names the deals it
holds up, with their deadline when known. A problem clears by itself once its cause is gone.

| Code | Severity | What to do |
|---|---|---|
| `DMARKET_KEY_MISSING` | down | Push the Trading API key. |
| `DMARKET_KEY_ACCOUNT_CHANGED` | degraded | A key for another DMarket account was refused; the held key keeps working. To switch accounts, restart the SDK and push the new key. |
| `DMARKET_AUTH_FAILED` | down | DMarket refused the key (invalid, revoked or banned): push a valid one. |
| `CLOCK_SKEW` | down | This host's clock is more than a minute off DMarket's, and every signed request is refused: sync the clock. |
| `DMARKET_UNREACHABLE` | down | No heartbeat has come back for five minutes (network, timeouts or DMarket errors): check the network and `dmarketBaseUrl`. |
| `STEAM_NOT_LINKED` | down | The DMarket account has no Steam account linked: link one on DMarket. |
| `STEAM_TOKEN_MISSING` | degraded | Push a Steam access token. |
| `STEAM_TOKEN_EXPIRED` | degraded | Push a fresh token. |
| `STEAM_TOKEN_EXPIRING` | degraded | Under four hours left: push a fresh token. Under 30 minutes no offer is created and no proof starts. |
| `STEAM_WRONG_ACCOUNT` | degraded | The token is for another Steam account than the one DMarket links to this DMarket account: push a token for the linked one. |
| `STEAM_SESSION_REJECTED` | degraded | Steam refused the session (revoked, or logged out elsewhere): log in again and push the new token. |
| `STEAM_RATE_LIMITED` | degraded | Steam is throttling; the SDK backs off by itself. |
| `STEAM_UNREACHABLE` | degraded | Steam could not be read. Usually passes; check the network if it stays. |
| `SDK_UPDATE_REQUIRED` | degraded | The library is below DMarket's minimum version: update (see [Versions and updates](#versions-and-updates)). The deals in progress are still finished. |
| `SDK_UPDATE_DUE` | info | DMarket's minimum version moves above the library's at the time in `message`: update before then. |
| `NOTARY_UNAVAILABLE` | degraded | The notary cannot be reached or is busy; proofs back off and try again by themselves. Check the network and `prover.notaryUrl` if it stays. |
| `NOTARY_NOT_ADMITTED` | degraded | The notary did not admit the session; proofs wait a minute and try again. |
| `PROVER_KILLED` | degraded | A prover process ran out of memory or past its deadline. The SDK lives and proves again later; raise the memory limit if it repeats. |
| `PROVER_MEMORY_LOW` | degraded | Checked at start: the memory limit leaves less than `prover.peakMemoryMb` beside the SDK. Raise the limit to 768 MB or more. |
| `PROOF_FAILED` | degraded | A proof for a deal could not be made or delivered; `message` says why. |
| `DIRECTIVE_FAILED` | degraded | Creating or cancelling an offer failed (item gone, trade hold, a Steam error); `message` says which. |
| `STEAM_WRITES_DISABLED` | degraded | DMarket asks this SDK to create or cancel offers while `steamWrites` is `false`, and they go to another device. Set it to `true` on the account that sells. |
| `STEAM_CANCEL_PENDING` | degraded | DMarket asks to cancel an offer and there is no usable Steam token: push one. Until the cancel runs the offer stays open on Steam: do not confirm it. |
| `PROVER_DISABLED` | degraded | The prover is off or its files are missing, and every deal needs a proof: these deals do not advance until it is enabled. |
| `OFFER_ACCEPTED_AFTER_CANCEL` | degraded | An offer DMarket asked to cancel was accepted on Steam: the items changed hands after the deal was cancelled. Contact DMarket support with the deal id. |

Problem codes stay on this machine: none is sent to DMarket.

The SDK logs to stdout, one JSON object per line (`{"ts", "level", "msg", …}`). The first line is `sdk started` with
`version`, `libraryVersion` and `listen`.

## Proofs

Every deal needs proof that Steam really showed the status the SDK reports. The SDK reads that status from Steam
inside a TLS session that DMarket's notary attests (TLSNotary), and sends the proof with its report. A deal does not
advance on a report without one, so a selling account needs the prover on and the memory for it.

Proofs run in prover processes apart from the SDK: one is started for a proof and ended after `prover.proofsPerChild`
proofs. Measured in a container, one proof at the default two threads peaks at 510–610 MB of memory, takes 13–19 s of
CPU and 6–8 s of wall time; `prover.threadCount: 1` needs about 15 MB less and takes about 9 s. One proof runs at a
time by default; with `prover.maxConcurrency: 2`, give the container about 700 MB more. A prover process that has not
connected within 30 s, or is still proving 240 s after, is killed.

- **`PROVER_MEMORY_LOW`**: at start the SDK compares the container's memory limit (cgroup v2 or v1) with its own memory
  plus `prover.peakMemoryMb`. Under plain Docker an out-of-memory kill takes the prover process and the SDK lives; under
  Kubernetes it can take the whole container.
- **`PROVER_KILLED`**: a prover process ran out of memory or past its deadline. The SDK reports it and proves again
  later.
- **`prover.enabled: false`** makes no proof and needs no memory for one, so no deal advances: they show as
  `PROVER_DISABLED`, their decisive report is held back, and they wait until their deadline. Leave it on for any
  account that trades.

## Security

What the SDK never does:

- confirm or accept a trade: its only Steam writes are creating an offer and cancelling one, both on DMarket's request;
- generate Steam Guard codes, or read the `identity_secret` or `shared_secret`;
- send anything to Steam's mobile-confirmation endpoints (`mobileconf`);
- act on a trade offer that is not a DMarket deal's.

Where the Steam token goes: to Steam only. For a proof it travels inside the TLS session to Steam that the notary
attests: in TLSNotary the notary sees that session only encrypted, and the proof withholds the part of the request
that carries the token. The token is never sent to DMarket; DMarket requests are signed with the Trading API
key, whose secret half never leaves the SDK either.

Neither credential is written to disk, logged, or returned by the API or the health output. The logs carry public keys,
Steam ids and deal ids, never a secret.

**Keep the management API on loopback.** It accepts the Trading API key and the Steam token, and anyone who can reach
it with the secret can replace them. Share a network namespace with your bot (the [Quick start](#quick-start) layout),
or publish the port on the host's `127.0.0.1` only. To report a vulnerability, see [SECURITY.md](SECURITY.md).

## Versions and updates

Two versions matter: the SDK's own (`version`) and that of the `@dmarket/p2p-tracker-headless` library inside it
(`libraryVersion`). `GET /v1/health` answers both, and the `sdk started` log line carries both. On an image they are
the labels `org.opencontainers.image.version` and `com.dmarket.p2p-tracker-headless.version`:

```bash
docker inspect --format '{{ index .Config.Labels "com.dmarket.p2p-tracker-headless.version" }}' ghcr.io/dmarket/p2p-sdk:1.0.0-beta
```

**Image tags.** A release `X.Y.Z` is tagged `X.Y.Z`, `X.Y` and `latest`. A pre-release such as `1.0.0-beta` gets its
exact tag only, never `X.Y` or `latest`: pin it by that tag, or better by the digest you
[verified](#verify-what-you-run).

**Compatibility.** During the beta, a release may change the config file or the management API;
[CHANGELOG.md](CHANGELOG.md) says what changed. From `1.0.0` the SDK follows Semantic Versioning: an incompatible
change to the config file or the management API only in a major release.

**Updates DMarket requires.** DMarket sets a minimum version for the tracker library (`libraryVersion`), not for the
SDK, so an update can be required whatever the SDK's own version says. `SDK_UPDATE_DUE` (info) means the minimum is
about to move above `libraryVersion`; `SDK_UPDATE_REQUIRED` (degraded) means it already has, and the SDK keeps
finishing the deals it has. Either clears after an update to a release whose `libraryVersion` is at or above the
minimum: change the image tag in `compose.yaml` to the new release (and its verified digest), then
`docker compose up -d`; or install the newer archive.
Your bot pushes both credentials to the new SDK as after any restart.

## Running from source

Node.js 22 or newer.

```bash
git clone https://github.com/dmarket/p2p-sdk.git && cd p2p-sdk
npm ci && npm run build
node dist/main.js /path/to/config.json
```

Outside a container keep `listenHost` at its default, `127.0.0.1`. See [CONTRIBUTING.md](CONTRIBUTING.md) for
development and conventions.

## License

[MIT](LICENSE)
