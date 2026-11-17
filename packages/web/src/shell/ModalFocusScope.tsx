/**
 * Modal focus scope:
 * Radix UI Dialogs already ship WAI-ARIA FocusTrap, Esc handling and
 * DismissableLayer, so ModalFocusScope stays a lightweight coordination stub to
 * avoid fighting Radix's native focus management and keyboard events.
 */
export function ModalFocusScope({ active: _active, onClose: _onClose }: { active: boolean; onClose(): void }) {
  return null
}
