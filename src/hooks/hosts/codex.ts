import { homedir } from "node:os";
import { join } from "node:path";
import type { HookEvent, HostId } from "../types.ts";
import {
  type Conflict,
  type HostAdapter,
  HostConflictError,
  type InstallOptions,
  isOwnCommand,
} from "./adapter.ts";
import { backupOnce, hostRootExists, readTextFileIfExists, writeFileAtomic } from "./fs-utils.ts";

const HOST_ID: HostId = "codex";

// Only the legacy `notify` key is used here, deliberately. Per the verified
// brief, Codex's newer `[hooks]` table SHA-256-hashes every entry and treats
// a config-written hook as untrusted until a human clicks through the TUI's
// "Trust hooks" screen -- an automated writer would produce a hook that
// silently never runs. Legacy `notify` has no trust gate: it's a plain
// top-level scalar array, and there's exactly one event to hang off it.
const EVENTS: readonly HookEvent[] = [
  {
    id: "turn-complete",
    label: "Turn Complete",
    description: "Fires once when Codex finishes an agent turn (no separate failure event).",
  },
];

const NOTIFY_LINE = /^notify\s*=/;
const STASH_PREFIX = "# mac-sounds:previous-notify = ";

/**
 * `notify` is a *top-level* key (`ConfigToml.notify: Option<Vec<String>>`).
 * TOML's classic footgun: a bare `key = value` line appearing *after* a
 * `[section]` header silently belongs to that table instead of being the
 * top-level key of the same name. So "the current top-level notify" only
 * ever means a `notify =` line found before the first `[...]` header --
 * anything with that shape after one doesn't count, and a fresh `notify`
 * must always be inserted before that first header, never after it.
 */
function findPreambleEnd(lines: string[]): number {
  for (let i = 0; i < lines.length; i++) {
    if ((lines[i] ?? "").trimStart().startsWith("[")) return i;
  }
  return lines.length;
}

function findNotifyLine(lines: string[], preambleEnd: number): number | undefined {
  for (let i = 0; i < preambleEnd; i++) {
    if (NOTIFY_LINE.test(lines[i] ?? "")) return i;
  }
  return undefined;
}

function findPrecedingStash(lines: string[], notifyIndex: number): number | undefined {
  const prev = notifyIndex - 1;
  if (prev < 0) return undefined;
  return (lines[prev] ?? "").startsWith(STASH_PREFIX) ? prev : undefined;
}

function extractRhs(line: string): string {
  const eq = line.indexOf("=");
  return eq === -1 ? "" : line.slice(eq + 1).trim();
}

/**
 * Codex's `notify` is `Vec<String>` (argv), spawned directly with no shell
 * (`Command::new(argv[0])`) -- unlike Claude/Antigravity's `command` field,
 * which is one shell string Codex would never see. Writing the generic
 * `"<shimPath>" <hostId> <eventId>` single-string form here would make Codex
 * try to exec a program literally named that whole quoted string and fail.
 * A plain TOML array of strings is both the only structurally correct
 * choice and, conveniently, valid JSON for the simple ASCII-path case this
 * tool always writes -- which is what lets the stashed previous value below
 * round-trip through JSON safely without a TOML parser.
 */
function renderNotifyArray(values: string[]): string {
  return `[${values.map((value) => `"${escapeToml(value)}"`).join(", ")}]`;
}

