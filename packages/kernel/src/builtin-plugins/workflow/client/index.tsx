/**
 * builtin:workflow 前端组件占位模块。
 *
 * 完整实现（运行卡、工作台面板）由并行前端子代理在 packages/web 侧统一
 * 开发；本模块保证内核测试（client 模块编译边界校验）可通过：三个具名
 * 导出组件仅做最小数据渲染，不依赖宿主运行时能力。
 */
import type { ToolViewProps, WorkbenchPanelProps } from '@helm/protocol'

export function SubagentToolView(_props: ToolViewProps): null {
  return null
}

export function WorkflowToolView(_props: ToolViewProps): null {
  return null
}

export function WorkflowWorkbenchPanel(_props: WorkbenchPanelProps): null {
  return null
}
