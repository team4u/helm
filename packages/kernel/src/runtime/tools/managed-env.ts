/**
 * 受管环境合成（唯一权威在 env/scoped-env.ts 的 ScopedExecutionEnv 之外的
 * 工具侧组装层）：local 继承 process.env（真实 PATH/HOME）并剥除受管 HELM_*
 * 变量（大小写不敏感），受管变量（HELM_ENV / HELM_HUB_URL /
 * HELM_CONVERSATION_ID / HELM_CWD / HELM_DATA_DIR / HELM_NODE_ID /
 * HELM_EXECUTION_SCOPE / 受管 HELM_TOKEN）由 buildManagedEnv 现场合成固定
 * 覆盖，deps.cliBinDir 前置注入 PATH；远端节点绝不携带 Hub 宿主环境、也绝不
 * 合成默认 PATH（节点守护进程自身合并节点 PATH/HOME 并剥除节点宿主
 * HELM_TOKEN）；远端 HELM_HUB_URL 仅取节点注册时上报的真实 hubUrl（未上报
 * 则省略该键，绝不 fallback Hub 本机地址）。此处不另立第二套合成规则。
 */
import { createHash } from 'node:crypto'
import { composeExecutionEnv, MANAGED_EXEC_ENV_VARS } from '../../env/scoped-env.js'
import type { HelmToolDeps } from '../tool-deps.js'

/** 组装工具环境：process.env < options.env < 受管变量（固定覆盖，见 buildManagedEnv）。 */
export function buildToolEnv(
  deps: HelmToolDeps,
  cwd: string,
  conversationId?: number,
  extraEnv?: Record<string, string>,
  nodeId: string = 'local',
): Record<string, string> {
  return composeExecutionEnv(nodeId, buildManagedEnv(deps, cwd, conversationId, nodeId), extraEnv, {
    cliBinDir: deps.cliBinDir,
  })
}

/**
 * 执行作用域锚点：HELM_EXECUTION_SCOPE = `helm-<sha256 前 24 hex>`。
 * 输入仅含非机密执行事实（Helm 实例标识 dataDir、会话 ID、节点 ID、实际
 * cwd，数组 JSON 序列化防分隔符歧义）；同会话同靶点多命令恒定相同，跨
 * 会话/节点/工作树/Helm 实例不同。它是供工具显式采用的稳定资源命名提示
 * （锁文件/临时目录/缓存前缀等），不是 OS 沙箱、不承诺自动隔离第三方
 * daemon；绝不包含任何 secret。
 */
export function executionScopeHash(
  dataDir: string,
  conversationId: number | undefined,
  nodeId: string,
  cwd: string,
): string {
  const digest = createHash('sha256')
    .update(JSON.stringify([dataDir, conversationId ?? 0, nodeId, cwd]))
    .digest('hex')
  return `helm-${digest.slice(0, 24)}`
}

/** 受管身份变量名大写集：stash/profile 一切大小写变体均不得提供（Windows
 *  env 名大小写不敏感，lowercase 别名可在子进程读取时劫持 canonical 值）。 */
const MANAGED_ENV_UPPER = new Set<string>(MANAGED_EXEC_ENV_VARS.map((name) => name.toUpperCase()))

/**
 * 宿主受管环境变量（不含 process.env）：会话 SecretStash 注入 + 固定覆盖的
 * HELM_ENV / HELM_HUB_URL / HELM_CONVERSATION_ID / HELM_CWD / HELM_EXECUTION_SCOPE /
 * （仅 local）HELM_DATA_DIR，以及受管 HELM_TOKEN（无受管 token 时绝不透传同名继承值）。
 * stash 键命中受管身份变量（含大小写变体）时一律剥除（Windows env 名大小写
 * 不敏感，别名劫持回连/身份/作用域变量）；受管值仅在此合成 canonical 名。
 * local（继承 process.env）与远端（不携带宿主进程环境）共用此构造。
 * options.stashEnv 可覆盖默认的「全部活跃秘密」（外部 spawn 最小授权用：
 * 传 {} 即不携带任何会话机密，只保留受管 HELM_*）。
 * 远端专用语义：
 * - HELM_HUB_URL 仅取节点 register 时上报的真实回连地址（守恒）；节点未上报
 *   时省略该键（daemon 侧保持其 shellEnv 的真实 hubUrl），绝不 fallback
 *   deps.hubUrl（那可能是 Hub 本机 127.0.0.1，远端不可达）；
 * - HELM_DATA_DIR 是 Hub 本机路径，不注入远端（防节点误用 Hub 磁盘路径）；
 * - HELM_TOKEN 为 Hub 进程受管 token：远端子进程凭它经 HTTP 回连 Hub 鉴权
 *  （verifyToken 认进程内摘要；诚实边界：token 会出现在远端机器内存/环境，
 *   与本机子进程同权，不承诺对远端机器零泄漏）。
 */
export function buildManagedEnv(
  deps: HelmToolDeps,
  cwd: string,
  conversationId?: number,
  nodeId: string = 'local',
  options: { stashEnv?: Record<string, string> } = {},
): Record<string, string> {
  const stashEnv =
    options.stashEnv !== undefined
      ? options.stashEnv
      : conversationId === undefined
        ? {}
        : deps.stashEnvFor(conversationId)
  // stash 一律不得携带受管身份变量（含大小写变体）：受管值仅由下方固定覆盖
  // 合成 canonical 名；secret 命中 helm_execution_scope / Helm_Cwd 等别名时
  // 直接剥除（Windows env 名大小写不敏感，别名可劫持子进程读取）。拷贝用
  // 展开语义（DefineOwnProperty）保留 __proto__ 等自有键，剥除用 delete。
  const safeStashEnv: Record<string, string> = { ...stashEnv }
  for (const key of Object.keys(stashEnv)) {
    if (MANAGED_ENV_UPPER.has(key.toUpperCase())) delete safeStashEnv[key]
  }
  const managedToken = deps.processToken?.()
  // 远端回连地址守恒：仅用节点注册时上报的真实 hubUrl；未上报则省略该键，
  // 绝不 fallback deps.hubUrl（Hub 本机地址对远端不可达）。
  const nodeHubUrl = nodeId !== 'local' ? deps.envFabric?.getNodeHubUrl(nodeId) : undefined
  const hubUrl = nodeId === 'local' ? deps.hubUrl : nodeHubUrl
  const env: Record<string, string> = {
    ...safeStashEnv,
    HELM_ENV: '1',
    ...(hubUrl !== undefined ? { HELM_HUB_URL: hubUrl } : {}),
    HELM_CONVERSATION_ID: String(conversationId ?? 0),
    HELM_CWD: cwd,
    ...(nodeId === 'local' ? { HELM_DATA_DIR: deps.dataDir } : {}),
    HELM_NODE_ID: nodeId,
    HELM_EXECUTION_SCOPE: executionScopeHash(deps.dataDir, conversationId, nodeId, cwd),
  }
  if (managedToken === undefined) delete env['HELM_TOKEN']
  else env['HELM_TOKEN'] = managedToken
  return env
}
