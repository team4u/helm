/**
 * 时间线剪贴板工具（纯 .ts，Fast Refresh 友好）。
 */

export async function copyToClipboard(text: string): Promise<boolean> {
  // 1. 优先尝试现代 Clipboard API（仅在 HTTPS 或 localhost 等安全上下文生效）
  if (
    typeof navigator !== 'undefined' &&
    navigator.clipboard !== undefined &&
    typeof navigator.clipboard.writeText === 'function'
  ) {
    try {
      await navigator.clipboard.writeText(text)
      return true
    } catch {
      // 现代 API 可能因焦点缺失、文档非可见或用户权限拒绝而抛错，继续尝试 execCommand 降级
    }
  }

  // 2. 通用降级方案：动态创建不可见 textarea + document.execCommand('copy')
  // 兼容 HTTP（局域网 IP / 远程开发机直连）、旧版浏览器与非 Secure Context
  if (typeof document !== 'undefined') {
    try {
      const textarea = document.createElement('textarea')
      textarea.value = text
      // 避免引起页面滚动或触发布局回流
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
      // execCommand 降级失败
    }
  }

  return false
}
