# 第一个 JavaScript 工作流

这个例子让两个子代理分别把一个词译成英文和日文，再请第三个子代理把结果写成一句话。用已经配置好默认模型的 Hub 跑一遍，就能看到并行步骤如何结束、汇总在哪一步开始。 [安装并配置模型](index.md)

## 准备脚本

把下面的内容保存为 `hello-orchestra.workflow.js`。如果已经克隆了 Helmx，也可以直接用仓库里的 [hello-orchestra.workflow.js](../../demo/hello-orchestra.workflow.js)。

```javascript
export const meta = {
  name: "hello-orchestra",
  description: "并行翻译并汇总",
  phases: [{ title: "翻译" }, { title: "汇总" }],
}

phase("翻译")
const replies = await parallel([
  () => agent(`把「${args.word}」翻译成英文，只回翻译结果。`, { label: "英文" }),
  () => agent(`把「${args.word}」翻译成日文，只回翻译结果。`, { label: "日文" }),
])

phase("汇总")
const translations = replies.filter(reply => reply !== null)
const summary = await agent(`用一句话介绍这些翻译：${translations.join(" / ")}`, { label: "汇总" })
return { replies, summary }
```

`meta.phases` 和 `phase()` 决定界面里的阶段。`parallel()` 同时启动两个翻译步骤，等它们都结束才进入汇总。普通分支失败时，对应位置是 `null`，因此汇总只取有结果的项。脚本返回的对象会出现在 `run.result`。 [编排 API](../workflows/dsl-guide.md)

## 运行一次

在保存脚本的目录打开终端，登录 CLI 后创建一个用于练习的会话。

```bash
helmx conversations create --title '工作流练习' --json
```

从输出里找到会话 ID。把下面的 `42` 换成该 ID。源码仓未安装全局命令时，可以在仓库根目录使用 `pnpm helmx`，并按实际位置填写脚本路径。

```bash
helmx workflows run ./hello-orchestra.workflow.js \
  --args '{"word":"开源"}' --conversation-id 42 --wait --json
```

`--wait` 会等到这次运行结束，成功时输出包含 `run.status` 和 `run.result` 的 JSON。命令运行时，可以打开浏览器里的目标会话，到工作台看「翻译」和「汇总」两个阶段，点开其中一个节点查看子会话。需要从命令行查看时，用 `helmx workflows runs` 找到运行 ID，再用 `helmx workflows inspect` 查看详情。

## 续跑失败的任务

如果整次运行失败，先在工作台查看失败节点，或执行 `helmx workflows inspect`。用了 `--wait --json` 时，错误的 `details.runId` 也会给出运行 ID。修好模型配置或执行环境后，用原脚本和该 ID 续跑。原会话和原参数会自动沿用。

```bash
helmx workflows run ./hello-orchestra.workflow.js \
  --resume-from-run-id "$failed_run_id" --wait --json
```

先把查到的运行 ID 赋给 `failed_run_id`，例如 `failed_run_id=wf_1a2b3c4d5e6f`。引擎会按步骤比对旧记录，匹配的成功调用可以复用。并行分支各自匹配，所以一支失败时，另一支仍有机会复用。这个翻译例子允许部分失败，看到某项是 `null` 时，整次运行仍可能是 `completed`。如果脚本调用了有外部副作用的动作，恢复时发现动作结果无法确认，会报 `workflow_action_uncertain`。 [恢复与重放规则](../workflows/journaling-recovery.md)

脚本里的任务需要改代码时，可以给 `agent()` 加上 `isolation: 'worktree'` 和 `gate`。`gate` 填项目的测试命令。 [工作树与测试门禁](../workflows/worktree-and-gate.md)
