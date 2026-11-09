# demo

可运行演示资产。

## hello-orchestra.workflow.js

SubagentWorkflow 确定性编排最小演示：并行两路翻译 + 汇总。

```bash
pnpm helm workflows run demo/hello-orchestra.workflow.js --args '{"word":"开源"}' --wait
```
