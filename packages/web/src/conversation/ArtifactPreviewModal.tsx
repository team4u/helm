export interface ArtifactPreviewModalProps {
  artifactId: string
  conversationId?: number
  onClose: () => void
}

export function ArtifactPreviewModal({ artifactId, onClose }: ArtifactPreviewModalProps) {
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <span className="modal-title">产物预览 #{artifactId}</span>
        </div>
      </div>
    </div>
  )
}
