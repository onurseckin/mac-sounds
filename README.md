# mac-sounds

A terminal UI for browsing, searching, and auditioning every alert sound built into macOS.

macOS only (uses `afplay` for playback). Requires Bun >= 1.3.

## Install / run

```sh
git clone https://github.com/onurseckin/mac-sounds.git
cd mac-sounds
bun install
bun start
```

To get a `mac-sounds` command on your `PATH` instead:

```sh
bun link
mac-sounds
```

## Keys

| Key | Action |
|---|---|
| type any character | filter sounds |
| `Backspace` | delete a character |
| `Ctrl+U` | clear the query |
| `Up` / `Down` (or `Ctrl+P` / `Ctrl+N`) | move selection |
| `PageUp` / `PageDown` | move selection by 10 |
| `Home` / `End` | jump to first / last row |
| `Enter` or `Space` | play the selected sound; on a group row, expand/collapse it |
| `Right` | expand the selected group |
| `Left` | collapse the group; from a sound, jump to its group header |
| `Tab` | toggle the current group |
| `Ctrl+S` | stop playback |
| `Ctrl+Y` | copy the selected sound's path to the clipboard |
| `Escape` | clear the query, or quit when it is already empty |
| `Ctrl+C` | quit |

Note: `Space` plays the selected sound, it does not type a space into the search query. If your search seems stuck, that's why.

## CLI flags

| Flag | Effect |
|---|---|
| `--help` | print usage and exit |
| `--version` | print the installed version and exit |
| `--list` | print every sound path, one per line, and exit (useful for piping into other shell commands) |

## Why

The practical payoff is `Ctrl+Y`: copy a sound's path and paste it wherever you need it.

For example, wiring a sound into a Claude Code hook in `~/.claude/settings.json`:

```json
{
  "hooks": {
    "Stop": [
      { "hooks": [{ "type": "command", "command": "afplay /System/Library/Sounds/Glass.aiff" }] }
    ]
  }
}
```

Or straight in a shell script:

```sh
afplay <path>
```

## Development

```sh
bun run check    # typecheck + lint + format check
bun run lint
bun run format
```

There are no tests in this project, deliberately.

## How it works

Rendering is done with OpenTUI (`@opentui/react`). Filtering uses an in-memory fuzzy matcher rather than shelling out to `ripgrep`: the full catalog is around 66 sounds, so a subprocess per keystroke would be slower than matching in process. Playback goes through `afplay`, with only one sound alive at a time — starting a new one stops whatever was already playing.

## License

MIT, see [LICENSE](./LICENSE).
