// Hooks-management view: lists every host's wiring status and its events,
// and lets the user toggle a binding on/off, preview its sound, or assign a
// different one -- purely by editing mac-sounds' own hooks.json (loadConfig /
// saveConfig). This view never writes a host's real config file
// (~/.claude/settings.json et al.): the dispatcher (src/hooks/dispatch.ts,
// owned elsewhere) reads hooks.json at fire time, so enable/disable and
// (re)assignment are just state changes here, applied immediately. Installing
// mac-sounds into a host's own config is a separate, deliberate CLI action
// (`mac-sounds hooks install <host>`) where a pre-existing hook or a conflict
// can be reported properly -- silently rewriting another tool's config from a
// TUI toggle would be a surprise side effect nobody asked for. If a host
// isn't wired in yet, this view says so and names that exact command instead
// of offering to run it.
//
// Same no-focus invariant as app.tsx: every key goes through this component's
// own `useKeyboard`, and the `<scrollbox>` below stays `focused={false}`.
import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { JSX } from "@opentui/react/jsx-runtime";
import type { ScrollBoxRenderable } from "@opentui/core";
import { useKeyboard } from "@opentui/react";
import { basename } from "node:path";
import type { Catalog } from "../types.ts";
import type { Player } from "../sounds/player.ts";
import { type Binding, type HooksConfig, type HostId } from "../hooks/types.ts";
import { getBinding, loadConfig, saveConfig, setEnabled, upsertBinding } from "../hooks/config.ts";
import { allAdapters } from "../hooks/hosts/registry.ts";
import { filterCatalog } from "../search/filter.ts";
import type { MatchedSound } from "../search/filter.ts";
import { moveSelection } from "./rows.ts";
import { HOOKS_ASSIGN_HELP_TEXT, HOOKS_HELP_TEXT, printableChar, theme } from "./theme.ts";

type Adapter = ReturnType<typeof allAdapters>[number];

type HookRow =
  | { kind: "header"; hostId: HostId; label: string; installed: boolean; wired: boolean }
  | {
      kind: "event";
      hostId: HostId;
      eventId: string;
      eventLabel: string;
      binding: Binding | undefined;
    };

// One row per host, one per its events -- rebuilt from the live adapter list
// plus the current config whenever either changes (i.e. after every
// toggle/assign, not on a timer: nothing else in this view mutates config).
function buildRows(adapters: readonly Adapter[], config: HooksConfig): HookRow[] {
  const rows: HookRow[] = [];
  for (const adapter of adapters) {
    rows.push({
      kind: "header",
      hostId: adapter.id,
      label: adapter.label,
      installed: adapter.isInstalled(),
      wired: adapter.installedEventIds().length > 0,
    });
    for (const event of adapter.events) {
      rows.push({
        kind: "event",
        hostId: adapter.id,
        eventId: event.id,
        eventLabel: event.label,
        binding: getBinding(config, adapter.id, event.id),
      });
    }
  }
  return rows;
}

// A bound sound is stored as an absolute path; resolve it back to a display
// name via the live catalog scan so a rename/rescan is reflected. Falls back
// to the path's own basename if the file no longer appears in the catalog
// (moved or deleted since the binding was made) rather than showing nothing.
function soundDisplayName(catalog: Catalog, path: string): string {
  for (const group of catalog) {
    const found = group.sounds.find((sound) => sound.path === path);
    if (found) return `${found.name}.${found.ext}`;
  }
  return basename(path);
}

// Same score-desc/name-asc ordering as search/filter.ts's own comparator, but
// duplicated here rather than imported: that comparator isn't exported (this
// view doesn't own that file), and assign mode needs a single flat, globally
// ranked list across every group instead of filterCatalog's per-group ones.
function flattenMatches(catalog: Catalog, query: string): MatchedSound[] {
  const all: MatchedSound[] = [];
  for (const group of filterCatalog(catalog, query)) all.push(...group.sounds);
  all.sort((a, b) => (b.score !== a.score ? b.score - a.score : a.name.localeCompare(b.name)));
  return all;
}

// Mirrors app.tsx's RowContainer: a full-width, selectable row with the same
// background-highlight convention. Not shared with app.tsx directly -- that
// would make app.tsx and this file import from each other -- so it's a small,
// deliberate duplicate instead of a cross-file cycle.
function SelectableRow(props: { id: string; selected: boolean; children: ReactNode }): JSX.Element {
  return (
    <box
      id={props.id}
      flexDirection="row"
      justifyContent="space-between"
      backgroundColor={props.selected ? theme.selectedBg : undefined}
    >
      {props.children}
    </box>
  );
}

