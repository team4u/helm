export function SkillViewerModal({
  onClose,
}: {
  initialSkillId?: string
  onClose: () => void
}) {
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} />
    </div>
  )
}
