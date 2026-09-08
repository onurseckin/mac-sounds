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

const HOST_ID: HostId = "antigravity";

// Top-level keys in hooks.json are hook *names*, not event names -- we own
// exactly one name, "mac-sounds", for every event we ever wire up. That
// makes install/uninstall trivially non-destructive to any other named hook
// (e.g. this machine's own hand-written "agent-completion-sound").
const OWN_HOOK_NAME = "mac-sounds";

// Per the brief, Antigravity also has PreToolUse/PostToolUse/PreInvocation/
// PostInvocation -- this adapter only claims Stop, per product scope.
const EVENTS: readonly HookEvent[] = [
  {
    id: "stop",
    label: "Stop",
    description: "Fires when the agent loop stops (or is about to) for the current run.",
  },
];

const EVENT_NAME: Readonly<Record<string, string>> = { stop: "Stop" };

/** A foreign named-hook's event array, displaced by a force-install. */
interface DisplacedForeignHook {
  hookName: string;
  handlers: unknown[];
}

type DisplacedStore = Record<string, DisplacedForeignHook[]>;

function isDisplacedForeignHook(value: unknown): value is DisplacedForeignHook {
  return isRecord(value) && typeof value.hookName === "string" && Array.isArray(value.handlers);
}

function isDisplacedStore(value: unknown): value is DisplacedStore {
  if (!isRecord(value)) return false;
  return Object.values(value).every(
    (entry) => Array.isArray(entry) && entry.every(isDisplacedForeignHook),
  );
}

function isCommandHandler(value: unknown): value is { command: string } {
  return isRecord(value) && typeof value.command === "string";
}

function ownHandler(shimPath: string): Record<string, unknown> {
  return {
    type: "command",
    command: buildCommand(shimPath, HOST_ID, "stop"),
    // Hooks run synchronously inside the agent loop with a 30s *default*
    // timeout (verified brief) -- pin a short one so a stuck sound player
    // can never stall the user's next turn for anywhere near that long.
    timeout: 5,
  };
}

export class AntigravityAdapter implements HostAdapter {
  readonly id = HOST_ID;
  readonly label = "Antigravity CLI";
  readonly events = EVENTS;

  configPath(): string {
    return (
      process.env.MAC_SOUNDS_ANTIGRAVITY_CONFIG ??
      join(homedir(), ".gemini", "config", "hooks.json")
    );
  }

  isInstalled(): boolean {
    return hostRootExists(".gemini");
  }

  installedEventIds(): string[] {
    const file = this.readSafe();
    const own = isRecord(file[OWN_HOOK_NAME]) ? file[OWN_HOOK_NAME] : undefined;
    return this.events
      .filter((event) =>
        this.handlersFor(own, event.id).some(
          (handler) => isCommandHandler(handler) && isOwnCommand(handler.command),
        ),
      )
      .map((event) => event.id);
  }

  conflicts(): Conflict[] {
    return this.conflictsForEventIds(this.events.map((event) => event.id));
  }

  stdoutFor(_eventId: string): string {
    // Per the verified brief: the literal string "continue" is the ONE
    // value that blocks the stop; any other value lets the agent stop, and
    // stdout must parse as a JSON object. Returning an explicit, unambiguous
    // non-blocking decision here (rather than "" or some accidental value)
    // documents that this is a deliberate answer, not an omission.
    return '{"decision":"stop"}';
  }

  install(options: InstallOptions): void {
    const requested = this.events.filter((event) => options.eventIds.includes(event.id));
    if (requested.length === 0) return;

    const conflicts = this.conflictsForEventIds(requested.map((event) => event.id));
    if (conflicts.length > 0 && !options.force) {
      throw new HostConflictError(conflicts);
    }

    const path = this.configPath();
    const file = this.readForWrite(path);
    const sidecarPath = this.sidecarPath(path);
    const sidecarRaw = readJsonSidecar(sidecarPath);
    const sidecar: DisplacedStore = isDisplacedStore(sidecarRaw) ? { ...sidecarRaw } : {};

    for (const event of requested) {
      const eventName = EVENT_NAME[event.id];
      if (!eventName || !options.force) continue;
      const displaced = this.removeForeignHandlers(file, eventName);
      // Only stash when something is actually being displaced right now --
      // a repeat force-install has nothing foreign left to find.
      if (displaced.length > 0) sidecar[event.id] = displaced;
    }

    const ownEntry = isRecord(file[OWN_HOOK_NAME]) ? { ...file[OWN_HOOK_NAME] } : {};
    for (const event of requested) {
      const eventName = EVENT_NAME[event.id];
      if (!eventName) continue;
      ownEntry[eventName] = [ownHandler(options.shimPath)];
    }
    file[OWN_HOOK_NAME] = ownEntry;

    backupOnce(path);
    writeJsonSidecar(sidecarPath, sidecar);
    this.writeFile(path, file);
  }

