// Colour constants and the app's non-visual (no-JSX) support logic live here,
// factored out of app.tsx purely to keep that file well under the project's
// line-count ceiling. JSX itself has to stay in app.tsx -- a plain `.ts` file
// can't parse JSX syntax -- so this file holds everything that doesn't need
// it: string/data helpers, the clipboard shell-out, and the printable-key
// heuristic. A palette tweak or a keymap-detail tweak both land here instead
// of touching app.tsx's layout/state code.
import type { Catalog } from "../types.ts";
import type { KeyEvent } from "@opentui/core";
import { filterCatalog } from "../search/filter.ts";
import { buildRows } from "./rows.ts";
import type { Row } from "./rows.ts";

export const theme = {
  border: "#3a3a3a",
  groupLabel: "#87afd7",
  groupDim: "#6c6c6c",
  soundName: "#d0d0d0",
  highlight: "#ffd75f",
  ext: "#6c6c6c",
  selectedBg: "#264653",
  playing: "#87d787",
  error: "#ff6b6b",
  help: "#6c6c6c",
  cursor: "#ffffff",
} as const;

export const HELP_TEXT =
  "Sounds [^K: Hooks]  ↑↓/^P^N move  PgUp/PgDn ×10  Home/End  Enter/Space play·toggle  " +
  "→/← expand/collapse  Tab group  ^S stop  ^Y copy path  ^U clear  " +
  "Esc clear/quit  ^C quit  (space plays a sound, it is not typed)";

// Hooks view's help bar mirrors the browser's: same "current view [switch
// key: other view]" prefix, then the keys that view actually has.
export const HOOKS_HELP_TEXT =
  "Hooks [^K: Sounds]  ↑↓/^P^N move  Space toggle  Enter play  a assign  Esc quit  ^C quit";

// Assign mode reuses the same physical keys (arrows, Enter, Escape) for a
// different purpose -- shown as a second help line only while assigning,
// rather than cramming both key sets into one line all the time.
export const HOOKS_ASSIGN_HELP_TEXT = "assign: type to filter, ↑↓ move, Enter pick, Escape cancel";

// Rebuilds the row list for a hypothetical query/collapsed pair. Pulled out
// as a pure function (catalog passed in, not closed over) so app.tsx can call
// it both for the live, memoized `rows` and for a "what would rows look like
// after this keystroke" preview needed to run `reselect` before committing
// a state change.
export function computeRows(
  catalog: Catalog,
  query: string,
  collapsed: ReadonlySet<string>,
): Row[] {
  return buildRows(filterCatalog(catalog, query), collapsed);
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// A dedicated helper (rather than typing a local as `ReturnType<typeof Bun.spawn>`
// directly) so the process type is inferred from this exact overload -- the
// same reasoning as player.ts's spawnAfplay, needed because Bun.spawn is
// overloaded and `stdin: "pipe"` only resolves to the FileSink-typed overload
// when TypeScript sees it applied to a concrete call.
function spawnPbcopy() {
  return Bun.spawn(["pbcopy"], { stdin: "pipe", stdout: "ignore", stderr: "ignore" });
}

// The whole point of this app is picking a sound and pasting its path into a
// config file elsewhere, so the copy has to land in the real macOS pasteboard
// -- hence shelling out to pbcopy rather than the terminal-only OSC52
// clipboard bridge OpenTUI's core exposes, which only round-trips through the
// terminal emulator and wouldn't reach a GUI app's paste target.
export function copyToClipboard(text: string, onDone: (ok: boolean, detail: string) => void): void {
  let proc: ReturnType<typeof spawnPbcopy>;
  try {
    proc = spawnPbcopy();
  } catch (err) {
    onDone(false, describeError(err));
    return;
  }
  proc.stdin.write(text);
  proc.stdin.end();
  void proc.exited.then((code) => {
    onDone(code === 0, code === 0 ? "" : `pbcopy exited with code ${code}`);
  });
}

// Mirrors the core lib's own printable-character heuristic (its internal
// `textualKey`): a keystroke is "typed text" when its raw sequence is
// non-empty and holds no control bytes. Ctrl-combos are excluded outright --
// every Ctrl+<letter> in this app's keymap is a shortcut, never query text --
// and Space is carved out separately because the keymap reserves it for
// play/toggle instead of typing a literal " ".
export function printableChar(key: KeyEvent): string | null {
  if (key.ctrl) return null;
  if (key.name === "space") return null;
  const seq = key.sequence;
  if (seq.length === 0) return null;
  for (let i = 0; i < seq.length; i++) {
    const code = seq.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return null;
  }
  return seq;
}

// The tone-library directories in particular are ~90 characters long (see
// catalog.ts's TONES_DIR); shown in full they'd force a group row onto two
// terminal lines regardless of wrapMode. Keep the *tail* -- the parent
// directory names near the end are what actually distinguishes one group's
// folder from another's -- rather than the common, uninformative prefix.
export function shortenPath(path: string, maxLen: number): string {
  if (path.length <= maxLen) return path;
  return `…${path.slice(path.length - maxLen + 1)}`;
}

// matchIdx marks positions in `name` that matched the query. Returns
// alternating plain/highlighted runs as plain data; app.tsx turns each run
// into its own <span> since building JSX requires a `.tsx` file.
export function splitHighlight(
  name: string,
  matchIdx: readonly number[],
): { text: string; hl: boolean }[] {
  if (matchIdx.length === 0) return [{ text: name, hl: false }];
  const hit = new Set(matchIdx);
  const parts: { text: string; hl: boolean }[] = [];
  let current = "";
  let currentHl = false;
  for (let i = 0; i < name.length; i++) {
    const hl = hit.has(i);
    if (current.length === 0) currentHl = hl;
    if (hl !== currentHl) {
      parts.push({ text: current, hl: currentHl });
      current = "";
      currentHl = hl;
    }
    current += name.charAt(i);
  }
  parts.push({ text: current, hl: currentHl });
  return parts;
}
