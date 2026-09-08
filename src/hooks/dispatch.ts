import { getBinding, loadConfig } from "./config.ts";
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

// Invoked by `mac-sounds hook <host> <event>`, itself invoked by the generated shim
// (see shim.ts) from inside Claude Code's, Codex's, or Antigravity CLI's own hook
// dispatch -- synchronously, on the hot path of the user's agent finishing a turn.
export async function dispatch(hostId: HostId, eventId: string): Promise<void> {
  // Every branch below must be inert on failure: dispatch() runs inside the user's agent
  // loop, so any exception, non-zero exit, or unexpected stderr line here surfaces as an
  // error *in their agent session*, not in mac-sounds. try/catch the whole body and always
  // fall through to a normal return -- never let anything escape past this function.
  try {
    // adapterFor(hostId).stdoutFor(eventId) is the one place allowed to speak on stdout on
    // this process's behalf, and "" means "print nothing", not "print an empty line":
    // Claude's Stop/SubagentStop hooks treat *any* stdout as a live control decision (a
    // leading "{" can parse as {"decision":"block",...} and hang the agent instead of
    // letting it finish its turn), and Claude's SessionStart stdout is injected straight
    // into the model's context. Getting either wrong corrupts the user's session, so an
    // empty stdoutFor() must write literally zero bytes here -- not even a trailing
    // newline.
    const stdout = adapterFor(hostId).stdoutFor(eventId);
    if (stdout !== "") {
      process.stdout.write(stdout);
    }

    const config = loadConfig();
    const binding = getBinding(config, hostId, eventId);
    // No binding at all, or an explicit enabled:false -> play nothing. This lookup *is*
    // the entire toggle mechanism: disabling a binding never rewrites the host's own
    // config file (Claude's settings.json, Codex's config.toml, Antigravity's
    // hooks.json), it only flips this boolean, so disabling is instant and stays in
    // effect on every future turn without touching host-side wiring again.
    if (binding === undefined || !binding.enabled) return;

    playDetached(binding.soundPath);
  } catch {
    // An adapter that doesn't recognize hostId/eventId, a config shape that slipped past
    // loadConfig()'s own guards, anything else unforeseen -- swallow it so the caller (the
    // `hook` CLI command) always exits 0.
  }
}
