import type { HookEvent, HostId } from "../types.ts";

/** A foreign (non-mac-sounds) entry already wired to an event we want to own. */
export interface Conflict {
  eventId: string;
  /** The existing command/entry text, verbatim, for the CLI to show the user. */
  command: string;
}

export interface InstallOptions {
  /** Absolute path to the shim every host config must invoke. */
  shimPath: string;
  /** Event ids (from the adapter's `events`) to wire up. Unknown ids are ignored. */
  eventIds: string[];
  /** Skip conflict detection and displace foreign entries anyway. */
  force: boolean;
}

/**
 * Thrown by `install()` when one or more requested events already have a
 * foreign (non-mac-sounds) entry and `force` was not set. The CLI is
 * expected to catch this, show `conflicts` to the user, and re-invoke with
 * `force: true` once they confirm displacing them.
 */
export class HostConflictError extends Error {
  readonly conflicts: Conflict[];

  constructor(conflicts: Conflict[]) {
    super(
      `${conflicts.length} event(s) already have a non-mac-sounds hook: ` +
        conflicts.map((conflict) => conflict.eventId).join(", "),
    );
    this.name = "HostConflictError";
    this.conflicts = conflicts;
  }
}

export interface HostAdapter {
  readonly id: HostId;
  readonly label: string;
  readonly events: readonly HookEvent[];

  /** Absolute path to this host's global config file. */
  configPath(): string;

  /** Is the host itself present on this machine (best-effort detection)? */
  isInstalled(): boolean;

  /** Event ids from `events` that currently have a mac-sounds entry wired up. */
  installedEventIds(): string[];

  /** Foreign entries that would double up with ours, across every managed event. */
  conflicts(): Conflict[];

  /**
   * What the shim must print to stdout for this event. "" means print
   * NOTHING -- some hosts treat non-empty/well-shaped stdout as a live
   * control signal, not a log line.
   */
  stdoutFor(eventId: string): string;

  /** Wire up the given events. Throws HostConflictError if conflicts exist and !force. */
  install(options: InstallOptions): void;

  /** Remove every mac-sounds entry, restoring anything it displaced. */
  uninstall(): void;
}

/**
 * The literal substring every command this tool ever writes contains (every
 * shim lives at a path ending in mac-sounds/hook.sh). Detecting ownership
 * this way -- rather than an exact match against what we'd generate today --
 * means we still recognise, and can cleanly uninstall, an entry written by
 * an older or newer version of this tool that built its command line
 * slightly differently.
 */
const OWNERSHIP_MARKER = "mac-sounds/hook.sh";

export function isOwnCommand(command: string): boolean {
  return command.includes(OWNERSHIP_MARKER);
}

/**
 * The exact shell command line Claude Code and Antigravity must write for a
 * given event: `"<shimPath>" <hostId> <eventId>`. Codex's legacy `notify` is
 * an argv array, not a shell string, so CodexAdapter builds its own argv
 * form instead of using this -- see codex.ts for why.
 */
export function buildCommand(shimPath: string, hostId: HostId, eventId: string): string {
  return `"${shimPath}" ${hostId} ${eventId}`;
}
