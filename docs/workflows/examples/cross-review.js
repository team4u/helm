export const meta = {
  name: "cross-review",
  description: "多视角交叉审查：先动态拆分检查维度，再并发检查、独立复核过滤误报并闭环修改",
  phases: [
    { title: "拆分检查维度" },
    { title: "并发检查与复核" },
    { title: "输出结论" },
  ],
}

const PLAN_SCHEMA = {
  type: "object",
  required: ["mode", "targetSummary", "authorInstruction", "verifierInstruction", "checkDimensions"],
  properties: {
    mode: { type: "string", enum: ["review_only", "create_and_refine", "fix_in_place"] },
    targetSummary: { type: "string", description: "待审查对象的摘要" },
    authorInstruction: { type: "string", description: "编写或修改时的说明：指出需要加载的技能（load_skill）或项目文档路径" },
    verifierInstruction: { type: "string", description: "复核准则：如何对照源码和项目规范剔除误报与过度设计" },
    checkDimensions: {
      type: "array",
      minItems: 2,
      maxItems: 5,
      items: {
        type: "object",
        required: ["id", "title", "instruction"],
        properties: {
          id: { type: "string" },
          title: { type: "string" },
          instruction: { type: "string", description: "该维度的检查重点及需要读取的技能或文件路径" },
        },
      },
    },
  },
}

const FINDING_SCHEMA = {
  type: "object",
  required: ["findings"],
  properties: {
    findings: {
      type: "array",
      items: {
        type: "object",
        required: ["id", "severity", "location", "claim", "evidence", "suggestion"],
        properties: {
          id: { type: "string" },
          severity: { type: "string", enum: ["blocker", "major"] },
          location: { type: "string" },
          claim: { type: "string" },
          evidence: { type: "string", description: "具体的文件行号、复现步骤或违反的规范条目" },
          suggestion: { type: "string" },
        },
      },
    },
  },
}

const VERDICT_SCHEMA = {
  type: "object",
  required: ["rejected", "reason"],
  properties: {
    rejected: { type: "boolean", description: "如果是误报、脱离上下文或属于过度设计，设为 true 驳回" },
    reason: { type: "string" },
  },
}

phase("拆分检查维度")
const plan = await agent(
  `请查看以下任务的目标文件、项目规范（如 AGENTS.md）和可用技能列表（<available_skills>）：\n` +
    `${typeof args === "string" ? args : JSON.stringify(args, null, 2)}\n\n` +
    `请先用 load_skill 查看相关技能说明，把本次审查拆成 2~5 个互不重叠的检查维度（checkDimensions），` +
    `并写明修改人和复核人的判断标准。`,
  { label: "planner", model: args?.modelB, cwd: args?.cwd, schema: PLAN_SCHEMA },
)
if (plan === null || !Array.isArray(plan.checkDimensions) || plan.checkDimensions.length === 0) {
  throw new Error("审查规划没有返回完整的结构化结果")
}

let currentWork = plan.targetSummary
if (plan.mode === "create_and_refine") {
  const draft = await agent(`${plan.authorInstruction}\n\n请完成初稿：\n${plan.targetSummary}`, {
    label: "author",
    model: args?.modelB,
    cwd: args?.cwd,
  })
  if (draft === null) throw new Error("审查初稿编写失败")
  currentWork = draft
}

const maxRounds = args?.maxRounds ?? (plan.mode === "review_only" ? 1 : 3)
const history = []

phase("并发检查与复核")
for (let round = 1; round <= maxRounds; round++) {
  const verifiedLists = await pipeline(
    plan.checkDimensions,
    (dimension) =>
      agent(
        `你负责检查「${dimension.title}」。\n【检查标准】\n${dimension.instruction}\n\n` +
          `【待检查内容（第 ${round} 轮）】\n${currentWork}\n\n` +
          `只报告有明确依据的 blocker/major 问题；没有问题则返回 findings=[]。`,
        {
          label: `check-${dimension.id}-r${round}`,
          model: args?.modelC ?? args?.modelB,
          cwd: args?.cwd,
          schema: FINDING_SCHEMA,
        },
      ),
    async (result, dimension) => {
      // 检查维度自身失败 ≠ 该维度没有问题：显式抛错让本条流水线项折为 null，
      // 由循环末尾的显式失败兜底，绝不冒充“检查通过”。
      if (result === null) throw new Error(`检查维度「${dimension.title}」执行失败`)
      if (result.findings.length === 0) return []
      const judged = await parallel(
        result.findings.map((finding) => () =>
          agent(
            `请复核以下问题是否成立。\n【复核标准】\n${plan.verifierInstruction}\n\n` +
              `检查维度「${dimension.title}」报告的问题：\n${JSON.stringify(finding, null, 2)}\n\n` +
              `请直接读取源码和文档核实：如果是误报或过度设计，将 rejected 设为 true。`,
            {
              label: `verify-${dimension.id}-${finding.id}-r${round}`,
              model: args?.modelB,
              cwd: args?.cwd,
              schema: VERDICT_SCHEMA,
            },
          ).then((verdict) => ({
            ...finding,
            dimension: dimension.title,
            verdict,
            // 复核人失败（返回 null）时结论未知：保留问题并标记存疑，
            // 绝不能把“没能复核”折叠成“没有问题”。
            verdictMissing: verdict === null,
          })),
        ),
      )
      return judged
    },
  )
  if (verifiedLists.some((list) => list === null)) {
    throw new Error(`第 ${round} 轮存在执行失败的检查维度，无法宣称审查通过`)
  }
  const confirmed = verifiedLists
    .flat()
    .filter((item) => item.verdict === null || item.verdict.rejected !== true)
  history.push({ round, confirmedCount: confirmed.length, issues: confirmed })
  if (plan.mode === "review_only" || confirmed.length === 0) break

  // create_and_refine 的初稿由 author 完成，第 1 轮修复即续接同一 author 会话；
  // fix_in_place 的 author 首次登场是新会话，第 2 轮起才续接。
  // resume 与 model/cwd 互斥：续接会话保持启动时的模型与工作目录。
  const resumeAuthor = plan.mode === "create_and_refine" || round > 1
  const repaired = await agent(
    `复核确认以下 ${confirmed.length} 个问题需要处理` +
      `（verdictMissing=true 表示复核人未能给出结论，按存疑处理）：\n` +
      `${JSON.stringify(confirmed, null, 2)}\n\n请逐项修复并验证，返回修改后的完整内容。`,
    {
      label: "author",
      ...(resumeAuthor ? { resume: "author" } : { model: args?.modelB, cwd: args?.cwd }),
      ...(args?.gate ? { gate: args.gate } : {}),
    },
  )
  if (repaired === null) throw new Error(`第 ${round} 轮修复失败`)
  currentWork = repaired
}

phase("输出结论")
return { passed: history.at(-1)?.confirmedCount === 0, result: currentWork, history }
