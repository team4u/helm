export const meta = {
  name: "hello-orchestra",
  description: "最小编排演示：并行两路 + 汇总",
  phases: [{ title: "并行打招呼" }, { title: "汇总" }],
}

log(`参数 word = ${args.word}`)
phase("并行打招呼")
const replies = await parallel([
  () => agent(`把「${args.word}」翻译成英文，只回翻译结果，不要多余内容。`, { label: "翻译英文" }),
  () => agent(`把「${args.word}」翻译成日语，只回翻译结果，不要多余内容。`, { label: "翻译日语" }),
])

phase("汇总")
const joined = replies.filter(r => r !== null).join(" / ")
const summary = await agent(`把「${joined}」合成一句话介绍，只回这一句话。`, { label: "汇总" })

return { replies, summary }