  uninstall(): void {
    const path = this.configPath();
    const file = this.readForWrite(path);
    const sidecarPath = this.sidecarPath(path);
    const sidecarRaw = readJsonSidecar(sidecarPath);
    const sidecar: DisplacedStore = isDisplacedStore(sidecarRaw) ? { ...sidecarRaw } : {};
    let touched = false;

    if (OWN_HOOK_NAME in file) {
      delete file[OWN_HOOK_NAME];
      touched = true;
    }

    for (const event of this.events) {
      const displaced = sidecar[event.id];
      const eventName = EVENT_NAME[event.id];
      if (!displaced || displaced.length === 0 || !eventName) continue;
      touched = true;
      for (const foreign of displaced) {
        const priorEntry = file[foreign.hookName];
        const existingHook = isRecord(priorEntry) ? { ...priorEntry } : {};
        existingHook[eventName] = foreign.handlers;
        file[foreign.hookName] = existingHook;
      }
      delete sidecar[event.id];
    }

    if (!touched) return;

    backupOnce(path);
    writeJsonSidecar(sidecarPath, sidecar);
    this.writeFile(path, file);
  }

  private sidecarPath(configPath: string): string {
    return `${configPath}.mac-sounds-displaced.json`;
  }

  private handlersFor(hookEntry: Record<string, unknown> | undefined, eventId: string): unknown[] {
    if (!hookEntry) return [];
    const eventName = EVENT_NAME[eventId];
    if (!eventName) return [];
    const arr = hookEntry[eventName];
    return Array.isArray(arr) ? arr : [];
  }

  private conflictsForEventIds(eventIds: string[]): Conflict[] {
    const file = this.readSafe();
    const found: Conflict[] = [];
    for (const event of this.events) {
      if (!eventIds.includes(event.id)) continue;
      for (const [hookName, hookEntry] of Object.entries(file)) {
        if (hookName === OWN_HOOK_NAME) continue;
        const entry = isRecord(hookEntry) ? hookEntry : undefined;
        for (const handler of this.handlersFor(entry, event.id)) {
          if (isCommandHandler(handler) && !isOwnCommand(handler.command)) {
            found.push({ eventId: event.id, command: handler.command });
          }
        }
      }
    }
    return found;
  }

  // Removes every foreign (non-"mac-sounds") handler wired to `eventName`
  // across all top-level hook names, mutating `file` in place, and returns
  // exactly what was removed so the caller can stash it for uninstall to
  // restore. A hook name left with no events at all is deleted entirely; one
  // that still has *other* events keeps those untouched.
  private removeForeignHandlers(
    file: Record<string, unknown>,
    eventName: string,
  ): DisplacedForeignHook[] {
    const displaced: DisplacedForeignHook[] = [];
    for (const [hookName, hookEntry] of Object.entries(file)) {
      if (hookName === OWN_HOOK_NAME || !isRecord(hookEntry)) continue;
      const handlers = hookEntry[eventName];
      if (!Array.isArray(handlers) || handlers.length === 0) continue;
      displaced.push({ hookName, handlers });
      const nextEntry = { ...hookEntry };
      delete nextEntry[eventName];
      if (Object.keys(nextEntry).length === 0) {
        delete file[hookName];
      } else {
        file[hookName] = nextEntry;
      }
    }
    return displaced;
  }

  private readSafe(): Record<string, unknown> {
    const raw = readTextFileIfExists(this.configPath());
    if (raw === undefined) return {};
    try {
      const parsed: unknown = JSON.parse(raw);
      return isRecord(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }

  private readForWrite(path: string): Record<string, unknown> {
    const raw = readTextFileIfExists(path);
    if (raw === undefined) return {};
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw new Error(
        `Refusing to modify ${path}: it is not valid JSON (${String(error)}). ` +
          "Fix or remove it by hand, then retry.",
        { cause: error },
      );
    }
    if (!isRecord(parsed)) {
      throw new Error(`Refusing to modify ${path}: expected a JSON object at the top level.`);
    }
    return parsed;
  }

  private writeFile(path: string, file: Record<string, unknown>): void {
    writeFileAtomic(path, `${stringifyJsonAscii(file, 2)}\n`);
  }
}
