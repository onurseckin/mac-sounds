export type HostId = "claude" | "codex" | "antigravity";

export const HOST_IDS: readonly HostId[] = ["claude", "codex", "antigravity"];

// A Set gives O(1) membership without the TS friction of calling
// `readonly HostId[].includes` on a plain `string` (the array method's
// signature demands an argument already narrowed to HostId).
const HOST_ID_SET: ReadonlySet<string> = new Set(HOST_IDS);

export function isHostId(value: string): value is HostId {
  return HOST_ID_SET.has(value);
}

// The per-host event catalogue (which events exist for "claude", their ids,
// labels, descriptions) and the per-host config file paths belong to the
// host adapters, not here -- this file only holds the shapes shared across
// hosts and the state file.
export interface HookEvent {
  /** Stable, lowercase, used in the CLI and the state file, e.g. "stop" */
  id: string;
  /** Short human label */
  label: string;
  /** One line: when it fires */
  description: string;
}

export interface Binding {
  hostId: HostId;
  /** Matches a HookEvent.id from the owning host's catalogue */
  eventId: string;
  /** Absolute path to the sound file */
  soundPath: string;
  enabled: boolean;
}

export interface HooksConfig {
  version: 1;
  bindings: Binding[];
}
