import { ALL_COMMANDS } from "./constants.ts";
import type { CommandName } from "./constants.ts";
import { printCommandHelp, printTopLevelHelp } from "./help.ts";
import { runGroups } from "./groups.ts";
import { runHookDispatch } from "./hooks/invoke.ts";
import { runHooks } from "./hooks/router.ts";
import { runList } from "./list.ts";
import { runPlay } from "./play.ts";
import { suggestCommand } from "./suggest.ts";
import { readVersion } from "./version.ts";

// Checked against ALL_COMMANDS (COMMANDS plus the hidden "hook" dispatcher),
// not just COMMANDS, so `mac-sounds help hook` resolves even though "hook"
// is deliberately absent from the visible top-level usage table.
function isCommandName(value: string): value is CommandName {
  return ALL_COMMANDS.some((command) => command.name === value);
}

function reportUnknown(kind: "command" | "option", token: string): never {
  process.stderr.write(`mac-sounds: unknown ${kind} '${token}'\n`);
  if (kind === "command") {
    const suggestion = suggestCommand(token);
    if (suggestion !== null) {
      process.stderr.write(`Did you mean '${suggestion}'?\n`);
    }
  }
  process.stderr.write("Try 'mac-sounds --help' for usage.\n");
  process.exit(1);
}

// Returns normally (without exiting) only when the caller should launch the
// TUI -- every other outcome (a command, help, an error) exits the process
// itself, the same shape as the flag-only parser this replaces.
export async function parseArgs(argv: readonly string[]): Promise<void> {
  const first = argv[0];
  if (first === undefined) return;

  if (first === "-h" || first === "--help") {
    printTopLevelHelp();
    process.exit(0);
  }
  if (first === "-V" || first === "--version") {
    console.log(readVersion());
    process.exit(0);
  }
  // Backward-compat aliases: --list / -l were the whole CLI before commands
  // existed, and README-documented scripts may still call them directly.
  if (first === "--list" || first === "-l") {
    runList(argv.slice(1));
    return;
  }
  if (first === "help") {
    const target = argv[1];
    if (target === undefined) {
      printTopLevelHelp();
      process.exit(0);
    }
    if (!isCommandName(target)) {
      reportUnknown("command", target);
    }
    printCommandHelp(target);
    process.exit(0);
  }
  if (first === "list") {
    runList(argv.slice(1));
    return;
  }
  if (first === "play") {
    await runPlay(argv.slice(1));
    return;
  }
  if (first === "groups") {
    runGroups(argv.slice(1));
    return;
  }
  if (first === "hooks") {
    runHooks(argv.slice(1));
    return;
  }
  if (first === "hook") {
    await runHookDispatch(argv.slice(1));
    return;
  }

  reportUnknown(first.startsWith("-") ? "option" : "command", first);
}
