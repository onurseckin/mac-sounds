#!/usr/bin/env bun

import { createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";
import { createElement } from "react";
import { parseArgs } from "./cli/parse.ts";
import { App } from "./ui/app.tsx";

function describeError(error: unknown): string {
  return error instanceof Error ? (error.stack ?? error.message) : String(error);
}

async function main(): Promise<void> {
  // Every non-empty argv resolves to a command that exits the process on its
  // own (a printed result, a help screen, an error, or -- for `play` -- once
  // playback finishes). Reaching the code below means argv was empty: launch
  // the TUI.
  await parseArgs(process.argv.slice(2));

  if (!process.stdout.isTTY) {
    process.stderr.write(
      "mac-sounds: refusing to start the TUI because stdout is not a terminal.\n" +
        "Use 'mac-sounds list' to print the sound catalog instead, e.g.: mac-sounds list | less\n",
    );
    process.exit(1);
  }

  const renderer = await createCliRenderer({ exitOnCtrlC: true });
  const root = createRoot(renderer);

  // Idempotent on purpose: SIGINT/SIGTERM, an uncaught error, and a normal
  // quit from inside the app can all race to call this, and unmount/destroy
  // must run exactly once no matter which path gets there first.
  let didShutdown = false;
  function shutdown(exitCode: number, error?: unknown): void {
    if (didShutdown) return;
    didShutdown = true;
    // Restore the terminal (unmount, then destroy) before anything else, so
    // an error message below lands in a normal shell instead of a half-drawn
    // alternate screen.
    root.unmount();
    renderer.destroy();
    if (error !== undefined) {
      console.error(describeError(error));
    }
    process.exit(exitCode);
  }

  // exitOnCtrlC only covers Ctrl+C; every other exit path is ours to wire up.
  process.on("SIGINT", () => shutdown(0));
  process.on("SIGTERM", () => shutdown(0));
  process.on("uncaughtException", (error) => shutdown(1, error));
  process.on("unhandledRejection", (reason) => shutdown(1, reason));

  root.render(createElement(App, { onQuit: () => shutdown(0) }));
}

// Covers failures before shutdown() exists (e.g. createCliRenderer itself
// rejecting) -- createCliRenderer already restores the terminal on its own
// setup failures, so there is nothing left to clean up here but report and exit.
main().catch((error: unknown) => {
  console.error(describeError(error));
  process.exit(1);
});
