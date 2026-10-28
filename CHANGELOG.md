# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html), and commit messages follow
[Conventional Commits](https://www.conventionalcommits.org/).

## [Unreleased]

## [1.0.0-beta] - 2026-10-28

### Added

- Source code at [github.com/dmarket/p2p-sdk](https://github.com/dmarket/p2p-sdk): one commit, tag and GitHub Release
  per released version, with the same notes and signed files as the release itself.
- Built on the tracker library `@dmarket/p2p-tracker-headless` 1.1.0-beta
  ([release notes](https://github.com/dmarket/p2p-tracker-core/releases/tag/v1.1.0-beta)): among its fixes, a Trading
  API key is sent in the case it was pushed in, a cancel Steam did not confirm is no longer reported as done, and
  `libraryVersion` in health reports the library's real version.
- Project setup: TypeScript build, lint and tests, with CI on Node 22 and 24.
- A guide to running the SDK next to a trading bot: Docker and source runs, the config file, the management API,
  health codes, proofs, security, updates and versions.
- Container image for `linux/amd64` and `linux/arm64`: Node 22 slim pinned by digest, a non-root user, `/data` for
  the loop state, labels with the SDK's and the tracker library's versions. CircleCI builds and smoke-tests it on
  every branch and pushes it to `ghcr.io/dmarket/p2p-sdk` from an approved release branch; a stable release
  also gets its git tag and a GitHub Release.
- Dependabot for the tracker library, the development tools and the image's base.
- Signed releases: the image is signed by digest with cosign, keyless through Sigstore, and a stable release's GitHub
  Release carries Linux archives for `amd64` and `arm64` (Node.js pinned to the image's version, the built SDK and its
  production dependencies, ready to run), their `SHA256SUMS` and its Sigstore bundle.
- A reference Compose file (`examples/compose.yaml`) where the SDK and the bot share a network namespace held by a
  container of its own, so a restart of either keeps the other's network, and an example seller bot
  (`examples/seller.mjs`, no dependencies) that pushes both credentials after every SDK restart and accepts deals.
- The README leads with a trader's path: how the parts fit, prerequisites, a Quick start, the bot's duties, selling,
  buying, several accounts, troubleshooting by action, verifying signatures and installing from the archive.
- Pre-release versions (`X.Y.Z-beta`, `X.Y.Z-rc.1`): released from `release/vX.Y.Z-<pre>` like a stable version, but
  the image gets only its exact tag, never `X.Y` or `latest`, and the GitHub Release is marked a pre-release.

[Unreleased]: https://github.com/dmarket/p2p-sdk/compare/v1.0.0-beta...main
[1.0.0-beta]: https://github.com/dmarket/p2p-sdk/releases/tag/v1.0.0-beta
