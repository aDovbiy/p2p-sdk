/**
 * Loaded with `--import` into every prover process an account's worker forks (see `account-worker.ts`).
 *
 * 1. Waits for a slot at the process-wide prover gate (`P2P_PROVER_GATE`, a Unix socket), so no more than the
 *    configured number of proofs run at once across all accounts. The slot is held until this process exits.
 * 2. Sends every outbound TCP and TLS connection through the account's proxy (`P2P_PROXY_URL`): the Steam session the
 *    notary attests (`net.createConnection` in the tracker's transport) and the notary's WebSocket (`ws` →
 *    `tls.connect`). The library's own prover code is left as it is.
 */
import { syncBuiltinESMExports } from "node:module";
import net from "node:net";
import tls from "node:tls";

import { parseProxy, TunnelSocket } from "./tunnel.js";

const originalConnect = net.createConnection.bind(net);
const originalTls = tls.connect.bind(tls);

const gate = process.env.P2P_PROVER_GATE;
if (gate !== undefined && gate !== "") {
  await new Promise<void>((resolve, reject) => {
    const slot = originalConnect({ path: gate });
    slot.once("data", (data: Buffer) => {
      if (data.toString("latin1").startsWith("go")) {
        // Held open, without keeping the process alive: the gate frees the slot when this process exits.
        slot.unref();
        resolve();
      }
    });
    slot.once("error", reject);
  });
}

const proxyUrl = process.env.P2P_PROXY_URL;
if (proxyUrl !== undefined && proxyUrl !== "") {
  const proxy = parseProxy(proxyUrl);

  type AnyArgs = unknown[];
  const target = (args: AnyArgs): { host: string; port: number; options: Record<string, unknown>; cb?: () => void } | null => {
    const cb = typeof args[args.length - 1] === "function" ? (args[args.length - 1] as () => void) : undefined;
    const first = args[0];
    if (typeof first === "object" && first !== null) {
      const o = first as Record<string, unknown>;
      if (typeof o.path === "string" || o.socket !== undefined) return null;
      return { host: typeof o.host === "string" ? o.host : "localhost", port: Number(o.port), options: o, ...(cb ? { cb } : {}) };
    }
    if (typeof first === "number" || (typeof first === "string" && /^\d+$/.test(first))) {
      const host = typeof args[1] === "string" ? args[1] : "localhost";
      const extra = typeof args[2] === "object" && args[2] !== null ? (args[2] as Record<string, unknown>) : {};
      return { host, port: Number(first), options: { ...extra, host, port: Number(first) }, ...(cb ? { cb } : {}) };
    }
    return null; // a pipe path
  };

  const tunnelled = (...args: AnyArgs) => {
    const t = target(args);
    if (t === null) return (originalConnect as (...a: AnyArgs) => net.Socket)(...args);
    const socket = new TunnelSocket(proxy, t.host, t.port, originalConnect);
    if (t.cb) socket.once("connect", t.cb);
    return socket as unknown as net.Socket;
  };
  net.createConnection = tunnelled;
  net.connect = tunnelled;

  tls.connect = ((...args: AnyArgs) => {
    const t = target(args);
    if (t === null) return (originalTls as (...a: AnyArgs) => tls.TLSSocket)(...args);
    const servername = typeof t.options.servername === "string" ? t.options.servername : net.isIP(t.host) ? undefined : t.host;
    const socket = new TunnelSocket(proxy, t.host, t.port, originalConnect);
    const options = { ...t.options, socket, ...(servername === undefined ? {} : { servername }) };
    return t.cb ? originalTls(options as tls.ConnectionOptions, t.cb) : originalTls(options as tls.ConnectionOptions);
  });

  // The transport imports `createConnection` by name, after this runs: let ES module imports see the wrapper too.
  syncBuiltinESMExports();
}
