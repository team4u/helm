/** Error to readable text (shared by notices / inline errors / connection-failure hints).
 * 独立于 format.ts 的 SDK 重导出桶：核心 store 图（helm-store 及其 lib 依赖）不得
 * 仅因错误文案传递加载整个 @helm/plugin-client（Radix 依赖图）。 */
export function errorText(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}
