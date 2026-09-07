import type { Catalog, SoundFile, SoundGroup } from "../types";

// The whole catalog is ~70 short strings loaded once at startup. Shelling out to
// ripgrep/fd per keystroke would mean spawning a process, paying IPC/serialization
// cost, and adding an external binary dependency -- all to search less data than
// fits in an L1 cache. A plain in-memory subsequence matcher runs in microseconds
// and needs nothing installed on the user's machine.

export interface MatchedSound extends SoundFile {
  /** Higher is better. 0 when the query is empty. */
  score: number;
  /** Indices into `name` that matched, for highlighting. Empty when query is empty. */
  matchIdx: number[];
}

export interface FilteredGroup {
  group: SoundGroup;
  sounds: MatchedSound[];
}

// Tuning knobs for the scorer. Values are relative to each other, not absolute:
// a contiguous run of matches should comfortably beat a scattered one, and
// landing on a word boundary should beat landing mid-word.
const START_BONUS = 12; // matched at index 0 of the target
const BOUNDARY_BONUS = 9; // matched right after a space / '-' / '_'
const CONSECUTIVE_BONUS = 15; // this match immediately follows the previous one
const GAP_PENALTY = 3; // flat cost per non-consecutive jump (not per skipped char --
// a single unmatched char and a run of ten unmatched chars both just mean "the
// alignment wasn't contiguous here", so charging per-char would over-punish
// long names for one stray gap)
const LENGTH_PENALTY = 0.02; // tiny per-char cost so shorter names win ties

function isWordBoundary(ch: string): boolean {
  return ch === " " || ch === "-" || ch === "_";
}

interface RawMatch {
  score: number;
  matchIdx: number[];
}

// Subsequence match with a score, via a single backward pass -- no DP table.
// At catalog sizes like this one (~66 short filenames), a full fzy-style 2-D
// table earns nothing but indexing headaches, so we bind each query
// character directly to a target position instead.
//
// We walk the query from its *last* character to its first. For each one we
// scan `target` leftward from a shrinking `bound` and take the first (i.e.
// rightmost) occurrence we hit. Binding late characters as far right as
// possible, then requiring every earlier character to land strictly before
// that, guarantees a valid left-to-right subsequence alignment without ever
// needing to backtrack or compare alternate paths. Scoring falls out of the
// same pass: we already know, for each match, whether it sits next to the
// match found in the previous (i.e. following) iteration, so contiguous runs
// and gaps are detected with a couple of local variables instead of a table.
function subsequenceMatch(query: string, target: string): RawMatch | null {
  const q = query.toLowerCase();
  const t = target.toLowerCase();
  const m = q.length;
  const n = t.length;
  if (m === 0) return { score: 0, matchIdx: [] };
  if (m > n) return null;

  const reversedIdx: number[] = []; // filled last query char first, reversed before returning
  let bound = n - 1; // this and all earlier query chars must land at or before this index
  let rightNeighbourIdx = -1; // target index bound to the query char one position to the right; -1 for the last char
  let score = 0;

  for (let qi = m - 1; qi >= 0; qi--) {
    let ti = bound;
    while (ti >= 0 && t[ti] !== q[qi]) ti--;
    if (ti < 0) return null; // no valid subsequence alignment exists

    if (ti === 0) {
      score += START_BONUS;
    } else {
      const prevCh = t[ti - 1];
      if (prevCh !== undefined && isWordBoundary(prevCh)) score += BOUNDARY_BONUS;
    }
    if (rightNeighbourIdx !== -1) {
      if (rightNeighbourIdx === ti + 1) {
        score += CONSECUTIVE_BONUS;
      } else {
        score -= GAP_PENALTY;
      }
    }

    reversedIdx.push(ti);
    rightNeighbourIdx = ti;
    bound = ti - 1;
  }

  reversedIdx.reverse();
  return { score, matchIdx: reversedIdx };
}

function scoreName(query: string, name: string): RawMatch | null {
  const match = subsequenceMatch(query, name);
  if (!match) return null;
  return { score: match.score - name.length * LENGTH_PENALTY, matchIdx: match.matchIdx };
}

function compareMatches(a: MatchedSound, b: MatchedSound): number {
  if (a.score !== b.score) return b.score - a.score;
  return a.name.localeCompare(b.name);
}

export function filterCatalog(catalog: Catalog, query: string): FilteredGroup[] {
  const trimmed = query.trim();

  if (trimmed === "") {
    return catalog.map((group) => ({
      group,
      sounds: group.sounds.map((sound) => ({ ...sound, score: 0, matchIdx: [] })),
    }));
  }

  const result: FilteredGroup[] = [];
  for (const group of catalog) {
    // A query can also match the group label instead of any individual sound
    // name (e.g. "modern" against the group id/label "modern"). When it does,
    // the whole group is revealed -- sounds whose own name also matches keep
    // their real name-derived score/highlight; the rest ride along at the
    // label's match score with no highlighted characters, since matchIdx is
    // defined against `name`, not `label`.
    const labelMatch = subsequenceMatch(trimmed, group.label);
    const matched: MatchedSound[] = [];

    for (const sound of group.sounds) {
      const nameMatch = scoreName(trimmed, sound.name);
      if (nameMatch) {
        matched.push({ ...sound, score: nameMatch.score, matchIdx: nameMatch.matchIdx });
      } else if (labelMatch) {
        matched.push({ ...sound, score: labelMatch.score, matchIdx: [] });
      }
    }

    if (matched.length > 0) {
      matched.sort(compareMatches);
      result.push({ group, sounds: matched });
    }
  }
  return result;
}
