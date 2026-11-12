/**
 * 纯文件静态认知资产契约（profiles / skills / providers）。
 * 存储与热重载机制在 kernel，这里只定义跨端共享的数据形状。
 */

/** 空白会话的静态引导词；点击仅回填草稿，不直接提交。 */
export interface ProfileStarterPrompt {
  /** 展示标题，去除首尾空白后最多 24 个 Unicode 码点。 */
  label: string
  /** 保留原文，非纯空白，最多 4000 个 Unicode 码点。 */
  prompt: string
}

export const PROFILE_STARTERS_MAX_ITEMS = 6
export const PROFILE_STARTER_LABEL_MAX_LENGTH = 24
export const PROFILE_STARTER_PROMPT_MAX_LENGTH = 4000

/**
 * 会话 Profile：`~/.helm/profiles/<id>/profile.json` + SYSTEM.md。
 * MEMORY.md 长期记忆由 builtin:memory 插件自治管理（不进 Profile 契约）。
 * runtime 为协议层配置形状（如绑定 Herdr CLI），实际驱动在 builtin:herdr。
 */
export interface Profile {
  id: string
  name?: string
  /** Profile 绑定的系统提示词与记忆由文件承载，详情接口（GET/POST/PUT）附带全文，profile.json 落盘时剥离。 */
  model?: string
  /** Profile 级思考档位（off/minimal/low/medium/high/xhigh/max）；未设置跟随全局缺省。 */
  thinkingLevel?: string
  /** Profile 默认绑定的计算节点 ID（缺省 'local'）。 */
  nodeId?: string
  /** Profile 默认工作目录。 */
  cwd?: string
  /** 作为 subagent / 工作流节点调用时的外部执行配置；持久会话仍由 pi-durable 承载。 */
  runtime?: ProfileRuntime
  tags?: string[]
  /** 可加载技能白名单；缺省为全部可用技能，空数组禁用全部。插件停用时其托管技能始终不可用。 */
  skills?: string[]
  /** 自举或托管该 Profile 的插件 ID（对应插件未启用时前端可按此隐藏）。 */
  managedByPlugin?: string
  /** 人类是否可在「新建对话」下拉选择该 Profile；常驻单例角色置 false，缺省 true。 */
  humanSelectable?: boolean
  /** 最多六项；缺省或空数组使用宿主空白会话提示。 */
  starters?: ProfileStarterPrompt[]
  /** SYSTEM.md 全文（详情接口读写，不写入 profile.json）。 */
  system?: string
}

/** Profile 绑定的外部 Agent 运行时配置（如 'herdr'，由对应插件接管驱动）。 */
export interface ProfileRuntime {
  kind: string
  /** 外部 CLI Agent 标识，如 'agy' | 'claude' | 'codex' | 'pi'。 */
  agent: string
  args?: string[]
  /** 目标计算节点标识（缺省本机 'local'）。 */
  nodeId?: string
  /** 会话工作目录（绝对路径）；缺省由运行时决定。 */
  workspace?: string
  /** 注入子进程的环境变量覆盖。 */
  env?: Record<string, string>
}

/** `~/.helm/skills/<id>/`（SKILL.md + references/*.md）的目录摘要。 */
export interface SkillSummary {
  id: string
  name: string
  description?: string
  /** 支持按需读取的子文件相对路径（如 'references/xxx.md'）。 */
  references: string[]
  /** 托管该 Skill 的插件 ID；对应插件未启用时，会话目录、技能菜单与 load_skill 均不可用。 */
  managedByPlugin?: string
}

/** 会话技能目录与 load_skill 共用的可用性规则；不是文件系统或工具执行权限边界。 */
export function isSkillAvailable(
  skill: SkillSummary,
  profile: Pick<Profile, 'skills'>,
  enabledPluginIds: ReadonlySet<string>,
): boolean {
  return (skill.managedByPlugin === undefined || enabledPluginIds.has(skill.managedByPlugin)) &&
    (profile.skills === undefined || profile.skills.includes(skill.id))
}

/** `GET /api/models` 公开模型目录条目。 */
export interface ModelCatalogEntry {
  provider: string
  modelId: string
  available: boolean
  /** 用户显式禁用该模型（目录标注用；available 仍表示凭据可用，两者独立）。 */
  disabled?: boolean
}

/** `GET /api/models` 完整目录：模型列表 + 各模型思考档位（off/minimal/low/medium/high/xhigh/max）。 */
export interface ModelCatalog {
  models: ModelCatalogEntry[]
  /** provider/modelId -> 支持的思考档位（缺省仅 off）。 */
  thinkingLevels: Record<string, string[]>
  /** 全局默认模型（config.json.model / 启动参数；未配置省略）。 */
  defaultModel?: string
  /** 全局默认思考档位（config.json.thinkingLevel；未配置省略）。 */
  defaultThinkingLevel?: string
}

/** PI 内置供应商、插件动态供应商与已启用自定义网关的公开目录，不含凭据或私有请求头。 */
export interface ModelProviderSummary {
  id: string
  name: string
  modelCount: number
  authMethods: Array<{ type: 'api_key' | 'oauth'; label: string }>
  /** 是否支持远端动态目录刷新（实现了 refreshModels 的供应商）。 */
  dynamic?: boolean
  /** 供应商公开网关根地址或 baseUrl（非机密展示）。 */
  baseUrl?: string
  /** 注册本供应商的插件 ID（内核自动填充；非插件供应商缺省）。 */
  pluginId?: string
}

/** `POST /api/models/refresh` 动态模型目录刷新结果。 */
export interface ModelProvidersRefreshResult {
  /** 本次请求刷新的目标供应商 ID（空数组表示全部已配置动态供应商）。 */
  providers: string[]
  /** 刷新是否在中途被取消。 */
  aborted: boolean
  /** 各动态供应商刷新错误（providerId -> 错误消息）。 */
  errors: Record<string, string>
  /** 刷新后的最新模型目录。 */
  models: ModelCatalogEntry[]
  /** 刷新后的最新供应商目录摘要。 */
  providerCatalog: ModelProviderSummary[]
}

/** `PUT /api/models/filter` 请求体：按 provider 设置显式禁用的模型 ID 集（空数组 = 清空该 provider 的全部禁用项；provider 缺省 = 清空全部）。 */
export interface SetModelFilterBody {
  provider?: string
  disabledModels: string[]
}

/** `PUT /api/models/filter` 响应：更新后的完整模型目录。 */
export interface SetModelFilterResult {
  catalog: ModelCatalog
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
