export const meta = {
  name: "module-dev",
  description: "单模块开发：规划子代理选择做法（直接改 / 先评审 / 并发子任务），流式合入与清理并过模块门禁",
  phases: [
    { title: "模块评估与拆分" },
    { title: "执行开发" },
    { title: "合入与清理" },
  ],
}

const PLAN_SCHEMA = {
  type: "object",
  required: ["strategy"],
  properties: {
    strategy: { type: "string", enum: ["direct", "parallel_tasks", "review_then_tasks"] },
    directInstruction: { type: "string", description: "strategy=direct 时必填：直接修改的完整指令" },
    tasks: {
      type: "array",
      description: "strategy=parallel_tasks / review_then_tasks 时必填：互不重叠的子任务列表",
      items: {
        type: "object",
        required: ["id", "title", "files", "instruction", "testCmd"],
        properties: {
          id: { type: "string" },
          title: { type: "string" },
          files: { type: "array", minItems: 1, items: { type: "string" } },
          instruction: { type: "string" },
          testCmd: { type: "string" },
          maxSubagentDepth: { type: "number", minimum: 1, maximum: 4 },
        },
      },
    },
  },
}

/** 校验并发子任务列表：非空、id 唯一、文件互不重叠（并发修改同一文件必然冲突）。 */
function validateTasks(tasks, moduleName) {
  if (!Array.isArray(tasks) || tasks.length === 0) {
    throw new Error(`模块 ${moduleName} 选择了并发策略但没有提供非空的 tasks`)
  }
  const taskIds = new Set()
  const ownerByFile = new Map()
  for (const task of tasks) {
    if (taskIds.has(task.id)) throw new Error(`模块 ${moduleName} 的子任务 id 重复：${task.id}`)
    taskIds.add(task.id)
    for (const file of task.files) {
      const key = file.split("\\").join("/")
      const owner = ownerByFile.get(key)
      if (owner !== undefined) {
        throw new Error(`模块 ${moduleName} 的子任务 ${owner} 与 ${task.id} 都要修改 ${key}：并发子任务的文件不得重叠`)
      }
      ownerByFile.set(key, task.id)
    }
  }
  return tasks
}

/** 提取并校验 { id, path, branch } 工作树描述（后续合入与 cleanup 都依赖它）。 */
function requireWorktree(descriptor, what) {
  if (
    descriptor === null ||
    typeof descriptor !== "object" ||
    typeof descriptor.id !== "string" ||
    typeof descriptor.path !== "string" ||
    typeof descriptor.branch !== "string"
  ) {
    throw new Error(`${what}：没有拿到 { id, path, branch } 工作树描述`)
  }
  return descriptor
}

phase("模块评估与拆分")
const modPlan = await goal({
  label: "plan", // 子工作流有独立 scopeId，简短 label 不会与其他模块冲突
  model: args.modelB,
  isolation: "worktree",
  maxAttempts: 2,
  objective:
    `你负责模块「${args.moduleName}」（目录：${args.moduleScope}）。\n` +
    `全局接口约定：\n${args.archSpec}\n` +
    `请先查看本模块代码和可用技能（按需 load_skill），选择最合适的执行方式（strategy）：\n` +
    `1. 改动很小且集中时选 "direct"，填写 directInstruction，不拆子任务；\n` +
    `2. 需要多文件并发修改时选 "parallel_tasks"；复杂逻辑先交叉评审再拆分的选 "review_then_tasks"；\n` +
    `3. 拆分 tasks 时各子任务修改的文件不能重叠，并可按复杂度设置 maxSubagentDepth` +
    `（1=只写代码，2..4=允许在回合内继续派发 subagent 或子工作流）。规划阶段不要改代码，保持工作区干净。`,
  schema: PLAN_SCHEMA,
  gate: "test -z \"$(git status --porcelain)\"",
})
// goal 的 output 恒为字符串：schema 只负责校验，不代为解析。
if (!modPlan.ok || typeof modPlan.output !== "string") {
  throw new Error(`模块 ${args.moduleName} 规划失败：${modPlan.error ?? "没有返回文本"}`)
}
const modWt = requireWorktree(modPlan.execution?.worktree, `模块 ${args.moduleName} 规划失败`)
let planOutput
try {
  planOutput = JSON.parse(modPlan.output)
} catch {
  throw new Error(`模块 ${args.moduleName} 规划失败：输出不是合法 JSON`)
}
if (planOutput === null || typeof planOutput !== "object" || typeof planOutput.strategy !== "string") {
  throw new Error(`模块 ${args.moduleName} 规划失败：缺少 strategy`)
}
if (planOutput.strategy === "direct" && typeof planOutput.directInstruction !== "string") {
  throw new Error(`模块 ${args.moduleName} 规划失败：direct 策略缺少 directInstruction`)
}
const tasks = planOutput.strategy === "direct" ? [] : validateTasks(planOutput.tasks, args.moduleName)

phase("执行开发")
let reviewNotes = ""
if (planOutput.strategy === "review_then_tasks") {
  // 运行前先保存 cross-review.js：helm workflows save docs/workflows/examples/cross-review.js
  const review = await workflow("cross-review", {
    mode: "create_and_refine",
    cwd: modWt.path,
    modelB: args.modelB,
    modelC: args.modelC,
    target: `制定模块 ${args.moduleName}（${args.moduleScope}）的实现方案：\n${args.archSpec}`,
  })
  if (review === null || typeof review.result !== "string") {
    throw new Error(`模块 ${args.moduleName} 交叉评审没有返回有效结论`)
  }
  reviewNotes = `\n【模块实现方案】\n${review.result}\n`
}

