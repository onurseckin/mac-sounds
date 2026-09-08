import { adapterFor } from "../../hooks/hosts/registry.ts";
import { getBinding, loadConfig, saveConfig, upsertBinding } from "../../hooks/config.ts";
import type { Binding } from "../../hooks/types.ts";
import { printHooksSetHelp } from "../help.ts";
import { resolveEvent, resolveHost, resolveSound } from "./resolve.ts";

const PREFIX = "mac-sounds hooks set";
const HINT = `Try '${PREFIX} --help' for usage.`;

export function runHooksSet(args: readonly string[]): void {
  if (args.includes("-h") || args.includes("--help")) {
    printHooksSetHelp();
    process.exit(0);
  }

  const [hostArg, eventArg, ...soundParts] = args;
  // The sound query can contain spaces (e.g. a multi-word catalog name), so
  // everything past <event> is joined back into one string, the same way
  // `mac-sounds play <query>` treats its trailing arguments.
  const soundArg = soundParts.join(" ").trim();
  if (soundArg === "") {
    process.stderr.write(`${PREFIX}: missing <sound>\n`);
    process.stderr.write(`${HINT}\n`);
    process.exit(1);
  }

  const hostId = resolveHost(PREFIX, HINT, hostArg);
  const adapter = adapterFor(hostId);
  const eventId = resolveEvent(PREFIX, HINT, adapter.events, eventArg);
  const soundPath = resolveSound(PREFIX, HINT, soundArg);

  // Preserve the existing enabled/disabled state when just changing the
  // sound; a brand-new binding starts enabled so setting a sound is
  // immediately live, matching "must not require reinstalling".
  const config = loadConfig();
  const existing = getBinding(config, hostId, eventId);
  const binding: Binding = { hostId, eventId, soundPath, enabled: existing?.enabled ?? true };
  saveConfig(upsertBinding(config, binding));

  console.log(`mac-sounds: ${eventId} on ${adapter.label} -> ${soundPath}`);
  process.exit(0);
}
