/**
 * Timeline clipboard utility (plain .ts, Fast Refresh friendly).
 */

export async function copyToClipboard(text: string): Promise<boolean> {
  // 1. Prefer the modern Clipboard API (only effective in secure contexts such as HTTPS or localhost)
  if (
    typeof navigator !== 'undefined' &&
    navigator.clipboard !== undefined &&
    typeof navigator.clipboard.writeText === 'function'
  ) {
    try {
      await navigator.clipboard.writeText(text)
      return true
    } catch {
      // The modern API may throw on missing focus, hidden documents or denied
      // permission — fall through to the execCommand fallback
    }
  }

  // 2. Generic fallback: dynamically create an invisible textarea + document.execCommand('copy')
  // Compatible with HTTP (LAN IP / remote dev machine direct access), legacy
  // browsers and non-secure contexts
  if (typeof document !== 'undefined') {
    try {
      const textarea = document.createElement('textarea')
      textarea.value = text
      // Avoid page scrolling or layout reflow
      textarea.style.position = 'fixed'
      textarea.style.top = '0'
      textarea.style.left = '0'
      textarea.style.width = '2em'
      textarea.style.height = '2em'
      textarea.style.padding = '0'
      textarea.style.border = 'none'
      textarea.style.outline = 'none'
      textarea.style.boxShadow = 'none'
      textarea.style.background = 'transparent'
      textarea.style.opacity = '0'
      textarea.setAttribute('readonly', '')
      document.body.appendChild(textarea)
      textarea.focus()
      textarea.select()
      textarea.setSelectionRange(0, textarea.value.length)
      const success = document.execCommand('copy')
      document.body.removeChild(textarea)
      if (success) return true
    } catch {
      // execCommand fallback failed
    }
  }

  return false
}
