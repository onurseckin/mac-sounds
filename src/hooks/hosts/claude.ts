import { homedir } from "node:os";
import { join } from "node:path";
import type { HookEvent, HostId } from "../types.ts";
import {
  buildCommand,
  type Conflict,
  type HostAdapter,
  HostConflictError,
  type InstallOptions,
  isOwnCommand,
} from "./adapter.ts";
import {
  backupOnce,
  hostRootExists,
  isRecord,
  readJsonSidecar,
  readTextFileIfExists,
  stringifyJsonAscii,
  writeFileAtomic,
  writeJsonSidecar,
} from "./fs-utils.ts";

const HOST_ID: HostId = "claude";

const EVENTS: readonly HookEvent[] = [
  {
    id: "stop",
    label: "Stop",
    description: "Fires when Claude finishes responding and is about to stop.",
  },
  {
    id: "stop-failure",
    label: "StopFailure",
    description: "Fires when a turn ends in an error (rate limit, overload, auth failure, ...).",
  },
  {
    id: "subagent-stop",
    label: "SubagentStop",
    description: "Fires when a subagent finishes and is about to stop.",
  },
  {
    id: "session-start",
    label: "SessionStart",
    description: "Fires when a session starts, resumes, is cleared, compacted, or forked.",
  },
  {
    id: "notification",
    label: "Notification",
    description: "Fires on a Claude Code notification (permission prompt, idle prompt, ...).",
  },
];

// The real event name Claude Code expects under `hooks.<EventName>` -- kept
// separate from HookEvent.id (our own stable lowercase id used in the CLI
// and the bindings file) so this wire-format name never leaks elsewhere.
const EVENT_NAME: Readonly<Record<string, string>> = {
  stop: "Stop",
  "stop-failure": "StopFailure",
  "subagent-stop": "SubagentStop",
  "session-start": "SessionStart",
  notification: "Notification",
};

// Foreign hook-group objects a force-install displaced, keyed by our own
// event id, so uninstall() can put them back. Kept in a *sidecar* file next
// to settings.json rather than inside it: settings.json is the user's whole
// Claude configuration and the brief for this adapter says to touch only
// `hooks.<Event>` arrays -- inventing a new reserved top-level key here to
// store bookkeeping would violate that, and risks an unrecognised key
// upsetting whatever validation Claude Code applies when it loads its own
// settings.
type DisplacedStore = Record<string, unknown[]>;

function isDisplacedStore(value: unknown): value is DisplacedStore {
  if (!isRecord(value)) return false;
  return Object.values(value).every((entry) => Array.isArray(entry));
}

function isCommandEntry(value: unknown): value is { command: string } {
  return isRecord(value) && typeof value.command === "string";
}

function groupCommands(group: unknown): string[] {
  if (!isRecord(group)) return [];
  const hooksField = group.hooks;
  if (!Array.isArray(hooksField)) return [];
  return hooksField.filter(isCommandEntry).map((entry) => entry.command);
}

function isOwnGroup(group: unknown): boolean {
  return groupCommands(group).some(isOwnCommand);
}

function buildOwnGroup(shimPath: string, eventId: string): Record<string, unknown> {
  // No `matcher`: per the verified brief only Stop truly lacks matcher
  // support, but StopFailure/SubagentStop/SessionStart/Notification all
  // treat an absent matcher as "no filter" (the existing live Stop/
  // StopFailure entries on this machine already rely on exactly that), and
  // we want the sound to fire on every occurrence regardless of event.
  return {
    hooks: [{ type: "command", command: buildCommand(shimPath, HOST_ID, eventId) }],
  };
}

export class ClaudeAdapter implements HostAdapter {
  readonly id = HOST_ID;
  readonly label = "Claude Code";
  readonly events = EVENTS;

  configPath(): string {
    return process.env.MAC_SOUNDS_CLAUDE_CONFIG ?? join(homedir(), ".claude", "settings.json");
  }

  isInstalled(): boolean {
    return hostRootExists(".claude");
  }

  installedEventIds(): string[] {
    const settings = this.readSettingsSafe();
    return this.events
      .filter((event) => this.rawEventArray(settings, event.id).some(isOwnGroup))
      .map((event) => event.id);
  }

  conflicts(): Conflict[] {
    return this.conflictsForEventIds(this.events.map((event) => event.id));
  }

  stdoutFor(_eventId: string): string {
    // Per the verified brief: Stop/SubagentStop stdout+exit-code are LIVE
    // control signals -- a `{"decision":"block",...}` payload, or exit code
    // 2 with non-empty stderr, prevents the agent from stopping -- and
    // SessionStart's stdout is injected straight into the model's context
    // (parsed as JSON if it looks like an object, otherwise added as plain
    // text). There is no event in this adapter's list where printing
    // anything is both safe *and* useful, so every event gets "": the shim
    // must stay completely inert on stdout for every Claude event, full
    // stop. This is the single most important safety property of this file
    // -- getting it wrong risks hanging the user's agent loop on every turn,
    // or polluting every session's context.
    return "";
  }

