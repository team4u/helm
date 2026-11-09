/**
 * 模态焦点管辖范围：
 * 由于 Radix UI Dialog 原生自带 WAI-ARIA FocusTrap、Esc 监听与 DismissableLayer，
 * 简化 ModalFocusScope 为轻量协同组件，避免与 Radix 原生焦点管理与键盘事件产生冲突。
 */
export function ModalFocusScope({ active: _active, onClose: _onClose }: { active: boolean; onClose(): void }) {
  return null
}

