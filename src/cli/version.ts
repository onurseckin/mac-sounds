import { readFileSync } from "node:fs";

interface PackageManifest {
  version: string;
}

// package.json is an untyped boundary (JSON.parse returns `unknown` here, not
// `any`, because the variable it's assigned to is annotated `unknown`) --
// this guard is what turns that into a typed, verified `PackageManifest`.
function isPackageManifest(value: unknown): value is PackageManifest {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { version?: unknown }).version === "string"
  );
}

export function readVersion(): string {
  // Two levels up from src/cli/ to the package root.
  const packageUrl = new URL("../../package.json", import.meta.url);
  const raw: unknown = JSON.parse(readFileSync(packageUrl, "utf8"));
  if (!isPackageManifest(raw)) {
    throw new Error(`${packageUrl.pathname} is missing a string "version" field`);
  }
  return raw.version;
}