function renderHookRow(
  row: HookRow,
  index: number,
  selected: boolean,
  catalog: Catalog,
): JSX.Element {
  const id = `hook-row-${index}`;

  if (row.kind === "header") {
    const wiredLabel = row.wired
      ? "wired in"
      : `not wired -- run: mac-sounds hooks install ${row.hostId}`;
    return (
      <SelectableRow key={id} id={id} selected={selected}>
        <text wrapMode="none">
          <strong fg={theme.groupLabel}>{row.label}</strong>
          {row.installed ? "  (installed)" : "  (not installed)"}
        </text>
        <text fg={row.wired ? theme.playing : theme.groupDim} wrapMode="none">
          {wiredLabel}
        </text>
      </SelectableRow>
    );
  }

  const enabled = row.binding?.enabled ?? false;
  const soundLabel = row.binding ? soundDisplayName(catalog, row.binding.soundPath) : "—";
  return (
    <SelectableRow key={id} id={id} selected={selected}>
      <text fg={theme.soundName} wrapMode="none">{`  ${row.eventLabel} (${row.eventId})`}</text>
      <text wrapMode="none">
        <span fg={theme.groupDim}>{soundLabel}</span>
        {"  "}
        <span fg={enabled ? theme.playing : theme.groupDim}>{enabled ? "● on " : "○ off"}</span>
      </text>
    </SelectableRow>
  );
}

function renderAssignRow(sound: MatchedSound, index: number, selected: boolean): JSX.Element {
  const id = `assign-row-${index}`;
  return (
    <SelectableRow key={id} id={id} selected={selected}>
      <text fg={theme.soundName} wrapMode="none">{`  ${sound.name}`}</text>
      <text fg={theme.ext} wrapMode="none">{`.${sound.ext}`}</text>
    </SelectableRow>
  );
}

