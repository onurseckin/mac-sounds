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

export type CommandName = "list" | "play" | "groups" | "help";

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
  { name: "help", usage: "help [command]", summary: "print help for a command" },
];
