/**
 * Plain Markdown text rendering primitive shared by plugins (react-markdown +
 * GFM from the same instance as the host).
 * Exported by @helmx/plugin-client (e.g. the Markdown primitive of
 * builtin:json-render); it contains no host conversation-specific logic such
 * as artifact links — those live in the host MarkdownView.
 */
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { markdownUrlTransform } from './artifact-url.js'

export function MarkdownText({ text }: { text: string }): React.JSX.Element {
  return (
    <Markdown remarkPlugins={[remarkGfm]} urlTransform={markdownUrlTransform}>
      {text}
    </Markdown>
  )
}
