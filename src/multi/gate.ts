import { rm } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";

/**
 * The process-wide limit on proofs at once, across every account. Each prover process connects to this Unix socket
 * before it loads anything (see `prover-preload.ts`) and gets `go` when a slot is free, first come first served; its
 * slot is freed when its connection closes, which is when the process exits.
 */
export class ProverGate {
  readonly #server: Server;
  readonly #queue: Socket[] = [];
  #active = 0;

  private constructor(
    readonly path: string,
    readonly capacity: number,
  ) {
    this.#server = createServer((socket) => {
      socket.on("error", () => socket.destroy());
      this.#queue.push(socket);
      let admitted = false;
      socket.once("close", () => {
        const queued = this.#queue.indexOf(socket);
        if (queued !== -1) this.#queue.splice(queued, 1);
        if (admitted) {
          this.#active -= 1;
          this.#admit();
        }
      });
      socket.once("admitted", () => (admitted = true));
      this.#admit();
    });
  }

  static async open(path: string, capacity: number): Promise<ProverGate> {
    await rm(path, { force: true });
    const gate = new ProverGate(path, capacity);
    await new Promise<void>((resolve, reject) => {
      gate.#server.once("error", reject);
      gate.#server.listen(path, () => { resolve(); });
    });
    return gate;
  }

  stats(): { active: number; queued: number; capacity: number } {
    return { active: this.#active, queued: this.#queue.length, capacity: this.capacity };
  }

  close(): void {
    this.#server.close();
  }

  #admit(): void {
    while (this.#active < this.capacity && this.#queue.length > 0) {
      const next = this.#queue.shift();
      if (next === undefined || next.destroyed) continue;
      this.#active += 1;
      next.emit("admitted");
      next.write("go\n");
    }
  }
}
