/**
 * MarkdownView / CodeBlockView: SDK delegation components for the host's
 * standard Markdown capabilities.
 *
 * The host (@helm/web) injects the real implementation via
 * PluginClientHostContext.markdown (artifact links, markdown.codeBlock
 * extensions, streaming chunking, syntax highlighting); these components only
 * forward through the port, so plugin source `import { MarkdownView } from
 * '@helm/plugin-client'` gets the same rendering power as the host. A missing
 * port (outside the host Provider) throws explicitly — never silently
 * degrading to unstyled plain text.
 */
import type { ReactNode } from 'react'
import { usePluginClientHost } from './host-port.js'
import type { CodeBlockViewProps, MarkdownViewProps } from './host-port.js'

export type { MarkdownViewProps, CodeBlockViewProps }

export function MarkdownView(props: MarkdownViewProps): ReactNode {
  const { view: HostView } = usePluginClientHost().markdown
  return (
    <HostView
      text={props.text}
      conversationId={props.conversationId}
      streaming={props.streaming}
      workspaceBaseDir={props.workspaceBaseDir}
    />
  )
}

export function CodeBlockView(props: CodeBlockViewProps): ReactNode {
  const { codeBlock: HostCodeBlock } = usePluginClientHost().markdown
  return <HostCodeBlock code={props.code} language={props.language} />
}
