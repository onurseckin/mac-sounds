import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { type Binding, type HooksConfig, type HostId, isHostId } from "./types.ts";

export function configDir(): string {
  return join(homedir(), ".config", "mac-sounds");
}

export function configPath(): string {
  return join(configDir(), "hooks.json");
}

function emptyConfig(): HooksConfig {
  return { version: 1, bindings: [] };
}

function isBinding(value: unknown): value is Binding {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.hostId === "string" &&
    isHostId(record.hostId) &&
    typeof record.eventId === "string" &&
    record.eventId.length > 0 &&
    typeof record.soundPath === "string" &&
    record.soundPath.length > 0 &&
    typeof record.enabled === "boolean"
  );
}

// The document arrives as `unknown` off disk -- it may have been hand-edited,
// written by an older/newer version of this tool, or simply corrupted. Rather
// than accept-or-reject the whole file, keep whatever bindings are still
// individually well-formed and drop the rest; one bad entry shouldn't cost
// the user every other binding they had configured.
function parseConfig(raw: unknown): HooksConfig {
  if (typeof raw !== "object" || raw === null) return emptyConfig();
  const record = raw as Record<string, unknown>;
  if (!Array.isArray(record.bindings)) return emptyConfig();
  return { version: 1, bindings: record.bindings.filter(isBinding) };
}

// This is called from the hook script mac-sounds installs into each host's
// event dispatch, which fires synchronously inside that host's own agent
// loop. Any exception raised here -- missing file, unreadable file, invalid
// JSON, a structurally wrong document -- would surface as an error in the
// *user's agent session*, not in mac-sounds, so every failure mode must
// degrade to an empty config instead of throwing.
export function loadConfig(): HooksConfig {
  try {
    const raw = readFileSync(configPath(), "utf8");
    const parsed: unknown = JSON.parse(raw);
    return parseConfig(parsed);
  } catch {
    return emptyConfig();
  }
}

// A hook can read hooks.json at any moment, independent of when mac-sounds
// last wrote it. Writing straight to the target path would let such a
// reader observe a truncated or partially-written file. Instead we write the
// full content to a temp file in the same directory (same filesystem, so the
// following rename is atomic under POSIX semantics) and rename it over the
// target -- readers only ever see the fully-old or fully-new content.
export function saveConfig(config: HooksConfig): void {
  const dir = configDir();
  mkdirSync(dir, { recursive: true });

  const tmpPath = join(dir, `.hooks.json.${process.pid}.${Date.now()}.tmp`);
  const json = `${JSON.stringify(config, null, 2)}\n`;
  writeFileSync(tmpPath, json, "utf8");
  renameSync(tmpPath, configPath());
}

export function getBinding(
  config: HooksConfig,
  hostId: HostId,
  eventId: string,
): Binding | undefined {
  return config.bindings.find(
    (binding) => binding.hostId === hostId && binding.eventId === eventId,
  );
}

export function upsertBinding(config: HooksConfig, binding: Binding): HooksConfig {
  const rest = config.bindings.filter(
    (existing) => !(existing.hostId === binding.hostId && existing.eventId === binding.eventId),
  );
  return { version: 1, bindings: [...rest, binding] };
}

export function removeBinding(config: HooksConfig, hostId: HostId, eventId: string): HooksConfig {
  return {
    version: 1,
    bindings: config.bindings.filter(
      (existing) => !(existing.hostId === hostId && existing.eventId === eventId),
    ),
  };
}

export function setEnabled(
  config: HooksConfig,
  hostId: HostId,
  eventId: string,
  enabled: boolean,
): HooksConfig {
  return {
    version: 1,
    bindings: config.bindings.map((existing) =>
      existing.hostId === hostId && existing.eventId === eventId
        ? { ...existing, enabled }
        : existing,
    ),
  };
}

export function bindingsForHost(config: HooksConfig, hostId: HostId): Binding[] {
  return config.bindings.filter((binding) => binding.hostId === hostId);
}
