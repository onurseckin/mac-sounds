import { adapterFor } from "../../hooks/hosts/registry.ts";
import {
  bindingsForHost,
  getBinding,
  loadConfig,
  saveConfig,
  setEnabled,
} from "../../hooks/config.ts";
import { printHooksDisableHelp, printHooksEnableHelp } from "../help.ts";
import { resolveEvent, resolveHost } from "./resolve.ts";

const ENABLE_PREFIX = "mac-sounds hooks enable";
const DISABLE_PREFIX = "mac-sounds hooks disable";

// enable and disable are identical except for the target boolean, the
// prefix used in messages, and which help text prints -- so one function
// backs both public entry points below.
function runToggle(args: readonly string[], enabled: boolean): void {
  const prefix = enabled ? ENABLE_PREFIX : DISABLE_PREFIX;
  const hint = `Try '${prefix} --help' for usage.`;

  if (args.includes("-h") || args.includes("--help")) {
    (enabled ? printHooksEnableHelp : printHooksDisableHelp)();
    process.exit(0);
  }

  const [hostArg, eventArg] = args;
  const hostId = resolveHost(prefix, hint, hostArg);
  const adapter = adapterFor(hostId);
  const verb = enabled ? "enabled" : "disabled";
  // This only ever touches mac-sounds' own state file, never the host's
  // config -- that's exactly why it takes effect instantly.
  const note = `mac-sounds state only, ${adapter.label}'s config untouched`;

  let config = loadConfig();

  if (eventArg === undefined) {
    const existing = bindingsForHost(config, hostId);
    if (existing.length === 0) {
      process.stderr.write(
        `${prefix}: no sounds assigned yet for ${adapter.label} -- run 'mac-sounds hooks install ${hostId}' or 'mac-sounds hooks set ${hostId} <event> <sound>' first\n`,
      );
      process.exit(1);
    }
    for (const binding of existing) {
      config = setEnabled(config, hostId, binding.eventId, enabled);
    }
    saveConfig(config);
    console.log(`mac-sounds: ${verb} ${existing.length} event(s) for ${adapter.label} (${note})`);
    process.exit(0);
  }

  const eventId = resolveEvent(prefix, hint, adapter.events, eventArg);
  if (getBinding(config, hostId, eventId) === undefined) {
    // Disabling an unbound event is idempotent: with no sound wired up, the
    // event is already "off" in every sense a caller can observe, so this
    // must succeed (and must not create a binding) -- that's what makes
    // scripting `hooks disable` safe without checking state first. Enabling
    // has no such out: there's no sound to turn on, so it keeps failing
    // below. This asymmetry between the two verbs is deliberate, not a bug
    // to "fix" into symmetry.
    if (!enabled) {
      console.log(
        `mac-sounds: no sound assigned to '${eventId}' for ${adapter.label} -- nothing to disable`,
      );
      process.exit(0);
    }
    process.stderr.write(
      `${prefix}: no sound assigned to '${eventId}' for ${adapter.label} -- run 'mac-sounds hooks set ${hostId} ${eventId} <sound>' first\n`,
    );
    process.exit(1);
  }
  config = setEnabled(config, hostId, eventId, enabled);
  saveConfig(config);
  console.log(`mac-sounds: ${verb} ${eventId} for ${adapter.label} (${note})`);
  process.exit(0);
}

export function runHooksEnable(args: readonly string[]): void {
  runToggle(args, true);
}

export function runHooksDisable(args: readonly string[]): void {
  runToggle(args, false);
}