function escapeToml(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/**
 * Parse a `notify = <rhs>` value as JSON. This only succeeds for the plain
 * "array of double-quoted strings" shape Codex itself writes (confirmed
 * against the live file on this machine) -- which happens to already be
 * valid JSON syntax. Anything else (TOML literal/multi-line strings, etc.)
 * intentionally fails closed: install() refuses to force-displace a value
 * it can't confidently stash and restore later, rather than guessing.
 */
function parseNotifyArray(rhs: string): string[] | undefined {
  try {
    const parsed: unknown = JSON.parse(rhs);
    if (Array.isArray(parsed) && parsed.every((item) => typeof item === "string")) {
      return parsed;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

export class CodexAdapter implements HostAdapter {
  readonly id = HOST_ID;
  readonly label = "Codex CLI";
  readonly events = EVENTS;

  configPath(): string {
    return process.env.MAC_SOUNDS_CODEX_CONFIG ?? join(homedir(), ".codex", "config.toml");
  }

  isInstalled(): boolean {
    return hostRootExists(".codex");
  }

  installedEventIds(): string[] {
    const current = this.currentNotify();
    return current !== undefined && isOwnCommand(current) ? ["turn-complete"] : [];
  }

  conflicts(): Conflict[] {
    const current = this.currentNotify();
    if (current === undefined || isOwnCommand(current)) return [];
    return [{ eventId: "turn-complete", command: current }];
  }

  stdoutFor(_eventId: string): string {
    // Per the verified brief: stdout and exit code are ignored entirely --
    // Codex spawns notify with Stdio::null() for stdin/stdout/stderr and
    // never .wait()s on it. "" documents that deliberately rather than
    // leaving it implicit.
    return "";
  }

  install(options: InstallOptions): void {
    const requested = this.events.filter((event) => options.eventIds.includes(event.id));
    if (requested.length === 0) return;

    const path = this.configPath();
    const raw = readTextFileIfExists(path) ?? "";
    const wasEmpty = raw.length === 0;
    const lines = wasEmpty ? [] : raw.split("\n");
    const preambleEnd = findPreambleEnd(lines);
    const notifyIdx = findNotifyLine(lines, preambleEnd);
    const currentRhs = notifyIdx !== undefined ? extractRhs(lines[notifyIdx] ?? "") : undefined;
    const isOwn = currentRhs !== undefined && isOwnCommand(currentRhs);

    if (currentRhs !== undefined && !isOwn && !options.force) {
      throw new HostConflictError([{ eventId: "turn-complete", command: currentRhs }]);
    }

    const newLine = `notify = ${renderNotifyArray([options.shimPath, HOST_ID, "turn-complete"])}`;
    const nextLines = [...lines];

    if (notifyIdx === undefined) {
      // No top-level notify yet: insert before the first [section] header
      // (or at EOF if there are no sections at all) -- see findPreambleEnd.
      nextLines.splice(preambleEnd, 0, newLine);
    } else if (currentRhs !== undefined && !isOwn) {
      const foreignArray = parseNotifyArray(currentRhs);
      if (foreignArray === undefined) {
        throw new Error(
          `Refusing to overwrite notify in ${path}: its current value isn't a plain ` +
            `array of strings mac-sounds can safely stash and restore later: ${currentRhs}`,
        );
      }
      const stashLine = `${STASH_PREFIX}${JSON.stringify(foreignArray)}`;
      const existingStash = findPrecedingStash(lines, notifyIdx);
      nextLines[notifyIdx] = newLine;
      if (existingStash !== undefined) {
        nextLines[existingStash] = stashLine;
      } else {
        nextLines.splice(notifyIdx, 0, stashLine);
      }
    } else {
      // Already ours (a repeat/idempotent install), possibly with a stash
      // comment sitting above it from an earlier force-install -- leave that
      // comment exactly as-is and just refresh the notify line itself.
      nextLines[notifyIdx] = newLine;
    }

    backupOnce(path);
    this.write(path, nextLines, wasEmpty);
  }

  uninstall(): void {
    const path = this.configPath();
    const raw = readTextFileIfExists(path);
    if (raw === undefined) return;

    const lines = raw.split("\n");
    const preambleEnd = findPreambleEnd(lines);
    const notifyIdx = findNotifyLine(lines, preambleEnd);
    if (notifyIdx === undefined) return;

    const currentRhs = extractRhs(lines[notifyIdx] ?? "");
    if (!isOwnCommand(currentRhs)) return;

    const stashIdx = findPrecedingStash(lines, notifyIdx);
    const nextLines = [...lines];

    if (stashIdx !== undefined) {
      const stashRhs = (lines[stashIdx] ?? "").slice(STASH_PREFIX.length).trim();
      const restored = parseNotifyArray(stashRhs);
      if (restored !== undefined) {
        nextLines[notifyIdx] = `notify = ${renderNotifyArray(restored)}`;
        nextLines.splice(stashIdx, 1);
      } else {
        // Stash comment present but unparseable (hand-edited?) -- don't
        // guess at restoring it. Remove our own notify line and leave the
        // comment for a human to sort out rather than losing data quietly.
        nextLines.splice(notifyIdx, 1);
      }
    } else {
      nextLines.splice(notifyIdx, 1);
    }

    backupOnce(path);
    this.write(path, nextLines, false);
  }

  private currentNotify(): string | undefined {
    const raw = readTextFileIfExists(this.configPath());
    if (raw === undefined) return undefined;
    const lines = raw.split("\n");
    const notifyIdx = findNotifyLine(lines, findPreambleEnd(lines));
    return notifyIdx === undefined ? undefined : extractRhs(lines[notifyIdx] ?? "");
  }

  private write(path: string, lines: string[], forceTrailingNewline: boolean): void {
    const content = lines.join("\n");
    writeFileAtomic(path, forceTrailingNewline ? `${content}\n` : content);
  }
}
