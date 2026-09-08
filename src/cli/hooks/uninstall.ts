import { adapterFor } from "../../hooks/hosts/registry.ts";
import { printHooksUninstallHelp } from "../help.ts";
import { resolveHost } from "./resolve.ts";

const PREFIX = "mac-sounds hooks uninstall";
const HINT = `Try '${PREFIX} --help' for usage.`;

export function runHooksUninstall(args: readonly string[]): void {
  if (args.includes("-h") || args.includes("--help")) {
    printHooksUninstallHelp();
    process.exit(0);
  }

  const [hostArg, extra] = args;
  if (extra !== undefined) {
    process.stderr.write(`${PREFIX}: unexpected argument '${extra}'\n`);
    process.stderr.write(`${HINT}\n`);
    process.exit(1);
  }

  const hostId = resolveHost(PREFIX, HINT, hostArg);
  const adapter = adapterFor(hostId);
  adapter.uninstall();

  console.log(
    `mac-sounds: removed mac-sounds entries from ${adapter.label} (${adapter.configPath()})`,
  );
  process.exit(0);
}
