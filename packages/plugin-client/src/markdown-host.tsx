/**
 * MarkdownView / CodeBlockView：宿主标准 Markdown 能力的 SDK 委托组件。
 *
 * 宿主（@helm/web）经 PluginClientHostContext.markdown 注入真实实现
 * （产物链接、markdown.codeBlock 扩展、流式分块、语法高亮）；本组件只做
 * 端口转发，保证插件源码 `import { MarkdownView } from '@helm/plugin-client'`
 * 与宿主同一渲染能力。端口缺失（未在宿主 Provider 内）显式抛错，绝不静默
 * 降级为无样式纯文本。
 */
import type { ReactNode } from 'react'
import { usePluginClientHost } from './host-port.js'
import type { CodeBlockViewProps, MarkdownViewProps } from './host-port.js'

export type { MarkdownViewProps, CodeBlockViewProps }

export function MarkdownView(props: MarkdownViewProps): ReactNode {
  const { view: HostView } = usePluginClientHost().markdown
  return <HostView text={props.text} conversationId={props.conversationId} streaming={props.streaming} />
}

export function CodeBlockView(props: CodeBlockViewProps): ReactNode {
  const { codeBlock: HostCodeBlock } = usePluginClientHost().markdown
  return <HostCodeBlock code={props.code} language={props.language} />
}
