import { HOST_IDS } from "../hooks/types.ts";
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

// The "hooks" family has its own two-level help: `hooks --help` / `help
// hooks` show this overview, and each subcommand has its own dedicated
// print*Help below, called directly from src/cli/hooks/*.ts on that
// subcommand's own -h/--help rather than routed through printCommandHelp
// (which only knows about top-level CommandNames).
export function printHooksHelp(): void {
  console.log(`Usage: mac-sounds hooks [subcommand] [options]

Manage sound bindings for AI coding agent lifecycle hooks. With no
subcommand, prints a status table: every host, whether it's installed,
whether mac-sounds is wired into it, and each event's assigned sound and
on/off state.

Subcommands:
  install <host> [--force]      write dispatch entries into that host's global config
  uninstall <host>              remove them and restore anything displaced
  set <host> <event> <sound>    assign a sound to one event
  enable <host> [event]         enable one event, or all of that host's
  disable <host> [event]        disable without touching the host config

Options:
  -h, --help   show this help and exit

Hosts: ${HOST_IDS.join(", ")}

Run 'mac-sounds hooks <subcommand> --help' for details on a specific one.

Example:
  mac-sounds hooks install claude
  mac-sounds hooks set claude stop glass`);
}

export function printHooksInstallHelp(): void {
  console.log(`Usage: mac-sounds hooks install <host> [--force]

Write mac-sounds dispatch entries into <host>'s global config, so its
lifecycle events call back into 'mac-sounds hook <host> <event>'.

If <host> has no sound bindings of its own yet, sensible defaults are seeded
first: completion-style events -> Pop.aiff, failure-style events ->
Submarine.aiff. Other events are left unbound.

If <host>'s config already has a conflicting entry for one of these events
(something not written by mac-sounds), install refuses and lists the
conflicts. Pass --force to overwrite them anyway.

Options:
  --force      overwrite conflicting entries instead of refusing
  -h, --help   show this help and exit

Hosts: ${HOST_IDS.join(", ")}

Example:
  mac-sounds hooks install claude`);
}

export function printHooksUninstallHelp(): void {
  console.log(`Usage: mac-sounds hooks uninstall <host>

Remove mac-sounds' dispatch entries from <host>'s global config, restoring
anything they displaced. mac-sounds' own sound bindings for <host> are left
in place, so a later 'hooks install <host>' picks up where you left off.

Options:
  -h, --help   show this help and exit

Hosts: ${HOST_IDS.join(", ")}

Example:
  mac-sounds hooks uninstall claude`);
}

export function printHooksSetHelp(): void {
  console.log(`Usage: mac-sounds hooks set <host> <event> <sound>

Assign <sound> to <event> on <host>. <sound> may be an absolute path, or a
fuzzy name resolved against the sound catalog (same matching as 'mac-sounds
play'); the resolved absolute path is printed.

This only changes mac-sounds' own state file -- it never requires (or
performs) a 'hooks install', so re-running it takes effect immediately.

Options:
  -h, --help   show this help and exit

Hosts: ${HOST_IDS.join(", ")}

Example:
  mac-sounds hooks set claude stop glass`);
}

export function printHooksEnableHelp(): void {
  console.log(`Usage: mac-sounds hooks enable <host> [event]

Enable <event> on <host>, or every event on <host> that already has a sound
assigned if [event] is omitted. Only mac-sounds' own state file changes --
<host>'s config is never touched -- which is why this is instant.

Options:
  -h, --help   show this help and exit

Hosts: ${HOST_IDS.join(", ")}

Example:
  mac-sounds hooks enable claude stop`);
}

export function printHooksDisableHelp(): void {
  console.log(`Usage: mac-sounds hooks disable <host> [event]

Disable <event> on <host>, or every event on <host> that already has a sound
assigned if [event] is omitted. Only mac-sounds' own state file changes --
<host>'s config is never touched -- which is why this is instant.

Options:
  -h, --help   show this help and exit

Hosts: ${HOST_IDS.join(", ")}

Example:
  mac-sounds hooks disable claude stop`);
}

export function printHookDispatchHelp(): void {
  console.log(`Usage: mac-sounds hook <host> <event>

Internal dispatcher: looks up the sound bound to <event> on <host> in
mac-sounds' own state file and plays it if one is bound and enabled.

This is what 'mac-sounds hooks install' wires into each host's config --
you would only run it by hand to test a binding directly.

Hosts: ${HOST_IDS.join(", ")}

Example:
  mac-sounds hook claude stop`);
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
    case "hooks":
      printHooksHelp();
      return;
    case "hook":
      printHookDispatchHelp();
      return;
    case "help":
      printHelpHelp();
      return;
  }
}
