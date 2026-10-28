# Security Policy

The SDK receives a DMarket Trading API key and a Steam session token from its operator and runs a tracker that
creates and cancels real Steam trade offers, so we take security seriously and welcome reports.

## Reporting a vulnerability

**Please do not report security issues through public GitHub issues, pull requests, or discussions.**

Instead, use GitHub's private vulnerability reporting:

1. Go to the repository's **Security** tab.
2. Click **Report a vulnerability** (under *Advisories*).
3. Fill in the form with the details below.

This opens a private advisory visible only to you and the maintainers.

Please include, where possible:

- A description of the issue and its impact.
- The affected version(s) or commit.
- Steps to reproduce, or a proof of concept.
- Any suggested remediation.

We will acknowledge your report, keep you updated on our assessment, and coordinate a fix and
disclosure timeline with you. Please give us a reasonable opportunity to address the issue before any
public disclosure.

## Supported versions

The SDK is released as a container image. Security fixes are made against the **latest stable image** only; there
are no back-ports to older lines. A fix in the tracker library reaches traders as a new SDK image: see
[CONTRIBUTING.md](CONTRIBUTING.md#releases).

## Security model & scope

The SDK is built around the following boundaries. Reports demonstrating that any of them can be crossed are
especially valuable:

- **Credentials stay inside the tracker library.** The SDK passes the Trading API key and the Steam token to the
  library and never stores, logs or returns them: not in health output, management API responses or error messages,
  and not on disk.
- **The management API is local and authenticated.** It listens on the loopback interface unless configured
  otherwise, and every route requires the operator's bearer secret.
- **The Steam token is never sent to DMarket.** It is used for Steam requests only. For a proof it travels inside
  the TLS session to Steam that the notary attests, which the notary sees only encrypted, and the proof withholds the
  part of the request that carries it.
- **Only two Steam write actions exist: create and cancel a trade offer.** Nothing confirms or accepts trades.
- **No Steam Guard / mobile-authenticator handling.** The SDK never generates authenticator codes, never reads the
  identity/shared secrets, and never calls Steam mobile-confirmation endpoints. The user confirms trades themselves,
  outside the SDK.
- **Non-DMarket trade offers are never annotated or acted on.**
