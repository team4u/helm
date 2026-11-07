import { useEffect, useState } from 'react'

/** 高亮按需加载；保留完整源码，复制和原文展示使用同一份字符串。 */
export function SyntaxCode({ code, language }: { code: string; language: string }) {
  const [highlighted, setHighlighted] = useState<{ code: string; html: string } | null>(null)
  const [error, setError] = useState(false)
  useEffect(() => {
    let active = true
    setError(false)
    if (!language) return
    void import('highlight.js/lib/common').then(({ default: highlighter }) => {
      if (active && highlighter.getLanguage(language)) setHighlighted({ code, html: highlighter.highlight(code, { language }).value })
    }).catch(() => { if (active) setError(true) })
    return () => { active = false }
  }, [code, language])
  return <>
    {error && <span className="code-highlight-error">语法高亮加载失败，以下显示完整源码。</span>}
    <pre className="code-block-pre selectable">
      {highlighted?.code === code
        ? <code dangerouslySetInnerHTML={{ __html: highlighted.html }} />
        : <code>{code}</code>}
    </pre>
  </>
}
