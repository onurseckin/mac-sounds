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
export function moveSelection(rows: readonly Row[], index: number, delta: number): number {
  if (rows.length === 0) return 0;
  const next = index + delta;
  if (next < 0) return 0;
  if (next > rows.length - 1) return rows.length - 1;
  return next;
}

export function reselect(rows: readonly Row[], previous: Row | undefined): number {
  if (rows.length === 0 || previous === undefined) return 0;

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

  // Nothing recognizable survived the re-filter or toggle. The signature
  // deliberately takes the previous *row*, not a previous *index* — this
  // helper has no numeric position to clamp back into range, only identity
  // to match on. So "clamp the old index" and "just use 0" collapse into the
  // same answer here: 0 is the nearest valid index we can justify without
  // more information. A caller that wants literal position preservation
  // instead of identity preservation would need to track and clamp its own
  // index rather than lean on this helper.
  return 0;
}
