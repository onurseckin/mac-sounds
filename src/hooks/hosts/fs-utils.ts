// Small, host-agnostic filesystem helpers shared by every adapter in this
// folder. Nothing host-specific (event names, config shapes) lives here --
// just the atomic-write / backup / safe-parse primitives every adapter needs
// so this logic isn't triplicated across claude.ts, antigravity.ts and
// codex.ts.
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export function readTextFileIfExists(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

/**
 * Write `content` to `path` atomically: write to a temp file in the same
 * directory (same filesystem, so the rename is atomic under POSIX
 * semantics), then rename it over the target. A host reading its own config
 * file at an arbitrary moment -- which is exactly what happens the instant
 * a lifecycle hook fires -- only ever sees the fully-old or fully-new
 * content, never a half-written file.
 */
export function writeFileAtomic(path: string, content: string): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  const tmpPath = join(dir, `.mac-sounds.${process.pid}.${Date.now()}.tmp`);
  writeFileSync(tmpPath, content, "utf8");
  renameSync(tmpPath, path);
}

/**
 * Copy `path` to `<path>.mac-sounds.bak` the first time mac-sounds is about
 * to modify it. Deliberately never overwrites an existing backup: its whole
 * purpose is to hold the true pre-mac-sounds original, so a *second*
 * install()/uninstall() call must not let an already-mac-sounds-touched copy
 * become the new "original" a worried user restores to.
 */
export function backupOnce(path: string): void {
  if (!existsSync(path)) return;
  const bakPath = `${path}.mac-sounds.bak`;
  if (existsSync(bakPath)) return;
  copyFileSync(path, bakPath);
}

/** Best-effort "does this directory exist" check that never throws. */
export function directoryExists(path: string): boolean {
  try {
    return existsSync(path);
  } catch {
    return false;
  }
}

/**
 * Best-effort "is this host present on this machine" signal: does its
 * config *directory* exist under the real home directory. Deliberately not
 * a PATH lookup for the host's own binary -- the verified brief shows PATH
 * is inconsistent across how each of these tools gets launched (Terminal vs
 * GUI vs background daemon), so a directory only the host itself would have
 * created is the more reliable signal. Always checks the *real* home
 * directory, independent of any MAC_SOUNDS_*_CONFIG test override, because
 * "is the host present on this machine" is a real-machine question even
 * when a test is pointing configPath() at a scratch file.
 */
export function hostRootExists(dirName: string): boolean {
  return directoryExists(join(homedir(), dirName));
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Delete a file if present; a no-op (not an error) if it's already gone. */
export function removeFileIfExists(path: string): void {
  try {
    rmSync(path);
  } catch {
    // Already gone, or never existed -- either way there's nothing to do.
  }
}

/**
 * Read a small JSON "sidecar" file (used to stash foreign hook entries a
 * force-install displaces, so uninstall can restore them later). Returns
 * undefined for a missing or unparseable file -- callers fall back to an
 * empty store, exactly like a fresh install.
 */
export function readJsonSidecar(path: string): unknown {
  const raw = readTextFileIfExists(path);
  if (raw === undefined) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

/** Write the sidecar, or delete it once it holds nothing worth keeping. */
export function writeJsonSidecar(path: string, data: Record<string, unknown>): void {
  if (Object.keys(data).length === 0) {
    removeFileIfExists(path);
    return;
  }
  writeFileAtomic(path, `${stringifyJsonAscii(data, 2)}\n`);
}

// Anything outside printable ASCII (0x20-0x7e). DEL (0x7f) is included too
// since it's non-printable, matching the ensure-ascii-style escaping already
// used in the real settings.json this was verified against.
const NON_ASCII = /[\u007f-\uffff]/g;

/**
 * JSON.stringify, then ASCII-escape any literal non-ASCII character it left
 * in the output. Confirmed against this machine's real
 * ~/.claude/settings.json: free-text values in it store em dashes and
 * multiplication signs as literal `\u2014`/`\u00d7` escapes, not raw UTF-8
 * bytes. A plain JSON.stringify round-trip on an *untouched* string
 * containing one of those would silently re-encode it as a raw UTF-8
 * character -- same value, different bytes -- which breaks the
 * byte-for-byte round trip this tool promises for every key it isn't
 * touching. Escaping here matches that file's existing convention; the only
 * cost is that any *new* non-ASCII text this tool itself ever writes would
 * also come out ascii-escaped, which is harmless (still valid, semantically
 * identical JSON) and moot in practice since we only ever write absolute
 * filesystem paths and fixed host/event ids, all plain ASCII.
 */
export function stringifyJsonAscii(value: unknown, indent: number): string {
  const json = JSON.stringify(value, null, indent);
  return json.replace(
    NON_ASCII,
    (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}
