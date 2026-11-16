export const meta = {
  name: "hello-orchestra",
  description: "most small orchestration demo: two parallel lanes + aggregate",
  phases: [{ title: "parallel hit move call" }, { title: "aggregate" }],
}

log(`parameter word = ${args.word}`)
phase("parallel hit move call")
const replies = await parallel([
  () => agent(`${args.word}translate into English, only back translate result, do not want redundant content.`, { label: "translate English" }),
  () => agent(`${args.word}translate into day language, only back translate result, do not want redundant content.`, { label: "translate day language" }),
])

phase("aggregate")
const joined = replies.filter(r => r !== null).join(" / ")
const summary = await agent(`${joined}together into one sentence speech introduce, only back this one sentence speech.`, { label: "aggregate" })

return { replies, summary }
