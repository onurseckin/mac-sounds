import { dispatch } from "../../hooks/dispatch.ts";
import { isHostId } from "../../hooks/types.ts";

// Called by the shim mac-sounds installs into each host's config, on every
// lifecycle event -- this is the hot path inside the user's agent loop, so
// it must NEVER write to stderr or exit non-zero, no matter what it's
// called with (missing args, an unrecognised host, an unrecognised event).
// A non-zero exit or unexpected stderr here surfaces as an error in the
// user's own agent session, and for Claude's Stop/SubagentStop an exit
// code is itself a live control signal that can stop the agent from
// stopping -- there is no such thing as a "safe to fail loudly" input here.
//
// dispatch() already guarantees this for any *valid* host: it swallows
// every internal failure and still emits that host's correct "let the
// agent stop" stdout even for an event id it doesn't recognise (every
// adapter's stdoutFor() ignores its eventId argument and returns a fixed
// string). The one thing dispatch() can't do anything useful with is a
// host string that isn't in the registry at all -- adapterFor() has
// nothing to look up, so the right answer there is to print nothing and
// still exit 0, which is what skipping dispatch() entirely below achieves.
export async function runHookDispatch(args: readonly string[]): Promise<void> {
  const [hostArg, eventArg] = args;
  if (hostArg !== undefined && isHostId(hostArg)) {
    await dispatch(hostArg, eventArg ?? "");
  }
  process.exit(0);
}
