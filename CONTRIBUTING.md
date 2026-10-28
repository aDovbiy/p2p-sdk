# Contributing

This repository is the published source of the DMarket P2P SDK: each commit is a release, and development happens
elsewhere. **Pull requests are not accepted**, and pushes to this repository are blocked.

- **Bugs and questions:** contact DMarket through your usual support channel. Include the SDK version
  (`version` in `GET /v1/health`), the tracker library version (`libraryVersion`) and the log lines around the problem,
  with credentials removed.
- **Security issues:** follow the [Security Policy](SECURITY.md); do not report them in public.

By participating you agree to abide by our [Code of Conduct](CODE_OF_CONDUCT.md).

## Build & test

You are free to build and run the SDK from this source. You need Node.js 22 or newer ([`.nvmrc`](.nvmrc) names the
development line) and npm.

```bash
npm ci              # install exactly what package-lock.json pins
npm run lint        # ESLint with typescript-eslint's strict type-checked rules
npm run typecheck   # tsc --noEmit over sources and tests
npm run build       # compile src/ without tests to dist/
npm test            # compile src/ with tests to dist-test/ and run them with node --test
```

## Releases

Each release is one commit here, tagged `vX.Y.Z` (or `vX.Y.Z-<pre>` for a pre-release such as `beta` or `rc.1`), with
a GitHub Release that carries the notes, the Linux archives, `SHA256SUMS` and its Sigstore bundle. The container image
is `ghcr.io/dmarket/p2p-sdk`, tagged `X.Y.Z`, `X.Y` and `latest` for a stable version and `X.Y.Z-<pre>` alone for a
pre-release. The image and the archives are signed keyless with Sigstore; the **Verify** section of each Release
gives the commands that check them.

Security fixes are made against the latest stable version only. A fix in the tracker library reaches traders as a new
SDK release. Changes are listed in [`CHANGELOG.md`](CHANGELOG.md).
