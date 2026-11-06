/**
 * 纯文件静态认知资产契约（profiles / skills / providers）。
 * 存储与热重载机制在 kernel，这里只定义跨端共享的数据形状。
 */

/**
 * 会话 Profile：`~/.helm/profiles/<id>/profile.json` + SYSTEM.md + MEMORY.md。
 * runtime 为协议层配置形状（如绑定 Herdr CLI），实际驱动在 builtin:herdr。
 */
export interface Profile {
  id: string
  name?: string
  /** Profile 绑定的系统提示词与记忆由文件承载，此处仅留扩展位。 */
  model?: string
  /** 绑定外部运行时；缺省在 pi-durable 原生会话中执行。 */
  runtime?: ProfileRuntime
  tags?: string[]
}

/** Profile 绑定的外部 Agent 运行时配置（当前仅 herdr 一种 kind）。 */
export interface ProfileRuntime {
  kind: 'herdr'
  /** Herdr 管理的 CLI Agent 标识，如 'agy' | 'claude' | 'codex' | 'pi'。 */
  agent: string
  args?: string[]
}

/** `~/.helm/skills/<id>/`（SKILL.md + references/*.md）的目录摘要。 */
export interface SkillSummary {
  id: string
  name: string
  description?: string
  /** 支持按需读取的子文件相对路径（如 'references/xxx.md'）。 */
  references: string[]
}

/**
 * `~/.helm/providers.json` 自定义模型网关条目。
 * 严禁包含密钥字段——API Key 一律存 credentials.json（恒 0600）。
 */
export interface ProviderConfig {
  id: string
  /** OpenAI / Anthropic 兼容协议类型。 */
  protocol: 'openai' | 'anthropic'
  baseUrl: string
  /** 该网关下可用的模型 ID 列表。 */
  models: string[]
  /** 展示名（非机密）。 */
  label?: string
  /** 是否启用。 */
  enabled: boolean
}
