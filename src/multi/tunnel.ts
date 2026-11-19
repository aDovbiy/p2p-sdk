import { createConnection, type Socket } from "node:net";
import { Duplex } from "node:stream";

/** An HTTP proxy that tunnels with CONNECT. Credentials stay in `authorization` and never reach a log. */
export interface HttpProxy {
  readonly host: string;
  readonly port: number;
  /** `Basic …` for `Proxy-Authorization`, or `null` without credentials. */
  readonly authorization: string | null;
}

/** Parses `http://[user:pass@]host:port`. The error names the problem and never quotes the URL, which may hold a password. */
export function parseProxy(url: string): HttpProxy {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("proxy is not a URL");
  }
  if (parsed.protocol !== "http:") throw new Error("proxy must be an http:// URL (CONNECT proxy)");
  if (parsed.hostname === "") throw new Error("proxy has no host");
  const port = parsed.port === "" ? 80 : Number(parsed.port);
  const user = decodeURIComponent(parsed.username);
  const pass = decodeURIComponent(parsed.password);
  const authorization =
    user === "" && pass === "" ? null : `Basic ${Buffer.from(`${user}:${pass}`, "utf8").toString("base64")}`;
  return { host: parsed.hostname.replace(/^\[|\]$/g, ""), port, authorization };
}

type Connect = (options: { host: string; port: number }) => Socket;

const MAX_RESPONSE_HEAD = 16 * 1024;

/**
 * A stream to `host:port` through `proxy`'s CONNECT tunnel, returned at once like `net.createConnection`'s socket:
 * it emits `connect` once the proxy answered 200, buffers writes until then, and fails with an error that names the
 * proxy's status, never its address or credentials.
 */
export class TunnelSocket extends Duplex {
  readonly #raw: Socket;
  #ready = false;
  readonly #pending: { chunk: Buffer; callback: (error?: Error | null) => void }[] = [];
  connecting = true;

  constructor(proxy: HttpProxy, host: string, port: number, connect: Connect = createConnection) {
    super({ allowHalfOpen: true });
    const raw = connect({ host: proxy.host, port: proxy.port });
    this.#raw = raw;
    raw.setNoDelay(true);
    const target = `${host.includes(":") ? `[${host}]` : host}:${String(port)}`;
    raw.once("connect", () => {
      const auth = proxy.authorization === null ? "" : `Proxy-Authorization: ${proxy.authorization}\r\n`;
      raw.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n${auth}\r\n`);
    });
    let head = Buffer.alloc(0);
    const onHead = (chunk: Buffer) => {
      head = Buffer.concat([head, chunk]);
      const end = head.indexOf("\r\n\r\n");
      if (end === -1) {
        if (head.length > MAX_RESPONSE_HEAD) this.destroy(new Error("proxy answered no HTTP head"));
        return;
      }
      raw.off("data", onHead);
      const status = /^HTTP\/1\.[01] (\d{3})/.exec(head.subarray(0, end).toString("latin1"))?.[1];
      if (status !== "200") {
        this.destroy(new Error(`proxy refused the tunnel: HTTP ${status ?? "?"}`));
        return;
      }
      const rest = head.subarray(end + 4);
      raw.on("data", (data: Buffer) => {
        if (!this.push(data)) raw.pause();
      });
      raw.once("end", () => this.push(null));
      this.#ready = true;
      this.connecting = false;
      for (const { chunk, callback } of this.#pending.splice(0)) raw.write(chunk, callback);
      if (rest.length > 0) this.push(rest);
      this.emit("connect");
    };
    raw.on("data", onHead);
    raw.on("error", (error) => this.destroy(error));
    raw.once("close", () => {
      if (!this.destroyed && !this.#ready) this.destroy(new Error("proxy closed the connection"));
    });
  }

  override _read(): void {
    this.#raw.resume();
  }

  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    if (this.#ready) this.#raw.write(chunk, callback);
    else this.#pending.push({ chunk, callback });
  }

  override _final(callback: (error?: Error | null) => void): void {
    this.#raw.end(callback);
  }

  override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    this.#raw.destroy();
    callback(error);
  }

  // The parts of net.Socket's surface that TLS and ws touch on the stream they are given.
  setNoDelay(): this {
    return this;
  }
  setKeepAlive(enable?: boolean, delay?: number): this {
    this.#raw.setKeepAlive(enable, delay);
    return this;
  }
  setTimeout(ms: number, callback?: () => void): this {
    this.#raw.setTimeout(ms, callback);
    return this;
  }
  ref(): this {
    this.#raw.ref();
    return this;
  }
  unref(): this {
    this.#raw.unref();
    return this;
  }
}
