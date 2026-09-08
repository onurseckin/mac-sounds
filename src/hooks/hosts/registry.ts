import type { HostId } from "../types.ts";
import { AntigravityAdapter } from "./antigravity.ts";
import type { HostAdapter } from "./adapter.ts";
import { ClaudeAdapter } from "./claude.ts";
import { CodexAdapter } from "./codex.ts";

// One instance per host is plenty -- adapters are stateless (every read
// hits disk fresh), so there's no reason to construct a new one per call.
const ADAPTERS: readonly HostAdapter[] = [
  new ClaudeAdapter(),
  new CodexAdapter(),
  new AntigravityAdapter(),
];

export function allAdapters(): HostAdapter[] {
  return [...ADAPTERS];
}

export function adapterFor(id: HostId): HostAdapter {
  const found = ADAPTERS.find((adapter) => adapter.id === id);
  if (!found) {
    // HostId is a closed union and ADAPTERS covers all of HOST_IDS, so this
    // only fires if the two ever drift out of sync with each other.
    throw new Error(`No host adapter registered for "${id}"`);
  }
  return found;
}
