import { closeSync, openSync, readSync } from "node:fs";
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

// Antigravity's NewStopHook strips the "EXECUTOR_TERMINATION_REASON_" enum prefix and emits
// uppercase reason names ("NO_TOOL_CALL", "ERROR", "MAX_INVOCATIONS",
// "MAX_FORCED_INVOCATIONS", "MAX_TOKEN_BUDGET_EXCEEDED", "HALTED_STEP"), alongside older
// lowercase variants ("model_stop", "max_steps_exceeded", "error"). Comparing lowercased
// covers both conventions while treating any unrecognised or missing reason as non-failure.
const ANTIGRAVITY_FAILURE_REASONS: ReadonlySet<string> = new Set([
  "error",
  "max_steps_exceeded",
  "max_invocations",
  "max_forced_invocations",
  "max_token_budget_exceeded",
  "halted_step",
]);

function isAntigravityFailureRecord(parsed: Record<string, unknown>): boolean {
  const reason = parsed.terminationReason;
  if (typeof reason === "string" && ANTIGRAVITY_FAILURE_REASONS.has(reason.trim().toLowerCase())) {
    return true;
  }

  // Trimmed the same way the reference script's `err.strip() != ""` does -- a
  // whitespace-only error string isn't a real error message.
  const error = parsed.error;
  return typeof error === "string" && error.trim() !== "";
}

// Antigravity scrubs internal protobuf fields (parentConversationId, rootConversationId,
// agentName) from external Stop payloads when useFullHookInterface is false, but always
// includes public fields `transcriptPath` and `workspacePaths`. In Antigravity's JSONL
// transcript format, main user conversations always start at step_index 0 with
// `{"source":"USER_EXPLICIT","type":"USER_INPUT"}`, whereas invoked subagents start at
// step_index 0 with `{"source":"SYSTEM","type":"SYSTEM_MESSAGE"}` carrying the parent's
// delegation prompt. Reading only the first 4 KB keeps this check sub-millisecond.
function isTranscriptFromSubagent(transcriptPath: string): boolean {
  let fd: number | undefined;
  try {
    fd = openSync(transcriptPath, "r");
    const buf = Buffer.alloc(4096);
    const bytesRead = readSync(fd, buf, 0, buf.length, 0);
    if (bytesRead <= 0) return false;
    const chunk = buf.toString("utf8", 0, bytesRead);
    const newlineIdx = chunk.indexOf("\n");
    const firstLine = (newlineIdx === -1 ? chunk : chunk.slice(0, newlineIdx)).trim();
    if (firstLine === "") return false;
    const firstStep: unknown = JSON.parse(firstLine);
    if (!isRecord(firstStep)) return false;
    return firstStep.source === "SYSTEM" || firstStep.type === "SYSTEM_MESSAGE";
  } catch {
    return false;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // Ignore close errors.
      }
    }
  }
}

function isAntigravitySubagentRecord(parsed: Record<string, unknown>): boolean {
  if (
    typeof parsed.parentConversationId === "string" &&
    parsed.parentConversationId.trim() !== ""
  ) {
    return true;
  }
  if (
    typeof parsed.rootConversationId === "string" &&
    parsed.rootConversationId.trim() !== "" &&
    parsed.rootConversationId !== parsed.conversationId
  ) {
    return true;
  }
  if (typeof parsed.agentName === "string" && parsed.agentName.trim() !== "") {
    return true;
  }
  if (
    Array.isArray(parsed.workspacePaths) &&
    parsed.workspacePaths.some(
      (entry) =>
        typeof entry === "string" &&
        (entry.includes("/subagent-") || entry.includes("\\subagent-")),
    )
  ) {
    return true;
  }
  if (typeof parsed.transcriptPath === "string" && parsed.transcriptPath.trim() !== "") {
    return isTranscriptFromSubagent(parsed.transcriptPath);
  }
  return false;
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

// The one place that tells Antigravity's Stop outcomes apart: read the Stop payload
// (bounded, see readStdinWithTimeout) and resolve to whichever mac-sounds event id should
// actually play -- "stop-failure" on error/limit termination, "subagent-stop" when the
// completed turn belongs to a subagent, or `eventId` ("stop") otherwise.
async function resolveAntigravityStopEventId(eventId: string): Promise<string> {
  const payload = await readStdinWithTimeout(ANTIGRAVITY_STDIN_TIMEOUT_MS);
  if (payload === "") return eventId;
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return eventId;
  }
  if (!isRecord(parsed)) return eventId;

  if (isAntigravityFailureRecord(parsed)) return "stop-failure";
  if (isAntigravitySubagentRecord(parsed)) return "subagent-stop";
  return eventId;
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

    // Antigravity has one Stop hook and no separate failure or subagent wire event --
    // unlike Claude's already-distinct "stop"/"stop-failure"/"subagent-stop" ids, so the
    // split has to happen here, from the payload, instead of arriving as a different
    // eventId. Every other host/event combination is already 1:1 with a binding, so
    // eventId passes through unchanged.
    const resolvedEventId =
      hostId === "antigravity" && eventId === "stop"
        ? await resolveAntigravityStopEventId(eventId)
        : eventId;

    const config = loadConfig();
    const binding =
      getBinding(config, hostId, resolvedEventId) ??
      (hostId === "antigravity" && resolvedEventId === "subagent-stop"
        ? getBinding(config, hostId, "stop")
        : undefined);
    // No binding at all, or an explicit enabled:false -> play nothing. This lookup *is*
    // the entire toggle mechanism: disabling a binding never rewrites the host's own
    // config file (Claude's settings.json, Codex's config.toml, Antigravity's
    // hooks.json), it only flips this boolean, so disabling is instant and stays in
    // effect on every future turn without touching host-side wiring again. Resolving
    // per-outcome above (rather than always looking up the original eventId) is what
    // keeps this toggle working per-outcome for Antigravity too -- a user can have
    // "stop-failure" and "subagent-stop" enabled and "stop" disabled (or vice versa)
    // and get exactly that.
    if (binding === undefined || !binding.enabled) return;

    playDetached(binding.soundPath);
  } catch {
    // An adapter that doesn't recognize hostId/eventId, a config shape that slipped past
    // loadConfig()'s own guards, anything else unforeseen -- swallow it so the caller (the
    // `hook` CLI command) always exits 0.
  }
}
