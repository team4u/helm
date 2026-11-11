/**
 * 插件 id → 磁盘目录名（跨平台一致映射）。
 *
 * 背景：插件 id 允许 `:`（`/^[A-Za-z0-9:_-]+$/`），而 Windows 文件名禁止 `:`——
 * 这类名字会被解释成 NTFS 交替数据流（`mkdir builtin:profile` 必报 ENOENT），
 * 插件注册在首个带冒号的插件处即崩。故把 id 中的 `:` 一律转义为 `%3A`，
 * 其余字符原样保留（不含 `:` 的 id 磁盘布局与旧行为完全一致）。
 *
 * 唯一权威点：所有 `<dataDir>/plugins/<...>` 计算与外部插件目录发现都走这里，
 * 绝不在别处各写一份转义规则。
 */
const COLON = /:/g

/** 插件 id 对应的数据目录名（`<dataDir>/plugins/<此名>`）。 */
export function pluginDataDirName(pluginId: string): string {
  return pluginId.replace(COLON, '%3A');
}

/** 目录名是否为内置插件的纯数据目录（`builtin:` 前缀的直接或转义形态）。 */
export function isBuiltinPluginDataDirName(dirName: string): boolean {
  return dirName.startsWith('builtin:') || dirName.startsWith('builtin%3A');
}
