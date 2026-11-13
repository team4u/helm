# todo-demo：全栈微应用种子样本

最小可发布全栈微应用（TODO 列表）：`ctx.doc` 持久条目 + 四个双 Schema 动作（`add_todo` / `set_done` / `update_todo` / `remove_todo`）+ `ctx.ui.screen` 主视图，前端仅用 `@helm/plugin-client` 宿主原语。本目录是可复用样板——与 `helm plugins init <name> --template app` 生成的脚手架同形（模板是其两动作精简版）。

## 用法

```bash
# 就地体验 / 验证（不发布也能跑完整预检）
helm apps validate /root/code/helm/apps/todo-demo

# 发布到应用中心（受管安装并启用）
helm apps publish /root/code/helm/apps/todo-demo --category productivity

# 从脚手架另起一个自己的应用
helm plugins init my-app --template app
```

## 约定速查

- `index.ts` 与 `plugin.json` 均显式声明 `clientRoot: './client'`；动作必须同时声明 `inputSchema` 与 `outputSchema`（单点 Schema 契约）；
- 写操作后 `await doc.flush()`；`ctx.doc` 以 `{ public: true }` 声明供前端 `usePluginDoc` 实时订阅；
- 默认不注册 `sidebarItem`（避免左栏膨胀），应用经应用中心打开；需要侧栏直达可参考 app 模板的 `open-main` 写法；
- 样式仅做布局微调，颜色一律走宿主 CSS 变量（`--bg-elevated` / `--fg-muted` 等）；无 Emoji。
