import { loadCatalog } from "../sounds/catalog.ts";
import { printCommandHelp } from "./help.ts";

interface ListOptions {
  groupId: string | null;
  namesOnly: boolean;
}

// Scans the whole arg list rather than expecting a fixed positional order, so
// `--names --group modern` and `--group modern --names` both work.
function parseListArgs(args: readonly string[]): ListOptions {
  let groupId: string | null = null;
  let namesOnly = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === undefined) continue;

    if (arg === "-h" || arg === "--help") {
      printCommandHelp("list");
      process.exit(0);
    }
    if (arg === "--names") {
      namesOnly = true;
      continue;
    }
    if (arg === "--group") {
      const value = args[i + 1];
      if (value === undefined) {
        process.stderr.write("mac-sounds list: --group requires a value\n");
        process.stderr.write("Try 'mac-sounds list --help' for usage.\n");
        process.exit(1);
      }
      groupId = value;
      i++;
      continue;
    }

    process.stderr.write(`mac-sounds list: unknown option '${arg}'\n`);
    process.stderr.write("Try 'mac-sounds list --help' for usage.\n");
    process.exit(1);
  }

  return { groupId, namesOnly };
}

export function runList(args: readonly string[]): void {
  const options = parseListArgs(args);
  const catalog = loadCatalog();
  const groups =
    options.groupId === null ? catalog : catalog.filter((group) => group.id === options.groupId);

  if (options.groupId !== null && groups.length === 0) {
    const known = catalog.map((group) => group.id).join(", ");
    process.stderr.write(
      `mac-sounds list: unknown group '${options.groupId}' (known groups: ${known})\n`,
    );
    process.exit(1);
  }

  for (const group of groups) {
    for (const sound of group.sounds) {
      console.log(options.namesOnly ? sound.name : sound.path);
    }
  }
  process.exit(0);
}
