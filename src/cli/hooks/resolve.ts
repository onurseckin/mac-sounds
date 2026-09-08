import { existsSync } from "node:fs";
import { isAbsolute } from "node:path";
import { filterCatalog } from "../../search/filter.ts";
import type { MatchedSound } from "../../search/filter.ts";
import { loadCatalog } from "../../sounds/catalog.ts";
import { HOST_IDS, isHostId } from "../../hooks/types.ts";
import type { HookEvent, HostId } from "../../hooks/types.ts";

// Every hooks subcommand fails the same three ways -- bad host, bad event,
// bad sound -- so the message format and exit code live here once instead of
// being duplicated across install/uninstall/set/enable/disable/hook.
function fail(prefix: string, hint: string, message: string): never {
  process.stderr.write(`${prefix}: ${message}\n`);
  process.stderr.write(`${hint}\n`);
  process.exit(1);
}

export function resolveHost(prefix: string, hint: string, raw: string | undefined): HostId {
  if (raw === undefined) fail(prefix, hint, "missing <host>");
  if (!isHostId(raw)) {
    fail(prefix, hint, `unknown host '${raw}' (known hosts: ${HOST_IDS.join(", ")})`);
  }
  return raw;
}

export function resolveEvent(
  prefix: string,
  hint: string,
  events: readonly HookEvent[],
  raw: string | undefined,
): string {
  if (raw === undefined) fail(prefix, hint, "missing <event>");
  const known = events.map((event) => event.id);
  if (!known.includes(raw)) {
    fail(prefix, hint, `unknown event '${raw}' for this host (known events: ${known.join(", ")})`);
  }
  return raw;
}

// Highest-scoring sound(s) across the whole catalog, flattened out of
// filterCatalog's per-group grouping -- "hooks set" cares about one global
// winner (or a tie to report as ambiguous), not which group it came from.
function topMatches(query: string): MatchedSound[] {
  const all: MatchedSound[] = [];
  for (const { sounds } of filterCatalog(loadCatalog(), query)) {
    all.push(...sounds);
  }
  if (all.length === 0) return [];

  const topScore = Math.max(...all.map((sound) => sound.score));
  return all.filter((sound) => sound.score === topScore);
}

// Resolves `raw` to an absolute sound path: a path is used as-is (after an
// existence check), anything else is fuzzy-matched against the catalog.
// Exits with a clear message rather than ever guessing between two equally
// good but differently-named matches.
export function resolveSound(prefix: string, hint: string, raw: string): string {
  if (isAbsolute(raw)) {
    if (!existsSync(raw)) fail(prefix, hint, `no such file '${raw}'`);
    return raw;
  }

  const matches = topMatches(raw);
  if (matches.length === 0) {
    fail(prefix, hint, `no sound matches '${raw}' (try 'mac-sounds list' to browse)`);
  }

  const [first] = matches;
  // matches.length > 0 was just checked, so this is always defined; the
  // fallback only satisfies noUncheckedIndexedAccess.
  if (first === undefined) fail(prefix, hint, `no sound matches '${raw}'`);

  // A tie at the top score is only a real ambiguity when it's between
  // *different-looking* names (e.g. two sounds that both fuzzy-match
  // equally well) -- the same name showing up twice (e.g. the system
  // "Glass" and the Classic alert tone also named "Glass") isn't a choice
  // the user needs to make, so catalog order (the same order 'mac-sounds
  // list' prints) picks a winner deterministically.
  const distinctNames = new Set(matches.map((sound) => sound.name));
  if (distinctNames.size > 1) {
    fail(prefix, hint, `'${raw}' is ambiguous -- close matches: ${[...distinctNames].join(", ")}`);
  }

  return first.path;
}
