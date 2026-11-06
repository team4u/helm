# 第三方组件声明（Third Party Notices）

本文件列出 helm 仓库内移植或衍生自第三方开源软件的模块及其许可要求。

---

## @tintinweb/pi-subagents

- **来源**：<https://github.com/tintinweb/pi-subagents>
- **版本**：v0.23.1（npm 包 `@tintinweb/pi-subagents@0.23.1`）
- **许可**：MIT License（原文见下）
- **移植模块**（`packages/kernel/src/workflow/`，按 helm 语义改写与加固，
  非逐字复制）：
  - `runtime.ts` — 宿主半边：worker 生命周期、RPC 桥、并发信号量、
    run 上限与进度日志；helm 适配：action() 原语宿主侧、统一有序
    agent+action 前缀账本、action started/终态 fsync 与
    workflow_action_uncertain 恢复语义
  - `worker-source.ts` — worker 线程内联源码：vm context、确定性
    Prelude、parallel/pipeline；helm 加固：globalThis.Date 同步替换为
    受限构造器（上游仅词法 shadow，可被 `new globalThis.Date()` 绕过）；
    helm 新增 action() 原语
  - `journal.ts` — 前缀重放账本；helm 加固：action 行 fsync、写失败
    fatal、损坏行影响 action 完成判定时显式 uncertain（上游
    readJournal/appendJournal 静默吞错，不适用于带副作用的 action）
  - `meta.ts` — meta 块字面量扫描与受限求值
  - `json-schema.ts` — 裸 JSON Schema 编译与校验（typebox v1）
  - `progress.ts` — append-only 进度折叠模型（裁掉上游 TUI 渲染辅助）
- **未移植**：`host.ts`（pi ExtensionAPI/AgentManager 绑定，helm 以
  WorkflowServiceHost 适配 KernelRuntime 重写）、`task.ts` /
  `saved.ts` / `collisions.ts` / `entry.ts` / `tool-description.ts`
  （pi 会话任务记录与 TUI 特有，helm 由 HTTP/CLI/Web 层承担）

### MIT License（原文）

```
MIT License

Copyright (c) 2026 tintinweb

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

---

## typebox

- **来源**：<https://github.com/sinclairzx81/typebox>
- **许可**：MIT License
- **用途**：`packages/kernel/src/workflow/json-schema.ts` 对脚本提供的裸
  JSON Schema 做标准校验（`typebox/value` 的 Check/Errors）。typebox v1
  是标准 JSON Schema 校验器；`@sinclair/typebox` 0.x 依赖 `Kind` 符号
  分发、对线上裸 Schema 抛 Unknown type，不可替换使用。

---

## @earendil-works/pi-durable · pi-ai · chord

- **许可**：见各包随附 LICENSE（helm 以 npm 依赖方式使用，非源码移植）。
