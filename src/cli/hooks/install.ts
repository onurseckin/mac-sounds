import { HostConflictError } from "../../hooks/hosts/adapter.ts";
import { adapterFor } from "../../hooks/hosts/registry.ts";
import { writeShim } from "../../hooks/shim.ts";
import { bindingsForHost, loadConfig, saveConfig, upsertBinding } from "../../hooks/config.ts";
import type { Binding, HostId } from "../../hooks/types.ts";
import {
  COMPLETION_STYLE_EVENT_IDS,
  DEFAULT_COMPLETION_SOUND,
  DEFAULT_FAILURE_SOUND,
  FAILURE_STYLE_EVENT_IDS,
} from "../constants.ts";
import { printHooksInstallHelp } from "../help.ts";
import { resolveHost } from "./resolve.ts";

const PREFIX = "mac-sounds hooks install";
const HINT = `Try '${PREFIX} --help' for usage.`;

function defaultSoundFor(eventId: string): string | null {
  if (COMPLETION_STYLE_EVENT_IDS.includes(eventId)) return DEFAULT_COMPLETION_SOUND;
  if (FAILURE_STYLE_EVENT_IDS.includes(eventId)) return DEFAULT_FAILURE_SOUND;
  return null;
}

// Seeds sensible defaults only when the host has zero bindings of its own --
// a host the user has already touched (even partially) is left exactly as
// they set it, never overwritten by a re-install.
function seedDefaults(hostId: HostId, eventIds: readonly string[]): void {
  let config = loadConfig();
  if (bindingsForHost(config, hostId).length > 0) return;

  for (const eventId of eventIds) {
    const soundPath = defaultSoundFor(eventId);
    if (soundPath === null) continue; // no sensible default -- leave unbound
    const binding: Binding = { hostId, eventId, soundPath, enabled: true };
    config = upsertBinding(config, binding);
  }
  saveConfig(config);
}

interface ParsedArgs {
  hostArg: string | undefined;
  force: boolean;
}

function parseArgs(args: readonly string[]): ParsedArgs {
  let hostArg: string | undefined;
  let force = false;

  for (const arg of args) {
    if (arg === "--force") {
      force = true;
      continue;
    }
    if (hostArg !== undefined) {
      process.stderr.write(`${PREFIX}: unexpected argument '${arg}'\n`);
      process.stderr.write(`${HINT}\n`);
      process.exit(1);
    }
    hostArg = arg;
  }

  return { hostArg, force };
}

export function runHooksInstall(args: readonly string[]): void {
  if (args.includes("-h") || args.includes("--help")) {
    printHooksInstallHelp();
    process.exit(0);
  }

  const { hostArg, force } = parseArgs(args);
  const hostId = resolveHost(PREFIX, HINT, hostArg);
  const adapter = adapterFor(hostId);
  const eventIds = adapter.events.map((event) => event.id);

  // writeShim() is safe to run before the conflict check: it's idempotent
  // and only ever touches mac-sounds' own directory, never the host's
  // config or our own bindings. adapter.install(...) is the one call that
  // can fail (HostConflictError) -- a refused install must be a complete
  // no-op, so nothing below this point may persist state (seeded bindings
  // included) until install() has actually returned successfully.
  const shimPath = writeShim();

  try {
    adapter.install({ shimPath, eventIds, force });
  } catch (error) {
    if (error instanceof HostConflictError) {
      process.stderr.write(
        `${PREFIX}: ${adapter.label} already has entries mac-sounds didn't write:\n`,
      );
      for (const conflict of error.conflicts) {
        process.stderr.write(`  ${conflict.eventId}: ${conflict.command}\n`);
      }
      process.stderr.write("Re-run with --force to overwrite them.\n");
      process.exit(1);
    }
    throw error;
  }

  seedDefaults(hostId, eventIds);

  console.log(
    `mac-sounds: wired ${eventIds.length} event(s) into ${adapter.label} (${adapter.configPath()})`,
  );
  process.exit(0);
}
