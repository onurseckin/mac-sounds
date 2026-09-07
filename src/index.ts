#!/usr/bin/env bun

import { readFileSync } from "node:fs";
import { createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";
import { createElement } from "react";
import { loadCatalog } from "./sounds/catalog.ts";
import { App } from "./ui/app.tsx";

const SCANNED_DIRECTORIES = [
  "/System/Library/Sounds",
  "/Library/Sounds",
  "~/Library/Sounds",
  "/System/Library/PrivateFrameworks/ToneLibrary.framework/Versions/A/Resources/AlertTones/Classic",
  "/System/Library/PrivateFrameworks/ToneLibrary.framework/Versions/A/Resources/AlertTones/Modern",
  "/System/Library/PrivateFrameworks/ToneLibrary.framework/Versions/A/Resources/AlertTones/EncoreInfinitum",
];

// Copied verbatim from the project's fixed keymap contract: the UI and README
// implement/document exactly this table, so it lives here as a literal, not
// something reformatted or regenerated from the key-handling code.
const KEYMAP = `  type            filter sounds
  Backspace       delete a character      Ctrl+U   clear the query
  Up/Down         move selection          Ctrl+P/N same
  PageUp/PageDown move by 10              Home/End first / last
  Enter or Space  play sound / toggle group
  Right / Left    expand / collapse group
  Tab             toggle the current group
  Ctrl+S          stop playback
  Ctrl+Y          copy the selected path to the clipboard
  Escape          clear query, or quit when empty
  Ctrl+C          quit`;

function printHelp(): void {
  console.log(`Usage: mac-sounds [options]

A terminal UI for browsing and playing macOS system sounds.

Options:
  -h, --help     show this help and exit
  -V, --version  print the version and exit
  -l, --list     print every sound path, one per line, and exit

Keys:
${KEYMAP}

Directories scanned:
${SCANNED_DIRECTORIES.map((dir) => `  ${dir}`).join("\n")}`);
}

interface PackageManifest {
  version: string;
}

// package.json is an untyped boundary (JSON.parse returns `unknown` here, not
// `any`, because the variable it's assigned to is annotated `unknown`) --
// this guard is what turns that into a typed, verified `PackageManifest`.
function isPackageManifest(value: unknown): value is PackageManifest {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { version?: unknown }).version === "string"
  );
}

function readVersion(): string {
  const packageUrl = new URL("../package.json", import.meta.url);
  const raw: unknown = JSON.parse(readFileSync(packageUrl, "utf8"));
  if (!isPackageManifest(raw)) {
    throw new Error(`${packageUrl.pathname} is missing a string "version" field`);
  }
  return raw.version;
}

function printList(): void {
  for (const group of loadCatalog()) {
    for (const sound of group.sounds) {
      console.log(sound.path);
    }
  }
}

// Flags are handled before the TTY check below: --list is explicitly meant to
// work when stdout is redirected, and --help/--version have no reason to care
// either. Any leftover argv entry that isn't a recognized flag is treated as
// unknown -- this CLI has no positional arguments or subcommands.
function parseArgs(argv: readonly string[]): void {
  if (argv.includes("--help") || argv.includes("-h")) {
    printHelp();
    process.exit(0);
  }
  if (argv.includes("--version") || argv.includes("-V")) {
    console.log(readVersion());
    process.exit(0);
  }
  if (argv.includes("--list") || argv.includes("-l")) {
    printList();
    process.exit(0);
  }
  const unknown = argv[0];
  if (unknown !== undefined) {
    process.stderr.write(`mac-sounds: unknown option '${unknown}'\n`);
    process.stderr.write("Try 'mac-sounds --help' for usage.\n");
    process.exit(1);
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? (error.stack ?? error.message) : String(error);
}

async function main(): Promise<void> {
  parseArgs(process.argv.slice(2));

  if (!process.stdout.isTTY) {
    process.stderr.write(
      "mac-sounds: refusing to start the TUI because stdout is not a terminal.\n" +
        "Use --list to print the sound catalog instead, e.g.: mac-sounds --list | less\n",
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
