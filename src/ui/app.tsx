// Every keystroke here goes through the global `useKeyboard` hook; nothing is
// ever focused. A focused <input>/<select>/<scrollbox> consumes arrow keys,
// Enter, Space, Home/End, PageUp/PageDown internally (a renderable only gets
// key input while `focused`), which would fight this app's list navigation on
// those exact keys. So the query is plain React state rendered as `<text>`,
// and `<scrollbox>` below is pinned to `focused={false}`.
import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { JSX } from "@opentui/react/jsx-runtime";
import type { ScrollBoxRenderable } from "@opentui/core";
import { useKeyboard } from "@opentui/react";
import { loadCatalog } from "../sounds/catalog.ts";
import { createPlayer } from "../sounds/player.ts";
import { filterCatalog } from "../search/filter.ts";
import { moveSelection, reselect } from "./rows.ts";
import type { Row } from "./rows.ts";
import { HooksView } from "./hooks-view.tsx";
import {
  HELP_TEXT,
  computeRows,
  copyToClipboard,
  printableChar,
  shortenPath,
  splitHighlight,
  theme,
} from "./theme.ts";

// Ctrl+K toggles between the two top-level views. Kept as a plain union
// rather than a boolean so a third view can be added later without a rename.
type ViewName = "browser" | "hooks";

