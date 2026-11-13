import { useEffect, useRef, useState } from 'react'
import { copyToClipboard } from './clipboard.js'
import { HelmIcon } from '../lib/icons.js'

/** 复制按钮：复制成功切换 check 图标 1.5s；失败显示警告提示防静默吞没。 */
export function CopyButton({ text, label, className = 'btn btn-ghost btn-sm' }: { text: string; label?: string; className?: string }) {
  const [copied, setCopied] = useState(false)
  const [failed, setFailed] = useState(false)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    return () => {
      if (timerRef.current !== null) clearTimeout(timerRef.current)
    }
  }, [])

  const onCopy = async (): Promise<void> => {
    const ok = await copyToClipboard(text)
    if (timerRef.current !== null) clearTimeout(timerRef.current)
    if (ok) {
      setCopied(true)
      setFailed(false)
      timerRef.current = setTimeout(() => setCopied(false), 1500)
    } else {
      setFailed(true)
      timerRef.current = setTimeout(() => setFailed(false), 2000)
    }
  }

  return (
    <button
      type="button"
      className={className}
      onClick={(e) => {
        e.stopPropagation()
        void onCopy()
      }}
      title={copied ? '已复制' : failed ? '复制失败（环境限制，请手动选择复制）' : '复制'}
      aria-label={copied ? '已复制' : failed ? '复制失败' : (label ?? '复制')}
    >
      <HelmIcon name={copied ? 'check' : failed ? 'alert-circle' : 'copy'} size={12} />
      {label !== undefined ? <span>{copied ? '已复制' : failed ? '复制失败' : label}</span> : null}
    </button>
  )
}
