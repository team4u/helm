export const meta = {
  name: "arch-master",
  description: "多模块总控：评审顶层方案与提交共享接口，并发运行模块子工作流，合入主干并过全仓门禁",
  phases: [
    { title: "评审方案与提交共享接口" },
    { title: "并发开发各模块" },
    { title: "合入主干与全仓测试" },
  ],
}

phase("评审方案与提交共享接口")
let effectiveArchSpec = args.archSpec
if (args.reviewArchSpec) {
  // 运行前先保存 cross-review.js：helm workflows save docs/workflows/examples/cross-review.js
  const archReview = await workflow("cross-review", {
    mode: "create_and_refine",
    modelB: args.modelB,
    modelC: args.modelC,
    target: `请结合代码库与项目规范检查并完善以下总体设计方案：\n${args.archSpec}`,
  })
  if (archReview === null || typeof archReview.result !== "string") {
    throw new Error("总体设计交叉评审没有返回有效结论")
  }
  effectiveArchSpec = archReview.result
}

if (args.contractSpec) {
  const contract = await goal({
    label: "contract-first",
    model: args.modelB,
    maxAttempts: 3,
    objective:
      `按总体方案更新跨模块共享接口定义并提交到主分支：\n${args.contractSpec}\n\n${effectiveArchSpec}`,
    gate: "pnpm typecheck && test -z \"$(git status --porcelain)\"",
  })
  if (!contract.ok) throw new Error(`共享接口提交失败：${contract.error}`)
}

phase("并发开发各模块")
const modDeliveries = await parallel(
  args.modules.map((mod) => () =>
    // 运行前先保存 module-dev.js：helm workflows save docs/workflows/examples/module-dev.js
    workflow("module-dev", {
      moduleName: mod.name,
      moduleScope: mod.scope,
      archSpec: effectiveArchSpec,
      modelB: args.modelB,
      modelC: args.modelC,
      gateCmd: mod.gateCmd,
    }),
  ),
)
// 子工作流失败折为 null：显式失败，绝不带着缺失模块冒充完成。
if (modDeliveries.some((item) => item === null)) {
  throw new Error("存在未完成的模块子工作流，不能合入主干")
}

phase("合入主干与全仓测试")
for (const mod of modDeliveries) {
  const modBranch = mod.branch
  // 幂等合入：已合入则跳过（merge-base --is-ancestor），可安全声明 idempotent。
  const merge = await action(
    "env.exec",
    {
      command:
        `git merge-base --is-ancestor \"${modBranch}\" HEAD || ` +
        `git merge --no-ff -m \"feat: integrate module ${mod.moduleName}\" \"${modBranch}\"`,
      allowFailure: true,
    },
    { idempotent: true, label: `root-merge-${mod.moduleName}` },
  )
  // 基础设施故障（null）与合并冲突（ok=false）分开处理，前者不交给模型。
  if (merge === null) {
    throw new Error(`主干合入模块 ${mod.moduleName} 的动作执行失败（基础设施故障，非合并冲突）`)
  }
  if (!merge.ok) {
    const resolved = await goal({
      label: `root-conflict-${mod.moduleName}`,
      model: args.modelB,
      maxAttempts: 2,
      objective:
        `主分支合入模块「${mod.moduleName}」（分支 ${modBranch}）时发生冲突：\n${merge.output}\n` +
        `请解决冲突并 git commit。`,
      gate: "test -z \"$(git status --porcelain)\" && ! git rev-parse -q --verify MERGE_HEAD",
    })
    if (!resolved.ok) {
      throw new Error(`主分支合入模块 ${mod.moduleName} 冲突解决失败：${resolved.error}`)
    }
  }
  const cleanup = await action(
    "builtin:workflow.cleanup_worktree",
    { worktreeId: mod.worktreeId, mergedInto: "HEAD", deleteBranch: true },
    { idempotent: true, label: `root-cleanup-${mod.moduleName}` },
  )
  if (cleanup === null) throw new Error(`模块 ${mod.moduleName} 的工作树清理失败`)
}

// 全仓构建与测试：失败交给模型修复再提交，不静默放行。
const finalGate = args.finalGateCmd ?? "pnpm build && pnpm typecheck && pnpm test:all"
const finalCheck = await action(
  "env.exec",
  { command: finalGate, allowFailure: true },
  { idempotent: true, label: "final-gate" },
)
if (finalCheck === null) throw new Error("全仓门禁动作执行失败")
if (!finalCheck.ok) {
  const fixed = await goal({
    label: "root-final-fix",
    model: args.modelB,
    maxAttempts: 3,
    objective: `全部模块合入主分支后全仓测试未通过：\n${finalCheck.output}\n请修复并提交。`,
    gate: `${finalGate} && test -z \"$(git status --porcelain)\"`,
  })
  if (!fixed.ok) throw new Error(`全仓测试修复失败：${fixed.error}`)
}

return { status: "completed", modules: modDeliveries.map((mod) => mod.moduleName) }
