import { COMMANDS } from "./constants.ts";
import type { CommandName } from "./constants.ts";

// Beyond this edit distance, a typo isn't a "did you mean" -- it's just a
// different word, and guessing anyway would be more confusing than silence.
const MAX_SUGGEST_DISTANCE = 2;

// Classic O(len(a) * len(b)) edit distance over two rolling rows. Command
// names here are all under 10 characters, so there's nothing to optimize.
function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  let prevRow: number[] = Array.from({ length: n + 1 }, (_, j) => j);

  for (let i = 1; i <= m; i++) {
    const currRow: number[] = [i];
    for (let j = 1; j <= n; j++) {
      // prevRow always holds n+1 entries, and currRow already holds j entries
      // at this point in the inner loop, so every read below is in bounds --
      // the `?? 0` fallbacks exist only to satisfy noUncheckedIndexedAccess.
      const deleteCost = (prevRow[j] ?? 0) + 1;
      const insertCost = (currRow[j - 1] ?? 0) + 1;
      const substituteCost = (prevRow[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1);
      currRow.push(Math.min(deleteCost, insertCost, substituteCost));
    }
    prevRow = currRow;
  }

  return prevRow[n] ?? Math.max(m, n);
}

// A small, low-stakes heuristic: catch obvious typos ("gropus" -> "groups")
// without pretending to be a real spell-checker.
export function suggestCommand(input: string): CommandName | null {
  const lowered = input.toLowerCase();
  let best: CommandName | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (const command of COMMANDS) {
    const distance = levenshtein(lowered, command.name);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = command.name;
    }
  }

  return best !== null && bestDistance <= MAX_SUGGEST_DISTANCE ? best : null;
}
