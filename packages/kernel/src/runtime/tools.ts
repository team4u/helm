/**
 * 内核自带本机工具（组合出口）：实现按职责拆分在本目录子模块，本文件仅
 * 再导出，供 runtime.ts / spawn.ts / tool-registry.ts 及测试的既有
 * `./tools.js` 导入路径保持稳定。
 *
 * - shell 执行引擎（runShell / runGate / bash 工具）：tools/shell-exec.ts——
 *   真实进程组、超时、abort、跨 chunk UTF-8 保真、输出限额显式报错；
 * - 受管 env 合成（buildToolEnv / buildManagedEnv / executionScopeHash）：
 *   tools/managed-env.ts——受管 HELM_* 变量固定覆盖，合成权威在
 *   env/scoped-env.ts 的 ScopedExecutionEnv；
 * - 路径词法解析（resolveTargetPath）：tools/target-path.ts——按目标路径
 *   形状选纯 posix/win32 规则，绝不用 Hub 宿主 node:path 默认规则解析
 *   远端路径；isAbsoluteTargetPath/targetPathShape 再导出自 @helm/protocol；
 * - 远端守卫（env_fabric_missing / node_offline）：tools/guards.ts——
 *   EnvFabric 缺失与节点离线显式失败，绝不静默回退 local；
 * - read/write/edit 文件工具：tools/file-ops.ts + tools/file-env.ts——
 *   local（进程内 fs）与 EnvFabric 远端分支收敛为统一执行环境适配 +
 *   单一模板；读-改-写经 env/file-mutation-queue 互斥；edit 行级差异在
 *   runtime/tool-edit-diff.ts 唯一实现；
 * - register_artifact / read_artifact：tools/artifact-tools.ts——真实普通
 *   文件复制登记（上限 15 MiB、同 fd 有界读取、中途变更显式拒绝）与
 *   spill 产物分页读取（UTF-8 边界对齐保证前进）；read_artifact 区分
 * 「产物不存在」与「存储读取失败」，后者如实透出原始错误。
 *
 * 文件路径契约（read/write/edit，对齐 pi）：会话 cwd 仅作为相对路径的解析
 * 基准，绝对路径与 ../ 跨目录访问一律允许——bash 本就无文件边界，文件工具
 * 与 bash 同权，不设 cwd 沙箱；权限边界交给操作系统本身。timeoutMs 必须为
 * 正有限整数且 ≤ 上限，非法值显式 invalid_timeout。SecretStash 脱敏在聚合
 * 完成的全文上执行（先完整拼接再 redact，跨 chunk 撕裂的秘密也必然完整
 * 匹配），绝不反向还原。
 */
export { resolveTargetPath } from './tools/target-path.js'
export {
  runShell,
  runGate,
  createBashTool,
  MAX_TIMEOUT_MS,
  MAX_OUTPUT_BYTES,
  STREAM_AGGREGATE_LIMIT_BYTES,
  type ShellRunResult,
} from './tools/shell-exec.js'
export { buildToolEnv, buildManagedEnv, executionScopeHash } from './tools/managed-env.js'
export { createReadTool, createWriteTool, createEditTool } from './tools/file-ops.js'
export { READ_FILE_MAX_BYTES } from './tools/file-env.js'
export {
  createRegisterArtifactTool,
  createReadArtifactTool,
  readArtifactBytesFromHandle,
  type ArtifactFileBytes,
  type ArtifactReadHandle,
} from './tools/artifact-tools.js'
// 形状判定与词法规则子集收口 @helm/protocol（浏览器安全纯函数，内核与
// @helm/plugins 共享）；此处再导出供既有相对路径引用保持稳定。
export { isAbsoluteTargetPath, targetPathShape } from '@helm/protocol'
