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

const NOTIFY_LINE = /^\s*notify\s*=/;
const STASH_PREFIX = "# mac-sounds:previous-notify = ";

interface NotifySpan {
  start: number;
  end: number;
  rhs: string;
}

/**
 * `notify` is a *top-level* key (`ConfigToml.notify: Option<Vec<String>>`).
 * TOML's classic footgun: a bare `key = value` line appearing *after* a
 * `[section]` header silently belongs to that table instead of being the
 * top-level key of the same name. So "the current top-level notify" only
 * ever means a `notify =` declaration found before the first `[...]` header --
 * anything with that shape after one doesn't count, and a fresh `notify`
 * must always be inserted before that first header, never after it.
 */
function findPreambleEnd(lines: string[]): number {
  for (let i = 0; i < lines.length; i++) {
    if ((lines[i] ?? "").trimStart().startsWith("[")) return i;
  }
  return lines.length;
}

/**
 * Strips an unquoted TOML `#` comment from a single line and returns the
 * net `[` minus `]` bracket delta outside quoted strings.
 */
function scanTomlLine(line: string): { code: string; bracketDelta: number } {
  let inDouble = false;
  let inSingle = false;
  let escaped = false;
  let bracketDelta = 0;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (inDouble) {
      if (ch === "\\") escaped = true;
      else if (ch === '"') inDouble = false;
      continue;
    }
    if (inSingle) {
      if (ch === "'") inSingle = false;
      continue;
    }
    if (ch === '"') {
      inDouble = true;
    } else if (ch === "'") {
      inSingle = true;
    } else if (ch === "#") {
      return { code: line.slice(0, i).trim(), bracketDelta };
    } else if (ch === "[") {
      bracketDelta++;
    } else if (ch === "]") {
      bracketDelta--;
    }
  }

  return { code: line.trim(), bracketDelta };
}

function findNotifySpan(lines: string[], preambleEnd: number): NotifySpan | undefined {
  for (let i = 0; i < preambleEnd; i++) {
    const line = lines[i] ?? "";
    if (!NOTIFY_LINE.test(line)) continue;

    const eq = line.indexOf("=");
    const firstRhs = eq === -1 ? "" : line.slice(eq + 1);
    const firstScan = scanTomlLine(firstRhs);
    const parts: string[] = [firstScan.code];
    let depth = firstScan.bracketDelta;
    let end = i;

    if (firstScan.code.startsWith("[") && depth > 0) {
      for (let j = i + 1; j < preambleEnd && depth > 0; j++) {
        const scan = scanTomlLine(lines[j] ?? "");
        if (scan.code !== "") parts.push(scan.code);
        depth += scan.bracketDelta;
        end = j;
      }
    }

    return {
      start: i,
      end,
      rhs: parts.join(" ").trim(),
    };
  }
  return undefined;
}

function findPrecedingStash(lines: string[], notifyIndex: number): number | undefined {
  const prev = notifyIndex - 1;
  if (prev < 0) return undefined;
  return (lines[prev] ?? "").startsWith(STASH_PREFIX) ? prev : undefined;
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
 * Parse a `notify = <rhs>` value as a string array. Supports both single-line
 * and multi-line TOML arrays of double-quoted strings (including the trailing
 * comma before `]` that Codex's own TOML serializer emits). Anything else
 * (TOML literal/multi-line strings, etc.) intentionally fails closed:
 * install() refuses to force-displace a value it can't confidently stash and
 * restore later, rather than guessing.
 */
function parseNotifyArray(rhs: string): string[] | undefined {
  const normalized = rhs.trim().replace(/,(\s*\])\s*$/, "$1");
  try {
    const parsed: unknown = JSON.parse(normalized);
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
    const span = findNotifySpan(lines, preambleEnd);
    const currentRhs = span?.rhs;
    const isOwn = currentRhs !== undefined && isOwnCommand(currentRhs);

    if (currentRhs !== undefined && !isOwn && !options.force) {
      throw new HostConflictError([{ eventId: "turn-complete", command: currentRhs }]);
    }

    const newLine = `notify = ${renderNotifyArray([options.shimPath, HOST_ID, "turn-complete"])}`;
    const nextLines = [...lines];

    if (span === undefined) {
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
      const existingStash = findPrecedingStash(lines, span.start);
      const spanLen = span.end - span.start + 1;
      if (existingStash !== undefined) {
        nextLines[existingStash] = stashLine;
        nextLines.splice(span.start, spanLen, newLine);
      } else {
        nextLines.splice(span.start, spanLen, stashLine, newLine);
      }
    } else {
      // Already ours (a repeat/idempotent install), possibly with a stash
      // comment sitting above it from an earlier force-install -- leave that
      // comment exactly as-is and just refresh the notify span itself.
      nextLines.splice(span.start, span.end - span.start + 1, newLine);
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
    const span = findNotifySpan(lines, preambleEnd);
    if (span === undefined) return;

    if (!isOwnCommand(span.rhs)) return;

    const stashIdx = findPrecedingStash(lines, span.start);
    const nextLines = [...lines];
    const spanLen = span.end - span.start + 1;

    if (stashIdx !== undefined) {
      const stashRhs = (lines[stashIdx] ?? "").slice(STASH_PREFIX.length).trim();
      const restored = parseNotifyArray(stashRhs);
      if (restored !== undefined) {
        nextLines.splice(span.start, spanLen, `notify = ${renderNotifyArray(restored)}`);
        nextLines.splice(stashIdx, 1);
      } else {
        // Stash comment present but unparseable (hand-edited?) -- don't
        // guess at restoring it. Remove our own notify span and leave the
        // comment for a human to sort out rather than losing data quietly.
        nextLines.splice(span.start, spanLen);
      }
    } else {
      nextLines.splice(span.start, spanLen);
    }

    backupOnce(path);
    this.write(path, nextLines, false);
  }

  private currentNotify(): string | undefined {
    const raw = readTextFileIfExists(this.configPath());
    if (raw === undefined) return undefined;
    const lines = raw.split("\n");
    return findNotifySpan(lines, findPreambleEnd(lines))?.rhs;
  }

  private write(path: string, lines: string[], forceTrailingNewline: boolean): void {
    const content = lines.join("\n");
    writeFileAtomic(path, forceTrailingNewline ? `${content}\n` : content);
  }
}
