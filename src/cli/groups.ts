import { loadCatalog } from "../sounds/catalog.ts";
import { printCommandHelp } from "./help.ts";

export function runGroups(args: readonly string[]): void {
  if (args.includes("-h") || args.includes("--help")) {
    printCommandHelp("groups");
    process.exit(0);
  }
  const extra = args[0];
  if (extra !== undefined) {
    // `groups` takes no flags or positional arguments, so anything left over
    // (dash-prefixed or not) is unexpected rather than a specific "option".
    process.stderr.write(`mac-sounds groups: unexpected argument '${extra}'\n`);
    process.stderr.write("Try 'mac-sounds groups --help' for usage.\n");
    process.exit(1);
  }

  const catalog = loadCatalog();
  // Directory goes last: it's the widest, most variable-length field, so
  // padding the other three keeps the table lined up without wasting space.
  const idWidth = Math.max(...catalog.map((group) => group.id.length), "id".length);
  const labelWidth = Math.max(...catalog.map((group) => group.label.length), "label".length);
  const countWidth = Math.max(
    ...catalog.map((group) => String(group.sounds.length).length),
    "count".length,
  );

  console.log(
    `${"id".padEnd(idWidth)}  ${"label".padEnd(labelWidth)}  ${"count".padEnd(countWidth)}  directory`,
  );
  for (const group of catalog) {
    console.log(
      `${group.id.padEnd(idWidth)}  ${group.label.padEnd(labelWidth)}  ${String(
        group.sounds.length,
      ).padEnd(countWidth)}  ${group.dir}`,
    );
  }
  process.exit(0);
}