  install(options: InstallOptions): void {
    const requested = this.events.filter((event) => options.eventIds.includes(event.id));
    if (requested.length === 0) return;

    const conflicts = this.conflictsForEventIds(requested.map((event) => event.id));
    if (conflicts.length > 0 && !options.force) {
      throw new HostConflictError(conflicts);
    }

    const path = this.configPath();
    const settings = this.readSettingsForWrite(path);
    const hooksRecord = isRecord(settings.hooks) ? { ...settings.hooks } : {};
    const sidecarPath = this.sidecarPath(path);
    const sidecarRaw = readJsonSidecar(sidecarPath);
    const sidecar: DisplacedStore = isDisplacedStore(sidecarRaw) ? { ...sidecarRaw } : {};

    for (const event of requested) {
      const eventName = EVENT_NAME[event.id];
      if (!eventName) continue;
      const existing = this.rawEventArray(settings, event.id);
      const foreign = existing.filter((group) => !isOwnGroup(group));

      if (options.force) {
        // Only stash when something is actually being displaced right now --
        // a repeat force-install has nothing foreign left (it was already
        // removed last time), and must not clobber the original stash with
        // an empty one.
        if (foreign.length > 0) sidecar[event.id] = foreign;
        hooksRecord[eventName] = [buildOwnGroup(options.shimPath, event.id)];
      } else {
        hooksRecord[eventName] = [...foreign, buildOwnGroup(options.shimPath, event.id)];
      }
    }

    backupOnce(path);
    writeJsonSidecar(sidecarPath, sidecar);
    this.writeSettings(path, { ...settings, hooks: hooksRecord });
  }

  uninstall(): void {
    const path = this.configPath();
    const settings = this.readSettingsForWrite(path);
    if (!isRecord(settings.hooks)) return;

    const sidecarPath = this.sidecarPath(path);
    const sidecarRaw = readJsonSidecar(sidecarPath);
    const sidecar: DisplacedStore = isDisplacedStore(sidecarRaw) ? { ...sidecarRaw } : {};
    const hooksRecord = { ...settings.hooks };
    let touched = false;

    for (const event of this.events) {
      const eventName = EVENT_NAME[event.id];
      if (!eventName) continue;
      const existing = this.rawEventArray(settings, event.id);
      const hasOwnEntry = existing.some(isOwnGroup);
      const hasSidecarEntry = sidecar[event.id] !== undefined;
      // A foreign entry merely *existing* here (nothing of ours installed,
      // nothing of ours ever displaced it) isn't something uninstall should
      // touch at all -- skip it so a never-installed event never triggers a
      // write, matching install()'s own "leave it alone unless we own it or
      // displaced it" rule.
      if (!hasOwnEntry && !hasSidecarEntry) continue;

      touched = true;
      const remaining = existing.filter((group) => !isOwnGroup(group));
      const restored = sidecar[event.id] ?? [];
      const nextArray = [...restored, ...remaining];

      if (nextArray.length === 0) {
        delete hooksRecord[eventName];
      } else {
        hooksRecord[eventName] = nextArray;
      }
      delete sidecar[event.id];
    }

    if (!touched) return;

    backupOnce(path);
    writeJsonSidecar(sidecarPath, sidecar);

    const nextSettings = { ...settings };
    if (Object.keys(hooksRecord).length === 0) {
      delete nextSettings.hooks;
    } else {
      nextSettings.hooks = hooksRecord;
    }
    this.writeSettings(path, nextSettings);
  }

  private sidecarPath(configPath: string): string {
    return `${configPath}.mac-sounds-displaced.json`;
  }

  private conflictsForEventIds(eventIds: string[]): Conflict[] {
    const settings = this.readSettingsSafe();
    const found: Conflict[] = [];
    for (const event of this.events) {
      if (!eventIds.includes(event.id)) continue;
      for (const group of this.rawEventArray(settings, event.id)) {
        for (const command of groupCommands(group)) {
          if (!isOwnCommand(command)) found.push({ eventId: event.id, command });
        }
      }
    }
    return found;
  }

  private rawEventArray(settings: Record<string, unknown>, eventId: string): unknown[] {
    const eventName = EVENT_NAME[eventId];
    if (!eventName) return [];
    if (!isRecord(settings.hooks)) return [];
    const arr = settings.hooks[eventName];
    return Array.isArray(arr) ? arr : [];
  }

  // Used by every read-only introspection method (isInstalled indirectly,
  // installedEventIds, conflicts): a missing or unparseable settings.json
  // must never throw, or a plain status check would crash the CLI.
  private readSettingsSafe(): Record<string, unknown> {
    const raw = readTextFileIfExists(this.configPath());
    if (raw === undefined) return {};
    try {
      const parsed: unknown = JSON.parse(raw);
      return isRecord(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }

  // Only called right before a write. If the file exists but isn't valid
  // JSON, we cannot honestly claim to "preserve every other key" while
  // writing -- there's no structure left to preserve. Refusing loudly beats
  // silently discarding whatever was in the broken file: correctness and
  // non-destructiveness matter more here than tolerating a corrupt input.
  private readSettingsForWrite(path: string): Record<string, unknown> {
    const raw = readTextFileIfExists(path);
    if (raw === undefined) return {};
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw new Error(
        `Refusing to modify ${path}: it is not valid JSON (${String(error)}). ` +
          "Fix or remove it by hand, then retry -- mac-sounds will not overwrite content it can't safely round-trip.",
        { cause: error },
      );
    }
    if (!isRecord(parsed)) {
      throw new Error(`Refusing to modify ${path}: expected a JSON object at the top level.`);
    }
    return parsed;
  }

  private writeSettings(path: string, settings: Record<string, unknown>): void {
    writeFileAtomic(path, `${stringifyJsonAscii(settings, 2)}\n`);
  }
}