// Every <text> below pins wrapMode="none": OpenTUI's default word-wrap would
// otherwise let a long path (tone-library dirs run ~90 chars) spill onto a
// second physical line, turning one logical row into two on screen.
function RowContainer(props: { id: string; selected: boolean; children: ReactNode }): JSX.Element {
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

function renderRow(
  row: Row,
  index: number,
  selected: boolean,
  playingPath: string | null,
): JSX.Element {
  const id = `row-${index}`;
  const playing = row.kind === "sound" && row.sound.path === playingPath;
  if (row.kind === "group") {
    const marker = row.expanded ? "▾" : "▸";
    return (
      <RowContainer key={id} id={id} selected={selected}>
        <text wrapMode="none">
          {`${marker} `}
          <strong fg={theme.groupLabel}>{row.label}</strong>
          {` (${row.count})`}
        </text>
        <text fg={theme.groupDim} wrapMode="none">
          {shortenPath(row.dir, 40)}
        </text>
      </RowContainer>
    );
  }
  return (
    <RowContainer key={id} id={id} selected={selected}>
      <text fg={theme.soundName} wrapMode="none">
        {playing ? <span fg={theme.playing}>{"♪ "}</span> : "  "}
        {splitHighlight(row.sound.name, row.sound.matchIdx).map((part, i) =>
          part.hl ? (
            <span key={i} fg={theme.highlight}>
              {part.text}
            </span>
          ) : (
            part.text
          ),
        )}
      </text>
      <text fg={theme.ext} wrapMode="none">{`.${row.sound.ext}`}</text>
    </RowContainer>
  );
}

export function App(props: { onQuit: () => void }): JSX.Element {
  const catalog = useMemo(() => loadCatalog(), []);
  const totalCount = useMemo(() => catalog.reduce((n, g) => n + g.sounds.length, 0), [catalog]);

  const [view, setView] = useState<ViewName>("browser");
  const [query, setQuery] = useState("");
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [playerError, setPlayerError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  const player = useMemo(() => createPlayer({ onError: (message) => setPlayerError(message) }), []);
  useEffect(() => () => player.dispose(), [player]);

  const filtered = useMemo(() => filterCatalog(catalog, query), [catalog, query]);
  const matchedCount = useMemo(() => filtered.reduce((n, g) => n + g.sounds.length, 0), [filtered]);
  const rows = useMemo(() => computeRows(catalog, query, collapsed), [catalog, query, collapsed]);

  function applyQuery(nextQuery: string): void {
    const previous = rows[selectedIndex];
    const nextRows = computeRows(catalog, nextQuery, collapsed);
    setQuery(nextQuery);
    setSelectedIndex(reselect(nextRows, previous, selectedIndex));
  }

  function applyCollapsed(nextCollapsed: Set<string>): void {
    const previous = rows[selectedIndex];
    const nextRows = computeRows(catalog, query, nextCollapsed);
    setCollapsed(nextCollapsed);
    setSelectedIndex(reselect(nextRows, previous, selectedIndex));
  }

  function toggleGroup(groupId: string): void {
    const next = new Set(collapsed);
    if (next.has(groupId)) next.delete(groupId);
    else next.add(groupId);
    applyCollapsed(next);
  }

  function handleActivate(): void {
    const row = rows[selectedIndex];
    if (!row) return;
    if (row.kind === "sound") {
      setPlayerError(null);
      player.play(row.sound.path);
    } else {
      toggleGroup(row.groupId);
    }
  }

  function handleExpand(): void {
    const row = rows[selectedIndex];
    if (!row || row.kind !== "group" || !collapsed.has(row.groupId)) return;
    const next = new Set(collapsed);
    next.delete(row.groupId);
    applyCollapsed(next);
  }

  function handleCollapseOrJump(): void {
    const row = rows[selectedIndex];
    if (!row) return;
    if (row.kind === "group") {
      if (collapsed.has(row.groupId)) return;
      const next = new Set(collapsed);
      next.add(row.groupId);
      applyCollapsed(next);
    } else {
      const headerIndex = rows.findIndex((r) => r.kind === "group" && r.groupId === row.groupId);
      if (headerIndex !== -1) setSelectedIndex(headerIndex);
    }
  }

  function copySelectedPath(): void {
    const row = rows[selectedIndex];
    if (!row || row.kind !== "sound") {
      setStatus("select a sound to copy its path");
      return;
    }
    const path = row.sound.path;
    copyToClipboard(path, (ok, detail) => {
      setStatus(ok ? `copied ${path}` : `copy failed: ${detail}`);
    });
  }

  useKeyboard((key) => {
    // Ctrl+K (switch view) and Ctrl+C (quit) work from either view -- this
    // handler stays mounted the whole session, unlike HooksView's own
    // useKeyboard which only exists while that view is on screen -- so they
    // are handled once, here, before the browser-only guard below.
    if (key.ctrl && key.name === "k") {
      setView((v) => (v === "browser" ? "hooks" : "browser"));
      return;
    }
    if (key.ctrl && key.name === "c") {
      props.onQuit();
      return;
    }
    if (view !== "browser") return;

    if (key.ctrl) {
      switch (key.name) {
        case "u":
          applyQuery("");
          return;
        case "p":
          setSelectedIndex(moveSelection(rows, selectedIndex, -1));
          return;
        case "n":
          setSelectedIndex(moveSelection(rows, selectedIndex, 1));
          return;
        case "s":
          player.stop();
          return;
        case "y":
          copySelectedPath();
          return;
      }
      return;
    }

    switch (key.name) {
      case "up":
        setSelectedIndex(moveSelection(rows, selectedIndex, -1));
        return;
      case "down":
        setSelectedIndex(moveSelection(rows, selectedIndex, 1));
        return;
      case "pageup":
        setSelectedIndex(moveSelection(rows, selectedIndex, -10));
        return;
      case "pagedown":
        setSelectedIndex(moveSelection(rows, selectedIndex, 10));
        return;
      case "home":
        setSelectedIndex(0);
        return;
      case "end":
        setSelectedIndex(rows.length > 0 ? rows.length - 1 : 0);
        return;
      case "backspace":
        if (query.length > 0) applyQuery(query.slice(0, -1));
        return;
      case "escape":
        if (query.length > 0) applyQuery("");
        else props.onQuit();
        return;
      case "return":
      case "enter":
      case "space":
        handleActivate();
        return;
      case "right":
        handleExpand();
        return;
      case "left":
        handleCollapseOrJump();
        return;
      case "tab": {
        const row = rows[selectedIndex];
        if (row) toggleGroup(row.groupId);
        return;
      }
    }

    const ch = printableChar(key);
    if (ch !== null) applyQuery(query + ch);
  });

  const scrollRef = useRef<ScrollBoxRenderable>(null);
  useEffect(() => {
    scrollRef.current?.scrollChildIntoView(`row-${selectedIndex}`);
  }, [selectedIndex, rows]);

  // afplay has no completion callback of its own; poll while something is
  // playing so the ♪ indicator disappears the moment the child process
  // exits on its own, not only on the user's next keypress.
  const isPlayingNow = player.isPlaying();
  const [, forceTick] = useState(0);
  useEffect(() => {
    if (!isPlayingNow) return;
    const id = setInterval(() => forceTick((t) => t + 1), 150);
    return () => clearInterval(id);
  }, [isPlayingNow]);

  const playingPath = player.current();
  const notice = playerError ?? status;

  // Placed after every hook above so this component always calls the same
  // hooks in the same order regardless of which view is showing (React's
  // rules-of-hooks) -- only the JSX actually returned differs.
  if (view === "hooks") {
    return (
      <HooksView
        catalog={catalog}
        player={player}
        playerError={playerError}
        onBack={() => setView("browser")}
      />
    );
  }

  return (
    <box flexDirection="column" flexGrow={1}>
      <box
        border
        borderColor={theme.border}
        title="Search"
        flexDirection="row"
        justifyContent="space-between"
        paddingX={1}
        flexShrink={0}
      >
        <text wrapMode="none">
          {"> "}
          {query}
          <span fg={theme.cursor}>{"█"}</span>
        </text>
        <text fg={theme.groupDim} wrapMode="none">{`${matchedCount}/${totalCount}`}</text>
      </box>
      {/* minHeight=0: without it, flexbox's default min-size-from-content
          refuses to shrink ~70 rows of content, squeezing the bars above/below. */}
      <scrollbox ref={scrollRef} flexGrow={1} minHeight={0} focused={false}>
        {rows.length === 0 ? (
          <box padding={1}>
            <text fg={theme.groupDim}>no matches</text>
          </box>
        ) : (
          rows.map((row, i) => renderRow(row, i, i === selectedIndex, playingPath))
        )}
      </scrollbox>
      <box flexDirection="column" paddingX={1} flexShrink={0}>
        <text fg={theme.help} wrapMode="none">
          {HELP_TEXT}
        </text>
        {notice !== null && (
          <text fg={theme.error} wrapMode="none">
            {notice}
          </text>
        )}
      </box>
    </box>
  );
}
