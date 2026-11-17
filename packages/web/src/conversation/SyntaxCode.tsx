import { useEffect, useMemo, useState } from 'react'
import type { HLJSApi } from 'highlight.js'
import { useWebLocale } from '../i18n/use-web-locale.js'

/** highlight.js/lib/common 模块级缓存：成功后常驻（后续代码块挂载首帧即可同步高亮），失败不缓存可重试。 */
let commonHighlighter: HLJSApi | null = null
let commonHighlighterPromise: Promise<HLJSApi> | null = null

function loadCommonHighlighter(): Promise<HLJSApi> {
  if (commonHighlighter !== null) return Promise.resolve(commonHighlighter)
  commonHighlighterPromise ??= import('highlight.js/lib/common')
    .then(({ default: highlighter }) => {
      commonHighlighter = highlighter
      return highlighter
    })
    .catch((err: unknown) => {
      commonHighlighterPromise = null
      throw err
    })
  return commonHighlighterPromise
}

/** 高亮按需加载；保留完整源码，复制和原文展示使用同一份字符串。 */
export function SyntaxCode({ code, language }: { code: string; language: string }) {
  const [highlighter, setHighlighter] = useState<HLJSApi | null>(() => commonHighlighter)
  const [error, setError] = useState(false)
  const { t } = useWebLocale()
  // 仅负责模块加载：首次就绪前回退纯文本；失败随流式增量（code 变化）重试。
  useEffect(() => {
    if (highlighter !== null) return
    setError(false)
    if (language === '') return
    let active = true
    void loadCommonHighlighter()
      .then((loaded) => { if (active) setHighlighter(loaded) })
      .catch(() => { if (active) setError(true) })
    return () => { active = false }
  }, [highlighter, language, code])
  // 高亮 HTML 与当前 code 同帧同步求值：流式增量更新不会先提交一帧纯文本、再在
  // 异步回调里换回高亮 HTML（两帧彩色↔无色切换即代码块闪烁）。
  const html = useMemo(() => {
    if (highlighter === null || language === '' || !highlighter.getLanguage(language)) return null
    try {
      return highlighter.highlight(code, { language }).value
    } catch {
      return null
    }
  }, [highlighter, language, code])
  return <>
    {error && <span className="code-highlight-error">{t('conv.codeblock.highlightFailed')}</span>}
    <pre className="code-block-pre selectable">
      {html !== null
        ? <code dangerouslySetInnerHTML={{ __html: html }} />
        : <code>{code}</code>}
    </pre>
  </>
}
