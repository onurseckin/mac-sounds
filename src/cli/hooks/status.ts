import { basename } from "node:path";
import { allAdapters } from "../../hooks/hosts/registry.ts";
import { getBinding, loadConfig } from "../../hooks/config.ts";
import type { HooksConfig } from "../../hooks/types.ts";

// Derived from allAdapters()'s own return type rather than importing a named
// HostAdapter type -- this file only ever handles adapters that came out of
// that function, so there is nothing to gain from naming the interface
// directly, and one less import path to keep in sync with hosts/adapter.ts.
type Adapter = ReturnType<typeof allAdapters>[number];

const UNBOUND = "(unbound)";

function eventLine(adapter: Adapter, config: HooksConfig, idWidth: number, soundWidth: number) {
  return (eventId: string): string => {
    const binding = getBinding(config, adapter.id, eventId);
    const sound = binding === undefined ? UNBOUND : basename(binding.soundPath);
    const state = binding === undefined ? "-" : binding.enabled ? "on" : "off";
    return `  ${eventId.padEnd(idWidth)}  ${sound.padEnd(soundWidth)}  ${state}`;
  };
}

// One block per host: a status line (installed? wired in?), an optional
// hint when the host isn't installed, then one row per event so the whole
// thing is scannable without cross-referencing anything else.
function renderHost(adapter: Adapter, config: HooksConfig): string {
  const installed = adapter.isInstalled();
  const wiredCount = adapter.installedEventIds().length;
  const wiredLabel =
    wiredCount === 0
      ? "mac-sounds not wired in"
      : `mac-sounds wired in (${wiredCount}/${adapter.events.length} events)`;

  const lines = [
    `${adapter.id} (${adapter.label}) -- ${installed ? "installed" : "not installed"}, ${wiredLabel}`,
  ];
  if (!installed) {
    lines.push(
      `  hint: install ${adapter.label} first, then run 'mac-sounds hooks install ${adapter.id}'`,
    );
  }

  const eventIds = adapter.events.map((event) => event.id);
  const idWidth = Math.max(...eventIds.map((id) => id.length), "event".length);
  const soundWidth = Math.max(
    ...adapter.events.map((event) => {
      const binding = getBinding(config, adapter.id, event.id);
      return binding === undefined ? UNBOUND.length : basename(binding.soundPath).length;
    }),
    "sound".length,
  );

  lines.push(`  ${"event".padEnd(idWidth)}  ${"sound".padEnd(soundWidth)}  on/off`);
  lines.push(...eventIds.map(eventLine(adapter, config, idWidth, soundWidth)));

  return lines.join("\n");
}

export function runHooksStatus(): void {
  const config = loadConfig();
  const blocks = allAdapters().map((adapter) => renderHost(adapter, config));
  console.log(blocks.join("\n\n"));
  process.exit(0);
}
