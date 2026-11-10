/**
 * 插件共享的纯 Markdown 文本渲染原语（react-markdown + GFM 宿主同一实例）。
 * 供 @helm/plugin-client 导出（如 builtin:json-render 的 Markdown 原语），
 * 不含 artifact 链接等宿主会话特化逻辑——那些在宿主 MarkdownView 中。
 */
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { markdownUrlTransform } from '../conversation/artifact-link.js'

export function MarkdownText({ text }: { text: string }): React.JSX.Element {
  return (
    <Markdown remarkPlugins={[remarkGfm]} urlTransform={markdownUrlTransform}>
      {text}
    </Markdown>
  )
}
