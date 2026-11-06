/**
 * 工具层共享依赖（避免 tools.ts 与 runtime.ts 循环引用）。
 */

export interface HelmToolDeps {
  dataDir: string
  defaultCwd: string
  /** 按 HELM_PORT 生成的 hub URL（如 http://127.0.0.1:3202；测试可注入）。 */
  hubUrl: string
  /** SecretStash 值的会话级环境注入。 */
  stashEnvFor(conversationId: number): Record<string, string>
  /** 文本脱敏（stash 明文 -> marker；绝不反向还原）。 */
  redact(text: string): string
  /** 产物服务（spill / 分页读取源；get 同步、其余异步）。 */
  artifacts: {
    spill(conversationId: number, callId: string, text: string): Promise<{ text: string; artifact?: unknown }>
    get(id: string): { conversationId: number } | undefined
    readContent(id: string): Promise<string>
  }
}
