import { useEffect, useRef, useState } from 'react'
import { copyToClipboard } from './clipboard.js'
import { HelmIcon } from './icons.js'

/**
 * Copy button: switches to a check icon for 1.5s on success; shows a warning
 * hint on failure so errors are never silently swallowed. The fixed texts
 * below are SDK defaults in English; pass the label prop to override them for
 * host-side localization.
 */
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
      title={copied ? 'Copied' : failed ? 'Copy failed (environment restriction; select and copy manually)' : 'Copy'}
      aria-label={copied ? 'Copied' : failed ? 'Copy failed' : (label ?? 'Copy')}
    >
      <HelmIcon name={copied ? 'check' : failed ? 'alert-circle' : 'copy'} size={12} />
      {label !== undefined ? <span>{copied ? 'Copied' : failed ? 'Copy failed' : label}</span> : null}
    </button>
  )
}
