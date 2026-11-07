import { useEffect } from 'react'

const FOCUSABLE = 'button:not(:disabled),a[href],input:not(:disabled),textarea:not(:disabled),select:not(:disabled),[tabindex="0"]'

/** 模态打开时圈定键盘焦点；关闭后归还触发按钮。原生控件不需要额外键盘协议。 */
export function ModalFocusScope({ active, onClose }: { active: boolean; onClose(): void }) {
  useEffect(() => {
    if (!active) return
    const previous = document.activeElement as HTMLElement | null
    const frame = requestAnimationFrame(() => {
      const dialog = [...document.querySelectorAll<HTMLElement>('.modal')].at(-1)
      dialog?.querySelector<HTMLElement>(FOCUSABLE)?.focus()
    })
    const keydown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return
      if (event.key === 'Escape') { event.preventDefault(); onClose(); return }
      if (event.key !== 'Tab') return
      const dialog = [...document.querySelectorAll<HTMLElement>('.modal')].at(-1)
      if (!dialog) return
      const fields = [...dialog.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((field) => field.getClientRects().length > 0)
      const first = fields[0], last = fields.at(-1)
      if (!first || !last) return
      if (event.shiftKey && (document.activeElement === first || !dialog.contains(document.activeElement))) { event.preventDefault(); last.focus() }
      else if (!event.shiftKey && (document.activeElement === last || !dialog.contains(document.activeElement))) { event.preventDefault(); first.focus() }
    }
    window.addEventListener('keydown', keydown)
    return () => { cancelAnimationFrame(frame); window.removeEventListener('keydown', keydown); if (previous?.isConnected) previous.focus() }
  }, [active, onClose])
  return null
}
