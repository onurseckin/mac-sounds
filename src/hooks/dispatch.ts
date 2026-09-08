import { getBinding, loadConfig } from "./config.ts";
import { isRecord } from "./hosts/fs-utils.ts";
import { adapterFor } from "./hosts/registry.ts";
import type { HostId } from "./types.ts";

// afplay is spawned directly here instead of through sounds/player.ts's createPlayer():
// that abstraction's whole job is tracking "the one sound currently playing" so a later
// stop()/isPlaying() call from a long-lived TUI means something across many play() calls.
// dispatch() is the opposite lifecycle -- one play, no follow-up calls, and the process
// exits within milliseconds -- so there is no state for a Player to track and nothing to
// dispose(). Reusing it would mean importing a stateful wrapper only to discard it unused.
function playDetached(soundPath: string): void {
  try {
    const child = Bun.spawn(["afplay", soundPath], {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
      // `detached: true` calls setsid(), moving afplay into its own session and process
      // group -- it stops being a member of *this* process's group, so a signal aimed at
      // our group (a host killing its hook's whole process group on timeout, Ctrl+C
      // reaching a foreground group, etc.) does not also reach afplay.
      detached: true,
    });
    // Bun's own docs: "By default, Bun waits for all subprocesses to exit before shutting
    // down." Verified empirically: spawning a 2.16s sound without calling unref() made the
    // *parent* process itself block for the full 2.16s+ before it could exit, even though
    // the calling function had already returned -- exactly the per-turn stall Antigravity's
    // 30s synchronous hook timeout warns against. Calling unref() removes afplay from that
    // wait-list, so dispatch() (and the process hosting it) can exit the instant this
    // function returns; re-verified that the detached child keeps running and the sound
    // completes normally after the parent has already exited.
    child.unref();
  } catch {
    // Missing afplay, an unreadable soundPath, whatever the cause -- this runs inside the
    // user's agent loop, so a failed play must degrade to silence, never a crash or a
    // stderr line the host might surface.
  }
}

// Antigravity has exactly one Stop hook (see hosts/antigravity.ts) -- its payload arrives
// as JSON on stdin carrying `terminationReason` ("model_stop" | "max_steps_exceeded" |
// "error") and an `error` string populated only on failure. This mirrors the judgement
// already proven out in this machine's hand-written ~/.gemini/config/scripts/stop-sound.sh:
// only an explicit failure signal counts as failure, and anything that fails to parse -- a
// schema change, truncated input, a host bug -- is success on purpose. Getting this
// backwards would turn a payload format change into every normal completion playing the
// failure sound.
function isAntigravityFailurePayload(payload: string): boolean {
  if (payload === "") return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return false;
  }
  if (!isRecord(parsed)) return false;

  if (parsed.terminationReason === "error" || parsed.terminationReason === "max_steps_exceeded") {
    return true;
  }

  // Trimmed the same way the reference script's `err.strip() != ""` does -- a
  // whitespace-only error string isn't a real error message.
  const error = parsed.error;
  return typeof error === "string" && error.trim() !== "";
}

// A few hundred milliseconds at most. dispatch() runs synchronously inside the user's
// agent loop, and this exact path is also invoked by hand from a terminal (`mac-sounds
// hook antigravity stop`) where stdin is a TTY that will never send EOF on its own.
// Antigravity writes its whole payload and closes its end of the pipe immediately, so a
// real invocation resolves in low single-digit milliseconds -- only "nothing is coming"
// (no piped input at all) ever pays this cost, and it must stay short enough that a human
// running the command by hand never notices a pause, and short enough to fit comfortably
// inside the 5s timeout antigravity.ts's own hook entry pins.
const ANTIGRAVITY_STDIN_TIMEOUT_MS = 200;

