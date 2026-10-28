import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import { MAX_BODY_BYTES, type ApiResponse, type ManagementApi } from "./api.js";
import type { Log } from "./log.js";

const TOO_LARGE: ApiResponse = {
  status: 413,
  body: JSON.stringify({ error: "BODY_TOO_LARGE", reason: "the body exceeds the limit" }),
};
const INTERNAL: ApiResponse = {
  status: 500,
  body: JSON.stringify({ error: "INTERNAL", reason: "the request could not be handled" }),
};

/**
 * The management API's listener over `node:http`. Reads at most `MAX_BODY_BYTES` of body, hands the request to the
 * API, and writes its answer. Logs the method, the route and the status of each request: never a header value or a
 * body, both of which carry secrets.
 */
export class ManagementServer {
  #server: Server | null = null;

  constructor(
    private readonly api: ManagementApi,
    private readonly log: Log,
  ) {}

  async listen(host: string, port: number): Promise<void> {
    const server = createServer((request, response) => {
      this.#serve(request, response);
    });
    this.#server = server;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, host, () => {
        server.off("error", reject);
        resolve();
      });
    });
  }

  /** The port actually bound: the one asked for, or the one the OS picked for `0`. */
  boundPort(): number {
    const address = this.#server?.address();
    if (typeof address !== "object" || address === null) throw new Error("the server is not listening");
    return address.port;
  }

  /** Stops accepting connections; requests in flight are not waited for. */
  close(): void {
    this.#server?.close();
  }

  #serve(request: IncomingMessage, response: ServerResponse): void {
    const method = request.method ?? "";
    const route = (request.url ?? "").split("?")[0] ?? "";
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    request.on("data", (chunk: Buffer) => {
      if (tooLarge) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        tooLarge = true;
        write(response, TOO_LARGE);
        request.destroy();
      } else {
        chunks.push(chunk);
      }
    });
    request.on("end", () => {
      if (tooLarge) return;
      const body = Buffer.concat(chunks).toString("utf8");
      void this.#answer(method, route, request.headers.authorization, body, response);
    });
  }

  async #answer(
    method: string,
    route: string,
    authorization: string | undefined,
    body: string,
    response: ServerResponse,
  ): Promise<void> {
    let answer: ApiResponse;
    try {
      answer = await this.api.handle(method, route, authorization, body);
    } catch {
      // The error may quote what was pushed: none of it is answered or logged.
      answer = INTERNAL;
    }
    write(response, answer);
    this.log.info("management request", { method, route, status: String(answer.status) });
  }
}

function write(response: ServerResponse, answer: ApiResponse): void {
  response.writeHead(answer.status, { "content-type": "application/json", "cache-control": "no-store" });
  response.end(answer.body);
}
