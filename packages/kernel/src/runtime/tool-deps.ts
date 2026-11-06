/**
 * 工具层共享依赖（避免 tools.ts 与 runtime.ts 循环引用）。
 *
 * artifacts 接口与真实 `services/artifacts.ts` 的 `ArtifactService` Promise 签名
 * 一致（get/readContent/readBuffer 均异步）：生产端直接传服务实例，绝不以同步假
 * fixture 掩盖真实服务形态。
 */
import type { ArtifactService } from '../services/artifacts.js'

export interface HelmToolDeps {
  dataDir: string
  defaultCwd: string
  /** 按 HELM_PORT 生成的 hub URL（如 http://127.0.0.1:3202；测试可注入）。 */
  hubUrl: string
  /** SecretStash 值的会话级环境注入。 */
  stashEnvFor(conversationId: number): Record<string, string>
  /** 文本脱敏（stash 明文 -> marker；绝不反向还原）。 */
  redact(text: string): string
  /** 产物服务（与 services.ArtifactService 同签名：get/readContent/readBuffer 均异步）。 */
  artifacts: Pick<ArtifactService, 'spill' | 'get' | 'readContent' | 'readBuffer'>
}
