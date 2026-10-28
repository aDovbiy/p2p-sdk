import { readFile } from "node:fs/promises";
import { join } from "node:path";

/** A cgroup v1 limit at or above this is "no limit" (the kernel writes a page-rounded `LONG_MAX`). */
const V1_UNLIMITED = 2 ** 62;

/**
 * The memory limit in bytes, from the text of cgroup v2's `memory.max` or, without it, v1's `memory.limit_in_bytes`.
 * `null` when neither names a limit.
 */
export function limitBytes(v2MemoryMax: string | null, v1LimitInBytes: string | null): number | null {
  if (v2MemoryMax !== null) {
    const text = v2MemoryMax.trim();
    return text === "max" ? null : bytes(text);
  }
  const v1 = v1LimitInBytes === null ? null : bytes(v1LimitInBytes.trim());
  return v1 !== null && v1 < V1_UNLIMITED ? v1 : null;
}

/**
 * `true` when `limit` leaves less than one proof's `peak` beside the SDK's `used`.
 *
 * Under plain Docker an out-of-memory kill takes the prover process and the SDK lives; under Kubernetes on cgroup v2
 * the whole container goes. Only headroom protects the SDK there, so the SDK reports `PROVER_MEMORY_LOW` at start when
 * this holds.
 */
export function isLow(limit: number | null, used: number, peak: number): boolean {
  return limit !== null && limit - used < peak;
}

/**
 * This process's cgroup memory limit: v2's `memory.max`, else v1's `memory.limit_in_bytes`, under `root`. `null` with
 * no limit, or where there is no cgroup filesystem (macOS, Windows).
 */
export async function cgroupMemoryLimit(root = "/sys/fs/cgroup"): Promise<number | null> {
  const v2 = await readText(join(root, "memory.max"));
  const v1 = v2 === null ? await readText(join(root, "memory", "memory.limit_in_bytes")) : null;
  return limitBytes(v2, v1);
}

/** This process's resident memory, in bytes. */
export function residentBytes(): number {
  return process.memoryUsage.rss();
}

function bytes(text: string): number | null {
  return /^\d+$/.test(text) ? Number(text) : null;
}

async function readText(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}
