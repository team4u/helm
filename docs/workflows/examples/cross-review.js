export const meta = {
  name: "cross-review",
  description: "拆分代码审查维度，并由独立复核代理确认阻断问题",
  phases: [
    { title: "拆分检查维度" },
    { title: "并发检查与复核" },
    { title: "输出结论" },
  ],
}

const PLAN_SCHEMA = {
  type: "object",
  required: ["targetSummary", "authorInstruction", "verifierInstruction", "checkDimensions"],
  properties: {
    targetSummary: { type: "string" },
    authorInstruction: { type: "string" },
    verifierInstruction: { type: "string" },
    checkDimensions: {
      type: "array",
      items: {
        type: "object",
        required: ["id", "title", "instruction"],
        properties: {
          id: { type: "string" },
          title: { type: "string" },
          instruction: { type: "string" },
        },
      },
    },
  },
}

const FINDING_SCHEMA = {
  type: "object",
  required: ["findings"],
  properties: {
    findings: { type: "array", items: { type: "object" } },
  },
}

const VERDICT_SCHEMA = {
  type: "object",
  required: ["rejected", "reason"],
  properties: {
    rejected: { type: "boolean" },
    reason: { type: "string" },
  },
}

phase("拆分检查维度")
const plan = await agent(
  `请读取代码库和项目规范，把以下审查任务拆成 2 到 5 个互不重叠的检查维度。\n${typeof args === "string" ? args : JSON.stringify(args)}`,
  { label: "planner", model: args?.modelB, cwd: args?.cwd, schema: PLAN_SCHEMA },
)
if (!plan?.checkDimensions || typeof plan.targetSummary !== "string") {
  throw new Error("审查规划没有返回完整结构化结果")
}

let currentWork = plan.targetSummary
if (args?.mode === "create_and_refine") {
  const draft = await agent(
    `${plan.authorInstruction}\n\n请完成初稿：\n${plan.targetSummary}`,
    { label: "author", model: args?.modelB, cwd: args?.cwd },
  )
  if (draft === null) throw new Error("审查初稿失败")
  currentWork = draft
}

const maxRounds = args?.maxRounds ?? (args?.mode === "review_only" ? 1 : 3)
const history = []
phase("并发检查与复核")
for (let round = 1; round <= maxRounds; round++) {
  const verified = await pipeline(
    plan.checkDimensions,
    (dimension) => agent(
      `请检查「${dimension.title}」。\n${dimension.instruction}\n\n待检查内容：\n${currentWork}`,
      {
        label: `check-${dimension.id}-r${round}`,
        model: args?.modelC ?? args?.modelB,
        cwd: args?.cwd,
        schema: FINDING_SCHEMA,
      },
    ),
    async (result, dimension) => {
      const findings = result?.findings ?? []
      if (findings.length === 0) return []
      const judged = await parallel(findings.map((finding, index) => () =>
        agent(
          `请复核问题：\n${JSON.stringify(finding)}\n\n复核标准：\n${plan.verifierInstruction}`,
          {
            label: `verify-${dimension.id}-${index}-r${round}`,
            model: args?.modelB,
            cwd: args?.cwd,
            schema: VERDICT_SCHEMA,
          },
        ).then((verdict) => ({ finding, verdict })),
      ))
      return judged.filter((item) => item?.verdict && !item.verdict.rejected)
    },
  )
  const confirmed = verified.flat().filter(Boolean)
  history.push({ round, confirmedCount: confirmed.length, issues: confirmed })
  if (args?.mode === "review_only" || confirmed.length === 0) break
  const repaired = await agent(
    `请修复以下已确认问题，并返回修改后的审查对象：\n${JSON.stringify(confirmed)}`,
    {
      label: "author",
      resume: round === 1 ? undefined : "author",
      model: args?.modelB,
      cwd: args?.cwd,
      ...(args?.gate ? { gate: args.gate } : {}),
    },
  )
  if (repaired === null) throw new Error(`第 ${round} 轮修复失败`)
  currentWork = repaired
}

phase("输出结论")
return { passed: history.at(-1)?.confirmedCount === 0, result: currentWork, history }
