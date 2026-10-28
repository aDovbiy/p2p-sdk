/**
 * An instant in the form every SDK output uses: ISO-8601 in UTC, `2026-06-16T12:00:00Z`, with the milliseconds only
 * when they are not zero (`2026-06-16T12:00:00.500Z`).
 */
export function isoInstant(epochMs: number): string {
  return new Date(epochMs).toISOString().replace(".000Z", "Z");
}
