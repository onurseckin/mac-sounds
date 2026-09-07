import { readdirSync, statSync } from "node:fs";
import type { Dirent } from "node:fs";
import { homedir } from "node:os";
import { basename, extname, join } from "node:path";
import type { Catalog, SoundFile, SoundGroup } from "../types.ts";

const ALLOWED_EXTS = new Set(["aiff", "m4r", "caf", "wav"]);

const TONES_DIR =
  "/System/Library/PrivateFrameworks/ToneLibrary.framework/Versions/A/Resources/AlertTones";

interface GroupSpec {
  id: string;
  label: string;
  dir: string;
}

// $HOME must be resolved at call time via os.homedir(), never hardcoded,
// so build the spec list inside loadCatalog rather than as a module const.
function buildGroupSpecs(): GroupSpec[] {
  return [
    { id: "system", label: "System Sounds", dir: "/System/Library/Sounds" },
    { id: "local", label: "Local Sounds", dir: "/Library/Sounds" },
    { id: "user", label: "User Sounds", dir: join(homedir(), "Library", "Sounds") },
    { id: "classic", label: "Alert Tones — Classic", dir: join(TONES_DIR, "Classic") },
    { id: "modern", label: "Alert Tones — Modern", dir: join(TONES_DIR, "Modern") },
    {
      id: "encore",
      label: "Alert Tones — Encore Infinitum",
      dir: join(TONES_DIR, "EncoreInfinitum"),
    },
  ];
}

// A symlink's Dirent reports isFile() === false regardless of what it points
// at, so a symlinked sound (e.g. a user's custom alias into another folder)
// needs an extra stat to resolve the target type. Broken links throw on stat
// and are treated as "not a file" rather than crashing the whole scan.
function isRegularFile(dirPath: string, entryName: string, isSymlink: boolean): boolean {
  if (!isSymlink) return true;
  try {
    return statSync(join(dirPath, entryName)).isFile();
  } catch {
    return false;
  }
}

function scanGroup(spec: GroupSpec): SoundGroup {
  const sounds: SoundFile[] = [];

  // readdirSync is a single syscall-backed in-process call; spawning `fd`,
  // `ls`, or `find` for each of these six fixed directories would cost a
  // process fork + exec per lookup for no benefit over the stdlib call.
  let entries: Dirent<string>[];
  try {
    entries = readdirSync(spec.dir, { withFileTypes: true, encoding: "utf8" });
  } catch {
    // Missing or unreadable directory: yield an empty group, never throw.
    return { id: spec.id, label: spec.label, dir: spec.dir, sounds };
  }

  for (const entry of entries) {
    if (!isRegularFile(spec.dir, entry.name, entry.isSymbolicLink())) continue;

    const rawExt = extname(entry.name); // preserves case, includes the dot
    if (!rawExt) continue;
    const ext = rawExt.slice(1).toLowerCase();
    if (!ALLOWED_EXTS.has(ext)) continue;

    sounds.push({
      path: join(spec.dir, entry.name),
      name: basename(entry.name, rawExt),
      ext,
      groupId: spec.id,
    });
  }

  sounds.sort((a, b) => a.name.localeCompare(b.name));

  return { id: spec.id, label: spec.label, dir: spec.dir, sounds };
}

export function loadCatalog(): Catalog {
  const groups = buildGroupSpecs().map(scanGroup);
  // Groups with zero sounds are omitted entirely, not returned empty.
  return groups.filter((group) => group.sounds.length > 0);
}
