export const meta = {
  name: "module-dev",
  description: "在模块工作树中规划、并发实现、合入并执行模块门禁",
  phases: [
    { title: "模块评估与拆分" },
    { title: "执行开发" },
    { title: "合入与清理" },
  ],
}

phase("模块评估与拆分")
const plan = await goal({
  label: "plan",
  model: args.modelB,
  isolation: "worktree",
  maxAttempts: 2,
  objective:
    `负责模块「${args.moduleName}」（目录：${args.moduleScope}）。\n` +
    `共享接口约定：\n${args.archSpec}\n` +
    `选择 direct、parallel_tasks 或 review_then_tasks，并返回 strategy、directInstruction、tasks。`,
  schema: {
    type: "object",
    required: ["strategy"],
    properties: {
      strategy: { type: "string", enum: ["direct", "parallel_tasks", "review_then_tasks"] },
      directInstruction: { type: "string" },
      tasks: { type: "array", items: { type: "object" } },
    },
  },
  gate: "test -z \"$(git status --porcelain)\"",
})
if (!plan.ok || !plan.execution?.worktree || typeof plan.output !== "string") throw new Error(`模块规划失败：${plan.error}`)
let planOutput
try {
  planOutput = JSON.parse(plan.output)
} catch {
  throw new Error("模块规划没有返回合法 JSON")
}
if (!planOutput || typeof planOutput.strategy !== "string") throw new Error("模块规划缺少 strategy")
const moduleWorktree = plan.execution.worktree

phase("执行开发")
if (planOutput.strategy === "review_then_tasks") {
  // 运行前先保存 cross-review.js：helm workflows save docs/workflows/examples/cross-review.js
  const review = await workflow("cross-review", {
    mode: "create_and_refine",
    cwd: moduleWorktree.path,
    modelB: args.modelB,
    modelC: args.modelC,
    target: `制定模块 ${args.moduleName} 的实现方案：\n${args.archSpec}`,
  })
  if (!review) throw new Error("模块交叉评审失败")
}

if (planOutput.strategy === "direct") {
  const result = await goal({
    label: "direct-impl",
    model: args.modelC,
    cwd: moduleWorktree.path,
    maxAttempts: 3,
    objective: `${planOutput.directInstruction ?? "完成模块实现"}\n完成后提交当前分支。`,
    gate: `${args.gateCmd} && test -z \"$(git status --porcelain)\"`,
  })
  if (!result.ok) throw new Error(`模块直接实现失败：${result.error}`)
} else {
  let mergeChain = Promise.resolve()
  const withMergeLock = (fn) => {
    const next = mergeChain.then(fn, fn)
    mergeChain = next.catch(() => {})
    return next
  }
  const deliveries = await pipeline(
    planOutput.tasks ?? [],
    async (task) => {
      const result = await goal({
        label: `task-${task.id}`,
        model: args.modelC,
        cwd: moduleWorktree.path,
        isolation: "worktree",
        maxAttempts: task.maxAttempts ?? 3,
        timeoutMs: 300_000,
        gateTimeoutMs: 120_000,
        objective: `完成子任务「${task.title}」\n涉及文件：${task.files?.join(", ")}\n${task.instruction}\n完成后提交。`,
        gate: `${task.testCmd} && test -z \"$(git status --porcelain)\"`,
      })
      if (!result.ok || !result.execution?.worktree) throw new Error(`子任务 ${task.id} 失败：${result.error}`)
      return { task, worktree: result.execution.worktree }
    },
    async (item) => withMergeLock(async () => {
      phase("合入与清理")
      const merge = await action("env.exec", {
        cwd: moduleWorktree.path,
        command: `git merge-base --is-ancestor "${item.worktree.branch}" HEAD || git merge --no-ff -m "feat(${args.moduleName}): merge ${item.task.id}" "${item.worktree.branch}"`,
        allowFailure: true,
      }, { idempotent: true, label: `merge-${item.task.id}` })
      if (!merge.ok) throw new Error(`合入子任务 ${item.task.id} 失败：${merge.output}`)
      await action("builtin:workflow.cleanup_worktree", {
        worktreeId: item.worktree.id,
        mergedInto: moduleWorktree.branch,
        deleteBranch: true,
      }, { idempotent: true, label: `cleanup-${item.task.id}` })
      return item.task.id
    }),
  )
  if (deliveries.some((id) => !id)) throw new Error("存在未完成的子任务")
}

const verify = await action("env.exec", {
  cwd: moduleWorktree.path,
  command: args.gateCmd,
  allowFailure: true,
}, { idempotent: true, label: "module-gate" })
if (!verify.ok) throw new Error(`模块门禁失败：${verify.output}`)
return { moduleName: args.moduleName, branch: moduleWorktree.branch, worktreeId: moduleWorktree.id }
