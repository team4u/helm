/**
 * plugin id → disk directory name (across platform consistent mapping).
 *
 * background: plugin id allows `:`(`/^[A-Za-z0-9:_-]+$/`), while Windows filename forbidden `:`- -
 * this kind of name will by explain into NTFS hand over replace data stream (`mkdir builtin:profile` must report ENOENT),
 * plugin register in first carries smoke number plugin where i.e. crash. reason id in `:` one rule escaping is `%3A`,
 * the rest character original keep (excludes `:`  id disk layout and old behavior fully consistent).
 *
 * unique right threat point: all `<dataDir>/plugins/<...>` compute and external plugin directory discover all away this in,
 * never in other where each write a escaping rule.
 */
const COLON = /:/g

/** plugin id for should data directory name (`<dataDir>/plugins/<this name>`). */
export function pluginDataDirName(pluginId: string): string {
  return pluginId.replace(COLON, '%3A');
}

/** directory name is otherwise is built-in plugin pure data directory (`builtin:` prefix directly or escaping form). */
export function isBuiltinPluginDataDirName(dirName: string): boolean {
  return dirName.startsWith('builtin:') || dirName.startsWith('builtin%3A');
}