if (planOutput.strategy === "direct") {
  const directRes = await goal({
    label: "direct-impl",
    model: args.modelC,
    cwd: modWt.path,
    maxAttempts: 3,
    objective: `${planOutput.directInstruction}\n完成后执行 git add 和 git commit 提交到当前模块分支。`,
    gate: `${args.gateCmd} && test -z \"$(git status --porcelain)\"`,
  })
  if (!directRes.ok) throw new Error(`模块 ${args.moduleName} 直接修改未通过：${directRes.error}`)
} else {
  // 并发运行子任务；任意子任务过门禁后立即排队合入模块分支并删除子工作树，不等其他慢任务。
  // 合入阶段不切换 ambient 阶段：并发中的任务节点仍在读取 ambient 值，
  // 统一用显式 phase 选项标注，避免阶段归属竞态。
  let mergeChain = Promise.resolve()
  const withMergeLock = (fn) => {
    const next = mergeChain.then(fn, fn)
    mergeChain = next.catch(() => {})
    return next
  }

  const deliveries = await pipeline(
    tasks,
    async (task) => {
      const res = await goal({
        label: `task-${task.id}`,
        model: args.modelC,
        cwd: modWt.path,
        isolation: "worktree",
        maxSubagentDepth: task.maxSubagentDepth ?? 2,
        maxAttempts: 3,
        timeoutMs: 300_000,
        gateTimeoutMs: 120_000,
        objective:
          `完成子任务「${task.title}」\n` +
          `涉及文件：${task.files.join(", ")}\n` +
          `要求：${task.instruction}${reviewNotes}` +
          `完成后必须 git add 并 git commit 到当前分支。`,
        gate: `${task.testCmd} && test -z \"$(git status --porcelain)\"`,
      })
      if (!res.ok) throw new Error(`子任务 ${task.id} 重试 ${res.attempts} 次后仍未通过：${res.error ?? "未知失败"}`)
      const taskWt = requireWorktree(res.execution?.worktree, `子任务 ${task.id} 失败`)
      return { task, worktree: taskWt }
    },
    async (item) =>
      withMergeLock(async () => {
        const leafBranch = item.worktree.branch
        // 幂等合入：已合入则跳过（merge-base --is-ancestor），可安全声明
        // idempotent 支持任意位置断点续跑。
        const merge = await action(
          "env.exec",
          {
            cwd: modWt.path,
            command:
              `git merge-base --is-ancestor \"${leafBranch}\" HEAD || ` +
              `git merge --no-ff -m \"feat(${args.moduleName}): merge ${item.task.id}\" \"${leafBranch}\"`,
            allowFailure: true,
          },
          { idempotent: true, label: `merge-${item.task.id}`, phase: "合入与清理" },
        )
        // action 失败折为 null：基础设施故障与合并冲突必须区分，前者不交给模型。
        if (merge === null) {
          throw new Error(`子任务 ${item.task.id} 的合并动作执行失败（基础设施故障，非合并冲突）`)
        }
        if (!merge.ok) {
          const resolved = await goal({
            label: `conflict-${item.task.id}`,
            model: args.modelB,
            cwd: modWt.path,
            maxAttempts: 2,
            phase: "合入与清理",
            objective: `合入分支 ${leafBranch} 时发生冲突：\n${merge.output}\n请解决冲突，git add 后完成 git commit。`,
            gate: `test -z \"$(git status --porcelain)\" && ! git rev-parse -q --verify MERGE_HEAD && ${args.gateCmd}`,
          })
          if (!resolved.ok) {
            throw new Error(`模块 ${args.moduleName} 合入 ${leafBranch} 冲突解决失败：${resolved.error}`)
          }
        }
        const cleanup = await action(
          "builtin:workflow.cleanup_worktree",
          { worktreeId: item.worktree.id, mergedInto: modWt.branch, deleteBranch: true },
          { idempotent: true, label: `cleanup-${item.task.id}`, phase: "合入与清理" },
        )
        if (cleanup === null) throw new Error(`子任务 ${item.task.id} 的工作树清理失败`)
        return item.task.id
      }),
  )
  if (deliveries.some((id) => id === null)) {
    throw new Error(`模块 ${args.moduleName} 存在未完成或失败的子任务`)
  }
}

// 模块整体门禁：子任务各自过门禁不等于合入后整体成立；失败交给模型修复再提交。
const modVerify = await action(
  "env.exec",
  { cwd: modWt.path, command: args.gateCmd, allowFailure: true },
  { idempotent: true, label: "module-gate", phase: "合入与清理" },
)
if (modVerify === null) throw new Error(`模块 ${args.moduleName} 整体门禁动作执行失败`)
if (!modVerify.ok) {
  const fixed = await goal({
    label: "modfix",
    model: args.modelB,
    cwd: modWt.path,
    maxAttempts: 2,
    phase: "合入与清理",
    objective: `模块 ${args.moduleName} 合入子任务后整体测试未通过：\n${modVerify.output}\n请修复并提交。`,
    gate: `${args.gateCmd} && test -z \"$(git status --porcelain)\"`,
  })
  if (!fixed.ok) throw new Error(`模块 ${args.moduleName} 整体测试修复失败：${fixed.error}`)
}

return { moduleName: args.moduleName, branch: modWt.branch, worktreeId: modWt.id }
