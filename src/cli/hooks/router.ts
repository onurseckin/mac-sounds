import { printHooksHelp } from "../help.ts";
import { runHooksSet } from "./assign.ts";
import { runHooksInstall } from "./install.ts";
import { runHooksStatus } from "./status.ts";
import { runHooksDisable, runHooksEnable } from "./toggle.ts";
import { runHooksUninstall } from "./uninstall.ts";

const SUBCOMMANDS = ["install", "uninstall", "set", "enable", "disable"];

// `parse.ts` only knows "hooks" is a top-level command -- everything below
// the subcommand level (routing, per-subcommand help, arg parsing) stays
// here, mirroring how e.g. list.ts owns its own `--group`/`--names` flags
// without parse.ts knowing about them.
export function runHooks(args: readonly string[]): void {
  const [sub, ...rest] = args;

  if (sub === undefined) {
    runHooksStatus();
    return;
  }
  if (sub === "-h" || sub === "--help") {
    printHooksHelp();
    process.exit(0);
  }

  switch (sub) {
    case "install":
      runHooksInstall(rest);
      return;
    case "uninstall":
      runHooksUninstall(rest);
      return;
    case "set":
      runHooksSet(rest);
      return;
    case "enable":
      runHooksEnable(rest);
      return;
    case "disable":
      runHooksDisable(rest);
      return;
    default:
      process.stderr.write(`mac-sounds hooks: unknown subcommand '${sub}'\n`);
      process.stderr.write(`Known subcommands: ${SUBCOMMANDS.join(", ")}\n`);
      process.stderr.write("Try 'mac-sounds hooks --help' for usage.\n");
      process.exit(1);
  }
}