export function HooksView(props: {
  catalog: Catalog;
  player: Player;
  playerError: string | null;
  onQuit: () => void;
}): JSX.Element {
  const { catalog, player } = props;

  const adapters = useMemo(() => allAdapters(), []);
  const [config, setConfig] = useState<HooksConfig>(() => loadConfig());
  const rows = useMemo(() => buildRows(adapters, config), [adapters, config]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [status, setStatus] = useState<string | null>(null);

  // null: browsing the host/event list. Set while the user is typing a
  // fuzzy-search query to pick a replacement sound for one event.
  const [assignTarget, setAssignTarget] = useState<{ hostId: HostId; eventId: string } | null>(
    null,
  );
  const [assignQuery, setAssignQuery] = useState("");
  const [assignIndex, setAssignIndex] = useState(0);
  const assignResults = useMemo(() => flattenMatches(catalog, assignQuery), [catalog, assignQuery]);

  // Takes a function of the *latest* config rather than a precomputed next
  // value: a burst of same-tick keystrokes (arrow-key auto-repeat, or two
  // quick Space presses) can queue several of these before React re-renders
  // and refreshes the `config` closure, so each one must fold onto whatever
  // the previous one in the same burst just produced, not onto the stale
  // value every callback in the burst was created with.
  function persist(compute: (current: HooksConfig) => HooksConfig): void {
    setConfig((current) => {
      const next = compute(current);
      saveConfig(next);
      return next;
    });
  }

  function toggleSelected(): void {
    const row = rows[selectedIndex];
    if (!row || row.kind !== "event") return;
    if (!row.binding) {
      setStatus("no sound assigned yet -- press 'a' to assign one");
      return;
    }
    setStatus(null);
    const { hostId, eventId } = row;
    persist((current) => {
      const existing = getBinding(current, hostId, eventId);
      return setEnabled(current, hostId, eventId, !(existing?.enabled ?? false));
    });
  }

  function playSelected(): void {
    const row = rows[selectedIndex];
    if (!row || row.kind !== "event") return;
    if (!row.binding) {
      setStatus("no sound assigned yet -- press 'a' to assign one");
      return;
    }
    setStatus(`playing ${soundDisplayName(catalog, row.binding.soundPath)}`);
    player.play(row.binding.soundPath);
  }

  function beginAssign(): void {
    const row = rows[selectedIndex];
    if (!row || row.kind !== "event") {
      setStatus("select an event to assign a sound to it");
      return;
    }
    setAssignTarget({ hostId: row.hostId, eventId: row.eventId });
    setAssignQuery("");
    setAssignIndex(0);
    setStatus(null);
  }

  function commitAssign(hostId: HostId, eventId: string, soundPath: string): void {
    persist((current) => {
      const existing = getBinding(current, hostId, eventId);
      const binding: Binding = { hostId, eventId, soundPath, enabled: existing?.enabled ?? true };
      return upsertBinding(current, binding);
    });
    setAssignTarget(null);
    setAssignQuery("");
    setStatus(`assigned ${soundDisplayName(catalog, soundPath)}`);
  }

  useKeyboard((key) => {
    // Ctrl+K (switch view) and Ctrl+C (quit) are handled once, globally, by
    // app.tsx's own useKeyboard -- which stays mounted regardless of which
    // view is showing. Nothing below needs to duplicate them.
    if (key.ctrl && (key.name === "k" || key.name === "c")) return;

    // Every index/query update below uses the functional setState form,
    // never the closed-over `assignIndex`/`assignQuery`/`selectedIndex`
    // directly: a burst of same-tick keystrokes (arrow-key auto-repeat, or
    // several characters arriving in one paste/write) can queue multiple
    // calls to this handler before React re-renders and refreshes those
    // closures, so reading the outer variable would silently drop all but
    // the last keystroke in the burst. `rows`/`assignResults` themselves
    // don't change from these particular keys, so closing over them is fine.
    if (assignTarget) {
      if (key.ctrl) {
        if (key.name === "p") setAssignIndex((i) => moveSelection(assignResults, i, -1));
        else if (key.name === "n") setAssignIndex((i) => moveSelection(assignResults, i, 1));
        return;
      }
      switch (key.name) {
        case "up":
          setAssignIndex((i) => moveSelection(assignResults, i, -1));
          return;
        case "down":
          setAssignIndex((i) => moveSelection(assignResults, i, 1));
          return;
        case "backspace":
          setAssignQuery((q) => q.slice(0, -1));
          setAssignIndex(0);
          return;
        case "escape":
          setAssignTarget(null);
          setStatus(null);
          return;
        case "return":
        case "enter": {
          const picked = assignResults[assignIndex];
          if (picked) commitAssign(assignTarget.hostId, assignTarget.eventId, picked.path);
          return;
        }
      }
      const ch = printableChar(key);
      if (ch !== null) {
        setAssignQuery((q) => q + ch);
        setAssignIndex(0);
      }
      return;
    }

    if (key.ctrl) {
      if (key.name === "p") setSelectedIndex((i) => moveSelection(rows, i, -1));
      else if (key.name === "n") setSelectedIndex((i) => moveSelection(rows, i, 1));
      return;
    }

    switch (key.name) {
      case "up":
        setSelectedIndex((i) => moveSelection(rows, i, -1));
        return;
      case "down":
        setSelectedIndex((i) => moveSelection(rows, i, 1));
        return;
      case "space":
        toggleSelected();
        return;
      case "return":
      case "enter":
        playSelected();
        return;
      case "escape":
        props.onQuit();
        return;
      case "a":
        beginAssign();
        return;
    }
  });

  const scrollRef = useRef<ScrollBoxRenderable>(null);
  useEffect(() => {
    const id = assignTarget ? `assign-row-${assignIndex}` : `hook-row-${selectedIndex}`;
    scrollRef.current?.scrollChildIntoView(id);
  }, [assignTarget, assignIndex, selectedIndex, rows, assignResults]);

  const enabledCount = config.bindings.filter((binding) => binding.enabled).length;
  const totalEvents = rows.filter((row) => row.kind === "event").length;
  const notice = props.playerError ?? status;

  return (
    <box flexDirection="column" flexGrow={1}>
      <box
        border
        borderColor={theme.border}
        title={assignTarget ? "Assign sound" : "Hooks"}
        flexDirection="row"
        justifyContent="space-between"
        paddingX={1}
        flexShrink={0}
      >
        {assignTarget ? (
          <text wrapMode="none">
            {"> "}
            {assignQuery}
            <span fg={theme.cursor}>{"█"}</span>
          </text>
        ) : (
          <text wrapMode="none">manage lifecycle-hook sound bindings</text>
        )}
        <text fg={theme.groupDim} wrapMode="none">
          {assignTarget
            ? `${assignResults.length} sounds`
            : `${enabledCount}/${totalEvents} enabled`}
        </text>
      </box>
      {/* minHeight=0: same flexbox reason as app.tsx's browser scrollbox. */}
      <scrollbox ref={scrollRef} flexGrow={1} minHeight={0} focused={false}>
        {assignTarget ? (
          assignResults.length === 0 ? (
            <box padding={1}>
              <text fg={theme.groupDim}>no matches</text>
            </box>
          ) : (
            assignResults.map((sound, i) => renderAssignRow(sound, i, i === assignIndex))
          )
        ) : rows.length === 0 ? (
          <box padding={1}>
            <text fg={theme.groupDim}>no hosts</text>
          </box>
        ) : (
          rows.map((row, i) => renderHookRow(row, i, i === selectedIndex, catalog))
        )}
      </scrollbox>
      <box flexDirection="column" paddingX={1} flexShrink={0}>
        <text fg={theme.help} wrapMode="none">
          {HOOKS_HELP_TEXT}
        </text>
        {assignTarget !== null && (
          <text fg={theme.help} wrapMode="none">
            {HOOKS_ASSIGN_HELP_TEXT}
          </text>
        )}
        {notice !== null && (
          <text fg={theme.error} wrapMode="none">
            {notice}
          </text>
        )}
      </box>
    </box>
  );
}
