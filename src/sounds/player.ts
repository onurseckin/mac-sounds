export interface PlayerOptions {
  /** Binary to spawn; defaults to "afplay". Override to point at a stub for local testing. */
  bin?: string;
  /** Reports playback failures (missing binary, non-zero exit). Never throw here into the render loop. */
  onError?: (message: string) => void;
}

export interface Player {
  /** Stop whatever is playing, then start this file. */
  play(path: string): void;
  /** Stop playback; safe to call when nothing is playing. */
  stop(): void;
  isPlaying(): boolean;
  /** Absolute path of the currently playing file, or null. */
  current(): string | null;
  /** Called on app exit: kill any child process so no sound outlives the TUI. */
  dispose(): void;
}

// Spawn through a helper (rather than typing the field as `ReturnType<typeof Bun.spawn>` directly)
// so the process type is inferred from this exact overload of the overloaded `Bun.spawn` signature,
// instead of TS's default of picking the last declared overload.
function spawnAfplay(bin: string, path: string) {
  return Bun.spawn([bin, path], {
    // The child inherits our tty by default; forwarding stdin would let it steal keystrokes from
    // the TUI's raw-mode input loop, and un-ignored stdout/stderr would write straight into the
    // terminal and corrupt the screen buffer the TUI is drawing into.
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });
}

type Proc = ReturnType<typeof spawnAfplay>;

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function createPlayer(options: PlayerOptions = {}): Player {
  const bin = options.bin ?? "afplay";
  const onError = options.onError;

  let proc: Proc | null = null;
  let currentPath: string | null = null;

  function killCurrent(): void {
    if (!proc) return;
    try {
      proc.kill();
    } catch {
      // Already reaped/gone between our check and the kill call; nothing left to clean up.
    }
    proc = null;
    currentPath = null;
  }

  function play(path: string): void {
    // Kill first so overlapping Enter presses never leave two afplay children racing.
    killCurrent();

    let child: Proc;
    try {
      child = spawnAfplay(bin, path);
    } catch (err) {
      // Bun.spawn throws synchronously when the binary can't be resolved (e.g. missing afplay).
      onError?.(`failed to start ${bin}: ${describeError(err)}`);
      return;
    }

    proc = child;
    currentPath = path;

    // exited resolves whenever this child ends, including ones we killed ourselves above/later.
    // Compare against `child` (not just "is anything playing") so a late resolution from an old
    // process can never clear state that already belongs to a newer play() call.
    void child.exited.then((code) => {
      if (proc !== child) return;
      proc = null;
      currentPath = null;
      if (code !== 0) {
        onError?.(`${bin} exited with code ${code}`);
      }
    });
  }

  function stop(): void {
    killCurrent();
  }

  function isPlaying(): boolean {
    return proc !== null;
  }

  function current(): string | null {
    return currentPath;
  }

  function dispose(): void {
    killCurrent();
  }

  return { play, stop, isPlaying, current, dispose };
}
