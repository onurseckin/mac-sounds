// Copied verbatim from the project's fixed keymap contract: the UI and README
// implement/document exactly this table, so it lives here as a literal, not
// something reformatted or regenerated from the key-handling code.
export const KEYMAP = `  type            filter sounds
  Backspace       delete a character      Ctrl+U   clear the query
  Up/Down         move selection          Ctrl+P/N same
  PageUp/PageDown move by 10              Home/End first / last
  Enter or Space  play sound / toggle group
  Right / Left    expand / collapse group
  Tab             toggle the current group
  Ctrl+S          stop playback
  Ctrl+Y          copy the selected path to the clipboard
  Escape          clear query, or quit when empty
  Ctrl+C          quit`;

export const SCANNED_DIRECTORIES = [
  "/System/Library/Sounds",
  "/Library/Sounds",
  "~/Library/Sounds",
  "/System/Library/PrivateFrameworks/ToneLibrary.framework/Versions/A/Resources/AlertTones/Classic",
  "/System/Library/PrivateFrameworks/ToneLibrary.framework/Versions/A/Resources/AlertTones/Modern",
  "/System/Library/PrivateFrameworks/ToneLibrary.framework/Versions/A/Resources/AlertTones/EncoreInfinitum",
];

// "hook" (singular) is deliberately not part of this union's visible
// surface -- see HIDDEN_COMMANDS below -- but it must still be a
// CommandName so printCommandHelp() can dispatch `help hook` to it.
export type CommandName = "list" | "play" | "groups" | "help" | "hooks" | "hook";

export interface CommandInfo {
  name: CommandName;
  /** How it reads on a usage line, e.g. "list [options]". */
  usage: string;
  /** One-line description shown next to it in the top-level help. */
  summary: string;
}

// Single source of truth for "what commands exist": the top-level help
// listing, the `help <command>` / `<command> --help` dispatch, and the
// unknown-command suggestion heuristic all read from this instead of each
// keeping their own copy of the command names.
export const COMMANDS: readonly CommandInfo[] = [
  { name: "list", usage: "list [options]", summary: "print sounds, one per line" },
  { name: "play", usage: "play <query>", summary: "play the best fuzzy match, then exit" },
  { name: "groups", usage: "groups", summary: "list the sound groups and their directories" },
  { name: "hooks", usage: "hooks [subcommand]", summary: "manage lifecycle-hook sound bindings" },
  { name: "help", usage: "help [command]", summary: "print help for a command" },
];

// `hook <host> <event>` is the internal dispatcher the installed shim calls
// on every lifecycle event -- it is a real, working command (parse.ts routes
// it, `help hook` documents it) but is kept out of COMMANDS so it never shows
// up in the top-level usage table a human reads.
export const HIDDEN_COMMANDS: readonly CommandInfo[] = [
  {
    name: "hook",
    usage: "hook <host> <event>",
    summary: "internal dispatcher used by the installed shim",
  },
];

export const ALL_COMMANDS: readonly CommandInfo[] = [...COMMANDS, ...HIDDEN_COMMANDS];

// Seeded on `hooks install` only when the host has zero bindings of its own
// -- picked because both sounds already exist on every macOS install, so the
// feature works before the user has chosen anything.
export const DEFAULT_COMPLETION_SOUND = "/System/Library/Sounds/Pop.aiff";
export const DEFAULT_FAILURE_SOUND = "/System/Library/Sounds/Submarine.aiff";
export const COMPLETION_STYLE_EVENT_IDS: readonly string[] = [
  "stop",
  "subagent-stop",
  "turn-complete",
];
export const FAILURE_STYLE_EVENT_IDS: readonly string[] = ["stop-failure"];