// Reads stdin to completion, but never past `timeoutMs` and never at all when stdin is a
// TTY (a human terminal doesn't send EOF short of Ctrl-D, so waiting on it would just be a
// hang with extra steps). Never throws or rejects -- every stream outcome, including
// "error", funnels into the same `finish`, so a broken pipe degrades to "read nothing"
// rather than blowing up the caller.
function readStdinWithTimeout(timeoutMs: number): Promise<string> {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    if (stdin.isTTY) {
      resolve("");
      return;
    }

    let data = "";
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stdin.removeListener("data", onData);
      stdin.removeListener("end", onEnd);
      stdin.removeListener("close", onEnd);
      stdin.removeListener("error", onEnd);
      // Back to paused/inert now that we've stopped listening. dispatch()'s one caller
      // (runHookDispatch) force-exits right after this resolves either way, but releasing
      // the stream is free and shouldn't rely on that being the only thing that saves us.
      stdin.pause();
      resolve(data);
    };
    const onData = (chunk: Buffer): void => {
      data += chunk.toString("utf8");
    };
    const onEnd = (): void => finish();
    const timer = setTimeout(finish, timeoutMs);

    stdin.on("data", onData);
    stdin.once("end", onEnd);
    stdin.once("close", onEnd);
    stdin.once("error", onEnd);
    stdin.resume();
  });
}

// The one place that tells Antigravity's two outcomes apart: read the Stop payload
// (bounded, see readStdinWithTimeout) and resolve to whichever mac-sounds event id should
// actually play -- `eventId` ("stop") unless the payload says otherwise.
async function resolveAntigravityStopEventId(eventId: string): Promise<string> {
  const payload = await readStdinWithTimeout(ANTIGRAVITY_STDIN_TIMEOUT_MS);
  return isAntigravityFailurePayload(payload) ? "stop-failure" : eventId;
}

// Invoked by `mac-sounds hook <host> <event>`, itself invoked by the generated shim
// (see shim.ts) from inside Claude Code's, Codex's, or Antigravity CLI's own hook
// dispatch -- synchronously, on the hot path of the user's agent finishing a turn.
export async function dispatch(hostId: HostId, eventId: string): Promise<void> {
  // Every branch below must be inert on failure: dispatch() runs inside the user's agent
  // loop, so any exception, non-zero exit, or unexpected stderr line here surfaces as an
  // error *in their agent session*, not in mac-sounds. try/catch the whole body and always
  // fall through to a normal return -- never let anything escape past this function.
  try {
    const adapter = adapterFor(hostId);

    // adapter.stdoutFor(eventId) is the one place allowed to speak on stdout on this
    // process's behalf, and "" means "print nothing", not "print an empty line": Claude's
    // Stop/SubagentStop hooks treat *any* stdout as a live control decision (a leading "{"
    // can parse as {"decision":"block",...} and hang the agent instead of letting it finish
    // its turn), and Claude's SessionStart stdout is injected straight into the model's
    // context. Getting either wrong corrupts the user's session, so an empty stdoutFor()
    // must write literally zero bytes here -- not even a trailing newline. This is computed
    // and written BEFORE the Antigravity stdin read below, not after: Antigravity's "stop"
    // and "stop-failure" ids produce the identical stdout answer (see antigravity.ts), so
    // there is nothing outcome-dependent to wait for here, and emitting it up front means
    // the stdout contract is honoured even if the read below is slow to settle or times out.
    const stdout = adapter.stdoutFor(eventId);
    if (stdout !== "") {
      process.stdout.write(stdout);
    }

    // Antigravity has one Stop hook and no separate failure event -- unlike Claude's
    // already-distinct "stop"/"stop-failure" ids, so the split has to happen here, from the
    // payload, instead of arriving as a different eventId. Every other host/event
    // combination is already 1:1 with a binding, so eventId passes through unchanged.
    const resolvedEventId =
      hostId === "antigravity" && eventId === "stop"
        ? await resolveAntigravityStopEventId(eventId)
        : eventId;

    const config = loadConfig();
    const binding = getBinding(config, hostId, resolvedEventId);
    // No binding at all, or an explicit enabled:false -> play nothing. This lookup *is*
    // the entire toggle mechanism: disabling a binding never rewrites the host's own
    // config file (Claude's settings.json, Codex's config.toml, Antigravity's
    // hooks.json), it only flips this boolean, so disabling is instant and stays in
    // effect on every future turn without touching host-side wiring again. Resolving
    // per-outcome above (rather than always looking up the original eventId) is what
    // keeps this toggle working per-outcome for Antigravity too -- a user can have
    // "stop-failure" enabled and "stop" disabled (or vice versa) and get exactly that.
    if (binding === undefined || !binding.enabled) return;

    playDetached(binding.soundPath);
  } catch {
    // An adapter that doesn't recognize hostId/eventId, a config shape that slipped past
    // loadConfig()'s own guards, anything else unforeseen -- swallow it so the caller (the
    // `hook` CLI command) always exits 0.
  }
}
