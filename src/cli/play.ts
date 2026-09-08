import { loadCatalog } from "../sounds/catalog.ts";
import { filterCatalog } from "../search/filter.ts";
import type { FilteredGroup, MatchedSound } from "../search/filter.ts";
import { createPlayer } from "../sounds/player.ts";
import type { Player } from "../sounds/player.ts";
import { printCommandHelp } from "./help.ts";

// createPlayer()'s public API is play/stop/isPlaying/current/dispose -- there
// is no promise that resolves at end-of-playback. Polling isPlaying() is the
// only way to await "done" through that surface without reaching into
// src/sounds/player.ts, which this task doesn't own.
const POLL_INTERVAL_MS = 50;

function waitUntilStopped(player: Player): Promise<void> {
  return new Promise((resolve) => {
    const timer = setInterval(() => {
      if (!player.isPlaying()) {
        clearInterval(timer);
        resolve();
      }
    }, POLL_INTERVAL_MS);
  });
}

// filterCatalog already sorts each group's own sounds by score, but groups
// stay in catalog order relative to each other, so the true best match has to
// be found by scanning across all of them.
function bestMatch(groups: readonly FilteredGroup[]): MatchedSound | null {
  let best: MatchedSound | null = null;
  for (const { sounds } of groups) {
    for (const sound of sounds) {
      if (
        best === null ||
        sound.score > best.score ||
        (sound.score === best.score && sound.name.localeCompare(best.name) < 0)
      ) {
        best = sound;
      }
    }
  }
  return best;
}

export async function runPlay(args: readonly string[]): Promise<void> {
  if (args.includes("-h") || args.includes("--help")) {
    printCommandHelp("play");
    process.exit(0);
  }

  const query = args.join(" ").trim();
  if (query === "") {
    process.stderr.write("mac-sounds play: missing <query>\n");
    process.stderr.write("Try 'mac-sounds play --help' for usage.\n");
    process.exit(1);
  }

  const match = bestMatch(filterCatalog(loadCatalog(), query));
  if (match === null) {
    process.stderr.write(`mac-sounds play: no sound matches '${query}'\n`);
    process.exit(1);
  }

  // The chosen sound goes to stderr, never stdout: a caller piping
  // `mac-sounds play ...` for its output expects clean stdout.
  process.stderr.write(`mac-sounds play: playing ${match.name} (${match.path})\n`);

  let failed = false;
  const player = createPlayer({
    onError: (message) => {
      failed = true;
      process.stderr.write(`mac-sounds play: ${message}\n`);
    },
  });
  player.play(match.path);
  await waitUntilStopped(player);
  player.dispose();
  process.exit(failed ? 1 : 0);
}
