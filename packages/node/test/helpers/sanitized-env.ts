/**
 * packages/node 测试专用：宿主受管 Helm 环境变量剥除助手。
 *
 * 背景：在 Helm 会话内跑测试时，测试进程天然继承宿主受管 HELM_* 变量
 * （bash/read 等受管工具注入）。测试若以 `env: { ...process.env }` 直通展开
 * 给被测 CLI/daemon 子进程，宿主的控制端点/实例 ID/执行作用域/凭据会被
 * 被测进程误读为自身启动上下文，破坏「无控制 env 成为 launcher」
 * 「registered 来自真实注册」「fail-closed 剥除」等测试前提。
 *
 * 用法：被测子进程 env 一律以 `sanitizedHostEnv()` 为基底，再覆盖测试显式
 * 变量：`env: { ...sanitizedHostEnv(), HELM_HUB_URL: hub.url }`。测试自己
 * 显式设置的受管变量（如 HELM_VERSION_OVERRIDE fixture 值）在基底展开之后
 * 覆盖，不受剥除影响。普通变量（PATH/HOME 等本机工具链）原样保留。
 */

import process from 'node:process';

/**
 * 需剥除的宿主受管变量（大写名集合；匹配大小写不敏感——Windows env 名大小
 * 写不敏感，helm_token / Helm_Cwd 等变体在子进程读取时可劫持 canonical 值，
 * 与内核 MANAGED_ENV_UPPER、upgrade-handoff 候选剥除的大小写语义同向）。
 *
 * 语义依据（每项注明为何必须剥除）：
 * - 内核受管执行注入八元组（packages/kernel/src/env/scoped-env.ts 的
 *   MANAGED_EXEC_ENV_VARS，由 runtime/tools/managed-env.ts buildManagedEnv
 *   固定合成）：
 *   - HELM_ENV：宿主「当前处于 Helm 受管执行环境」标记，被测进程误读会
 *     改变启动分支语义；
 *   - HELM_HUB_URL：宿主真实 Hub 地址（如 3202），被测 daemon/doctor 会
 *     转而连接真实 Hub 而非测试 fixture，注册与探测目标被劫持；
 *   - HELM_CONVERSATION_ID：宿主会话 ID，与被测进程身份无关；
 *   - HELM_CWD：宿主会话 cwd，同上；
 *   - HELM_DATA_DIR：宿主（Hub 本机）数据目录，CLI 缺省 --data-dir 读取它，
 *     继承即数据目录劫持；
 *   - HELM_NODE_ID：宿主执行节点 ID，被测进程误读为自身节点身份；
 *   - HELM_EXECUTION_SCOPE：宿主执行作用域锚点（node 侧 env-rpc-server
 *     buildExecEnv 亦将其与 HELM_TOKEN 一并列为继承剥除对象）；
 *   - HELM_TOKEN：宿主受管凭据——既泄漏进被测进程，又被 daemon/CLI 误读
 *     为自身注册令牌，破坏「registered 来自真实注册」前提；
 * - 节点守护进程控制/升级身份四元组（packages/node/src/cli.ts 头注释与
 *   daemon/upgrade-handoff.ts prepareNodeReplacement 候选剥除清单——候选拥
 *   有独立控制身份，绝不继承父控制 env）：
 *   - HELM_NODE_INSTANCE_ID / HELM_NODE_CONTROL_ENDPOINT：daemon 控制通道
 *     实例身份；继承即「已被控制」，前台 start 不再成为 launcher；
 *   - HELM_NODE_PENDING_ACTIVATION：升级候选待激活标记，误读会改变候选
 *     注册/激活语义；
 *   - HELM_VERSION_OVERRIDE：版本覆盖，继承会上报伪造版本而非真实运行
 *     版本。
 */
const HOST_MANAGED_HELM_ENV_UPPER: ReadonlySet<string> = new Set(
  [
    'HELM_ENV',
    'HELM_HUB_URL',
    'HELM_CONVERSATION_ID',
    'HELM_CWD',
    'HELM_DATA_DIR',
    'HELM_NODE_ID',
    'HELM_EXECUTION_SCOPE',
    'HELM_TOKEN',
    'HELM_NODE_INSTANCE_ID',
    'HELM_NODE_CONTROL_ENDPOINT',
    'HELM_NODE_PENDING_ACTIVATION',
    'HELM_VERSION_OVERRIDE',
  ].map((name) => name.toUpperCase()),
);

/**
 * 以 `{ ...process.env }` 为基底返回剥除宿主受管 Helm 变量后的新副本：
 * 每次调用返回独立对象，调用方可安全继续覆盖测试显式变量；绝不改动
 * `process.env` 本身。
 */
export function sanitizedHostEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) {
    if (HOST_MANAGED_HELM_ENV_UPPER.has(key.toUpperCase())) delete env[key];
  }
  return env;
}

/** 导出受管变量名清单（canonical 大写），供契约测试锁定集合语义。 */
export const HOST_MANAGED_HELM_ENV_NAMES: readonly string[] = [...HOST_MANAGED_HELM_ENV_UPPER];
