import { useEffect, useRef, useState } from 'react'
import { copyToClipboard } from './clipboard.js'
import { HelmIcon } from '../lib/icons.js'

/** 复制按钮：复制成功切换 check 图标 1.5s。 */
export function CopyButton({ text, label }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    return () => {
      if (timerRef.current !== null) clearTimeout(timerRef.current)
    }
  }, [])

  const onCopy = async (): Promise<void> => {
    if (await copyToClipboard(text)) {
      setCopied(true)
      if (timerRef.current !== null) clearTimeout(timerRef.current)
      timerRef.current = setTimeout(() => setCopied(false), 1500)
    }
  }

  return (
    <button
      type="button"
      className="btn btn-ghost btn-sm"
      onClick={() => void onCopy()}
      title={copied ? '已复制' : '复制'}
    >
      <HelmIcon name={copied ? 'check' : 'copy'} size={12} />
      {label !== undefined ? <span>{copied ? '已复制' : label}</span> : null}
    </button>
  )
}
