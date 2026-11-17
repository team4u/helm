/**
 * Maps plugin IDs to cross-platform on-disk directory names.
 *
 * Background: plugin IDs allow `:` (`/^[A-Za-z0-9:_-]+$/`), whereas Windows filenames forbid `:`
 * (interpreted as an NTFS alternate data stream, causing `mkdir builtin:profile` to fail with ENOENT).
 * Escapes `:` to `%3A` while preserving all other characters so IDs without `:` keep identical layouts.
 *
 * Single source of truth for `<dataDir>/plugins/<...>` paths and external plugin directory discovery.
 */
const COLON = /:/g

/** Returns the on-disk directory name under `<dataDir>/plugins/` for `pluginId`. */
export function pluginDataDirName(pluginId: string): string {
  return pluginId.replace(COLON, '%3A');
}

/** Returns whether a directory name belongs to a built-in plugin data directory (`builtin:` or escaped form). */
export function isBuiltinPluginDataDirName(dirName: string): boolean {
  return dirName.startsWith('builtin:') || dirName.startsWith('builtin%3A');
}
