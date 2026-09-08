import { COMMANDS, KEYMAP, SCANNED_DIRECTORIES } from "./constants.ts";
import type { CommandName } from "./constants.ts";

const NONE_USAGE = "(none)";

function commandsBlock(): string {
  const width = Math.max(...COMMANDS.map((command) => command.usage.length), NONE_USAGE.length);
  const lines = [`  ${NONE_USAGE.padEnd(width)}  launch the TUI (default, no args)`];
  for (const command of COMMANDS) {
    lines.push(`  ${command.usage.padEnd(width)}  ${command.summary}`);
  }
  return lines.join("\n");
}

function directoriesBlock(): string {
  return SCANNED_DIRECTORIES.map((dir) => `  ${dir}`).join("\n");
}

export function printTopLevelHelp(): void {
  console.log(`Usage: mac-sounds [command] [options]

A terminal UI for browsing and playing macOS system sounds. With no command
it launches the TUI.

Commands:
${commandsBlock()}

Global options:
  -h, --help     show this help and exit
  -V, --version  print the version and exit

Compatibility:
  -l, --list     alias for "list" with no options (kept for existing scripts)

Run 'mac-sounds help <command>' or 'mac-sounds <command> --help' for details
on a specific command.

Keys (TUI):
${KEYMAP}

Directories scanned:
${directoriesBlock()}`);
}

function printListHelp(): void {
  console.log(`Usage: mac-sounds list [options]

Print every matching sound's path, one per line.

Options:
  --group <id>   restrict output to one group (see 'mac-sounds groups' for ids)
  --names        print bare sound names instead of absolute paths
  -h, --help     show this help and exit

Output is absolute paths by default: this command exists to be piped (e.g.
into a picker, or 'less'), and relative paths would break that.

'mac-sounds --list' / '-l' remain supported as a compatibility alias for this
command with no options.

Example:
  mac-sounds list --group modern --names`);
}

function printPlayHelp(): void {
  console.log(`Usage: mac-sounds play <query>

Resolve <query> against the sound catalog with fuzzy matching, play the best
match, and wait for playback to finish before exiting.

The chosen sound is printed to stderr, so stdout stays clean for scripts.
Exits with status 1 if no sound matches the query.

Options:
  -h, --help   show this help and exit

Example:
  mac-sounds play glass`);
}

function printGroupsHelp(): void {
  console.log(`Usage: mac-sounds groups

List each sound group's id, label, directory, and how many sounds it holds.

Options:
  -h, --help   show this help and exit

Example:
  mac-sounds groups`);
}

function printHelpHelp(): void {
  console.log(`Usage: mac-sounds help [command]

Print help for <command>, or this top-level help if <command> is omitted.
Equivalent to running that command with --help.

Example:
  mac-sounds help list`);
}

export function printCommandHelp(name: CommandName): void {
  switch (name) {
    case "list":
      printListHelp();
      return;
    case "play":
      printPlayHelp();
      return;
    case "groups":
      printGroupsHelp();
      return;
    case "help":
      printHelpHelp();
      return;
  }
}
