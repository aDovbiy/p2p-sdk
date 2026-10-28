import { readFileSync } from "node:fs";

let cached: string | undefined;

/** The SDK's own version: `version` from this package's `package.json`. */
export function sdkVersion(): string {
  cached ??= readVersion();
  return cached;
}

function readVersion(): string {
  // dist/version.js -> ../package.json is the package root.
  const manifest: unknown = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  if (
    typeof manifest === "object" &&
    manifest !== null &&
    "version" in manifest &&
    typeof manifest.version === "string"
  ) {
    return manifest.version;
  }
  throw new Error("package.json has no version string");
}
