// Flattens the filtered group/sound tree into the single list the TUI actually
// scrolls and paints, and carries the selection-index math that list needs.
// Kept separate from rendering so the navigation rules have one home instead
// of being reinvented wherever the key handler lives.

import type { FilteredGroup, MatchedSound } from "../search/filter";

export type Row =
  | { kind: "group"; groupId: string; label: string; dir: string; count: number; expanded: boolean }
  | { kind: "sound"; sound: MatchedSound; groupId: string };

/**
 * `collapsed` holds the ids the user has explicitly closed, not the ids that
 * are open. That way a group id nobody has seen before — freshly scanned
 * disk contents, or the first paint of the app — reads as "not in the
 * collapsed set" and starts expanded with zero setup. Tracking "expanded"
 * instead would require seeding every new id into that set the moment it
 * appears, which is exactly the kind of bookkeeping this flattening step is
 * meant to avoid.
 */
export function buildRows(groups: FilteredGroup[], collapsed: ReadonlySet<string>): Row[] {
  const rows: Row[] = [];
  for (const { group, sounds } of groups) {
    const expanded = !collapsed.has(group.id);
    rows.push({
      kind: "group",
      groupId: group.id,
      label: group.label,
      dir: group.dir,
      // Count reflects `sounds` (the already-filtered list for this group),
      // not `group.sounds` (the full on-disk list) — the header should show
      // what the current search matched, not the group's total size.
      count: sounds.length,
      expanded,
    });
    if (expanded) {
      for (const sound of sounds) {
        rows.push({ kind: "sound", sound, groupId: group.id });
      }
    }
  }
  return rows;
}

/**
 * Group header rows are selectable, same as sound rows: the user has to be
 * able to move the cursor onto a header in order to collapse or expand it,
 * so there is no "unselectable" row kind here to skip over.
 */
// Generic in the row type: the math only ever needs `rows.length`, so the
// hooks view's flat list (host headers + events) and its assign-mode sound
// list reuse this instead of each hand-rolling the same clamp.
export function moveSelection<T>(rows: readonly T[], index: number, delta: number): number {
  if (rows.length === 0) return 0;
  const next = index + delta;
  if (next < 0) return 0;
  if (next > rows.length - 1) return rows.length - 1;
  return next;
}

/**
 * Resolution order: the previous sound's own path, then its group (a header
 * row's `groupId` matches too), then `previousIndex` clamped into the new
 * range, then `0`. Path/group identity is tried first because a row's
 * numeric position shifts under ordinary use — collapsing a group above it,
 * or a query narrowing the list, moves everything below it — so re-finding
 * the same sound (or at least the same group) lands on what the user was
 * actually looking at, which its old numeric index can no longer promise.
 * `previousIndex` only matters once identity is unrecoverable, e.g. the
 * selected sound itself got filtered out by a narrower query: clamping it
 * keeps the cursor near its old screen position instead of resetting to the
 * top of the list.
 */
export function reselect(
  rows: readonly Row[],
  previous: Row | undefined,
  previousIndex?: number,
): number {
  if (rows.length === 0) return 0;

  if (previous !== undefined) {
    if (previous.kind === "sound") {
      const byPath = rows.findIndex(
        (row) => row.kind === "sound" && row.sound.path === previous.sound.path,
      );
      if (byPath !== -1) return byPath;
    }

    // Same group survived even though the exact sound didn't (or `previous`
    // was a header row itself) — land on it rather than jumping back to the
    // top. `findIndex` naturally lands on the group's own header row first,
    // since it's pushed before any of its sound rows in buildRows.
    const byGroup = rows.findIndex((row) => row.groupId === previous.groupId);
    if (byGroup !== -1) return byGroup;
  }

  // Identity is gone -- either nothing matched above, or there was no
  // previous row to match against at all. Clamp the caller's last numeric
  // index into the new range instead of conceding to 0 outright, so a search
  // that narrows the list keeps the cursor near where it was rather than
  // sending it to the top; only a caller with no index either falls back to 0.
  if (previousIndex !== undefined) {
    return Math.min(Math.max(previousIndex, 0), rows.length - 1);
  }
  return 0;
}
