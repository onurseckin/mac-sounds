export interface SoundFile {
  /** Absolute path, e.g. /System/Library/Sounds/Glass.aiff */
  path: string;
  /** Basename without extension, e.g. "Glass" */
  name: string;
  /** Lowercase extension without the dot: aiff | m4r | caf | wav */
  ext: string;
  /** id of the owning group */
  groupId: string;
}

export interface SoundGroup {
  /** Stable id: system | local | user | classic | modern | encore */
  id: string;
  /** Display label shown in the tree, e.g. "System Sounds" */
  label: string;
  /** Absolute directory path */
  dir: string;
  sounds: SoundFile[];
}

export type Catalog = SoundGroup[];
