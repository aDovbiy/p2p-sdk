# Third-party notices

This project is licensed under the [MIT License](LICENSE). Its container image additionally **redistributes** the
third-party software below, each under its own license. The image carries this file and `LICENSE` in `/app`.

| Component | Where in the image | License |
|---|---|---|
| Node.js 22 and the Debian slim system it runs on, from the official `node` image (pinned by digest in the `Dockerfile`) | the base image | Node.js: MIT, with the licenses of its bundled dependencies in the Node.js distribution's `LICENSE`; Debian packages: each its own, listed under `/usr/share/doc/*/copyright` |
| [`@dmarket/p2p-tracker-headless`](https://www.npmjs.com/package/@dmarket/p2p-tracker-headless), the tracker library (exact version in `package-lock.json`) | `/app/node_modules/@dmarket/p2p-tracker-headless` | MIT |
| The TLSNotary prover WebAssembly and its transport, shipped inside that library (`pkg/`, `transport/`, `VERSION`) | the same directory | `Apache-2.0 OR MIT`; provenance, integrity and license texts in the library's [third-party notices](https://github.com/dmarket/p2p-tracker-core/blob/main/THIRD_PARTY_NOTICES.md) |
| [`ws`](https://www.npmjs.com/package/ws), a dependency of that library | `/app/node_modules/ws` | MIT |

The image holds no other npm package: development dependencies are pruned before it is assembled.
