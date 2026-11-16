import { useEffect, useRef, useState } from 'react'
import { copyToClipboard } from './clipboard.js'
import { HelmIcon } from './icons.js'
import { usePluginTranslator } from './i18n.js'
import { uiCopy } from './ui-copy.js'

/**
 * Copy button: switches to a check icon for 1.5s on success; shows a warning
 * hint on failure so errors are never silently swallowed. Defaults follow
 * the shared UI locale; a caller-provided label overrides the idle text.
 */
export function CopyButton({ text, label, className = 'btn btn-ghost btn-sm' }: { text: string; label?: string; className?: string }) {
  const t = usePluginTranslator()
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
      title={copied ? t(uiCopy.copied) : failed ? t(uiCopy.copyFailureHint) : t(uiCopy.copy)}
      aria-label={copied ? t(uiCopy.copied) : failed ? t(uiCopy.copyFailed) : (label ?? t(uiCopy.copy))}
    >
      <HelmIcon name={copied ? 'check' : failed ? 'alert-circle' : 'copy'} size={12} />
      {label !== undefined ? <span>{copied ? t(uiCopy.copied) : failed ? t(uiCopy.copyFailed) : label}</span> : null}
    </button>
  )
}
