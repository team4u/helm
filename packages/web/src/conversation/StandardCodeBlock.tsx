/**
 * 宿主普通代码块（语言标签 + 复制 + 语法高亮）：
 * markdown.codeBlock 扩展无命中（含插件停用）时的回退形态。
 */
import type { ReactNode } from 'react'
import { SyntaxCode } from './SyntaxCode.js'
import { CopyButton } from './CopyButton.js'

export function StandardCodeBlock({ language, code }: { language: string; code: string }): ReactNode {
  return (
    <div className="code-block-wrap">
      <div className="code-block-header">
        <span>{language === '' ? 'text' : language}</span>
        <CopyButton text={code} />
      </div>
      <SyntaxCode code={code} language={language} />
    </div>
  )
}
