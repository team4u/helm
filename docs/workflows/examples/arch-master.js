export const meta = {
  name: "arch-master",
  description: "评审共享接口、并发运行模块工作流、合入主干并执行全仓门禁",
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
  effectiveArchSpec = (await workflow("cross-review", {
    mode: "create_and_refine",
    modelB: args.modelB,
    modelC: args.modelC,
    target: `完善总体设计方案：\n${args.archSpec}`,
  })).result
}
if (args.contractSpec) {
  const contract = await goal({
    label: "contract-first",
    model: args.modelB,
    maxAttempts: 3,
    objective: `更新跨模块共享接口并提交：\n${args.contractSpec}\n\n${effectiveArchSpec}`,
    gate: "pnpm typecheck && test -z \"$(git status --porcelain)\"",
  })
  if (!contract.ok) throw new Error(`共享接口提交失败：${contract.error}`)
}

phase("并发开发各模块")
const deliveries = await parallel(args.modules.map((module) => () => workflow("module-dev", {
  moduleName: module.name,
  moduleScope: module.scope,
  archSpec: effectiveArchSpec,
  modelB: args.modelB,
  modelC: args.modelC,
  gateCmd: module.gateCmd,
})))
if (deliveries.some((item) => !item)) throw new Error("存在未完成的模块工作流")

phase("合入主干与全仓测试")
for (const module of deliveries) {
  const merge = await action("env.exec", {
    command: `git merge-base --is-ancestor "${module.branch}" HEAD || git merge --no-ff -m "feat: integrate module ${module.moduleName}" "${module.branch}"`,
    allowFailure: true,
  }, { idempotent: true, label: `root-merge-${module.moduleName}` })
  if (!merge.ok) throw new Error(`主干合入模块 ${module.moduleName} 失败：${merge.output}`)
  await action("builtin:workflow.cleanup_worktree", {
    worktreeId: module.worktreeId,
    mergedInto: "HEAD",
    deleteBranch: true,
  }, { idempotent: true, label: `root-cleanup-${module.moduleName}` })
}

const finalGate = args.finalGateCmd ?? "pnpm build && pnpm typecheck && pnpm test:all"
const finalCheck = await action("env.exec", { command: finalGate, allowFailure: true }, { idempotent: true, label: "final-gate" })
if (!finalCheck.ok) throw new Error(`全仓门禁失败：${finalCheck.output}`)
return { status: "completed", modules: deliveries.map((module) => module.moduleName) }
