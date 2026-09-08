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

To get a `mac-sounds` command on your `PATH` from any directory:

```sh
bun run sync
mac-sounds
```

Run `bun run unsync` to remove it again.

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
| `Ctrl+K` | switch to the hooks view (see [Hooks](#hooks)) |
| `Escape` | clear the query, or quit when it is already empty |
| `Ctrl+C` | quit |

Note: `Space` plays the selected sound, it does not type a space into the search query. If your search seems stuck, that's why.

## Commands

```
mac-sounds                      launch the TUI (default)
mac-sounds list [options]       print sounds, one per line
mac-sounds play <query>         play the best fuzzy match, then exit
mac-sounds groups               list the sound groups and their directories
mac-sounds hooks [subcommand]   manage lifecycle-hook sound bindings, see below
mac-sounds help [command]       print help for a command
```

Global flags: `-h, --help` and `-V, --version`. Every command and subcommand also accepts `-h` / `--help` on its own.

`list` options: `--group <id>` (only that group), `--names` (print names instead of paths). The old `--list` / `-l` flags still work as aliases for `mac-sounds list`.

```sh
mac-sounds play glass
mac-sounds list --group modern
```

## Hooks

mac-sounds can play a sound when your agent finishes, for three host apps: Claude Code, Codex CLI, and Antigravity CLI.

### Quick start

```sh
mac-sounds hooks install claude   # wire it in, seeded with defaults
mac-sounds hooks                  # see what is bound where
```

That is enough to get sound: Claude Code now plays `Pop.aiff` when it finishes and `Submarine.aiff` when a turn fails.

Audition a sound before committing to it, then assign it:

```sh
mac-sounds play tink
mac-sounds hooks set claude stop tink
```

Silence one event without unwiring anything, and bring it back:

```sh
mac-sounds hooks disable claude subagent-stop
mac-sounds hooks enable claude subagent-stop
```

Undo everything for a host:

```sh
mac-sounds hooks uninstall claude
```

### When changes take effect

Hosts read their hook config when a session starts, so `hooks install` and `hooks uninstall` apply to that host's **next** session. Everything else — `set`, `enable`, `disable`, and edits made in the TUI — takes effect **immediately**, including for sessions already running.

That difference is the whole point of the design. A host's config never contains a sound name; `hooks install` writes it one stable dispatch line pointing at `~/.config/mac-sounds/hook.sh`, and that shim looks up which sound to play, at fire time, from mac-sounds' own state file at `~/.config/mac-sounds/hooks.json`. Changing a sound or flipping one off only ever touches that state file.

### Checking it works

You can fire a hook by hand rather than waiting for an agent turn — this runs exactly what the host runs:

```sh
~/.config/mac-sounds/hook.sh claude stop
```

For Antigravity the outcome comes from the payload on stdin, so you can test both branches:

```sh
echo '{"terminationReason":"model_stop"}' | ~/.config/mac-sounds/hook.sh antigravity stop
echo '{"terminationReason":"error"}'      | ~/.config/mac-sounds/hook.sh antigravity stop
```

`mac-sounds hooks` shows the current state of every host at a glance.

### Commands

```
mac-sounds hooks                            show hosts, events, sounds, on/off
mac-sounds hooks install <host> [--force]   wire mac-sounds into that host's global config
mac-sounds hooks uninstall <host>           remove it and restore anything displaced
mac-sounds hooks set <host> <event> <sound> assign a sound (fuzzy name or absolute path)
mac-sounds hooks enable <host> [event]      turn an event on, or every bound event on that host
mac-sounds hooks disable <host> [event]     turn an event off, or every bound event on that host
```

Disabling an event with no sound assigned is a no-op that exits 0 ("nothing to disable"); enabling one exits 1 and tells you to `hooks set` first. There is nothing wrong with something already off, but nothing to turn on either — the asymmetry is deliberate.

`hooks install` seeds defaults the first time it wires up a host with no bindings of its own: completion-style events get `Pop.aiff`, failure-style events get `Submarine.aiff`. Events with no natural default, like `session-start`, are left unbound and silent until you assign one.

### Hosts and events

`<host>` is one of `claude`, `codex`, `antigravity`. Events differ per host:

| Host | Events |
|---|---|
| `claude` | `stop`, `stop-failure`, `subagent-stop`, `session-start`, `notification` |
| `antigravity` | `stop`, `stop-failure` |
| `codex` | `turn-complete` |

Antigravity CLI itself has only one `Stop` hook, and mac-sounds writes a single entry into `~/.gemini/config/hooks.json` for it. The split happens at fire time: mac-sounds reads the `Stop` payload from stdin and treats a `terminationReason` of `error` or `max_steps_exceeded`, or any non-empty `error` string, as failure; everything else — including a payload that fails to parse — counts as success, deliberately, so a payload schema change can never turn every normal completion into an alarm.

Codex exposes only `turn-complete`, with no separate success/failure signal — that is a limit of Codex's legacy `notify` mechanism, not of mac-sounds, so do not file it as a bug. (Codex's newer `[hooks]` table hashes every entry and treats a config-written hook as untrusted until a human approves it in the TUI, which makes it unusable for this; `notify` has no such gate.)

### Hooks view (TUI)

`Ctrl+K` from the sound browser opens the hooks view; `Ctrl+K` again returns to the browser.

| Key | Action |
|---|---|
| `Up` / `Down` | move selection |
| `Space` | toggle the selected event on/off |
| `Enter` | play the event's bound sound |
| `a` | assign mode: type to fuzzy-search, `Enter` picks |
| `Escape` | assign mode: cancel it; otherwise: back to the sound browser |
| `Ctrl+C` | quit |

The TUI never writes a host's config — it only changes sounds and on/off state. Wiring a host in or out is done with `hooks install` / `hooks uninstall`, where conflicts can be reported properly.

### Safety

- `hooks install` refuses if the host already has a sound hook mac-sounds did not write, listing exactly what it found. `--force` overrides it and stashes the displaced entry so `hooks uninstall` restores it. Codex commonly hits this: its single `notify` slot is often already taken, for instance by Codex Computer Use.
- `hooks uninstall` keeps your sound choices in mac-sounds' state, so a later `hooks install` on the same host picks them back up.
- Existing config is preserved byte-for-byte, written atomically, and a `.mac-sounds.bak` backup is written next to it the first time mac-sounds modifies it.
- A hook never blocks your agent: it plays detached, never kills audio started by anything else, and emits only the stdout its host expects.

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

Rendering is done with OpenTUI (`@opentui/react`). Filtering uses an in-memory fuzzy matcher rather than shelling out to `ripgrep`: the full catalog is around 66 sounds, so a subprocess per keystroke would be slower than matching in process. Playback goes through `afplay`. In the TUI and `play`, only one sound is alive at a time — starting a new one stops the previous. Hook playback is deliberately different: it spawns detached and never kills another `afplay`, so a hook firing cannot cut off audio started by you or by another tool.

## License

MIT, see [LICENSE](./LICENSE).
