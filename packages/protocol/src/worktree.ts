/** 受管工作树清理：路径必须与节点一起定位，或使用宿主分配的稳定 ID。 */
export interface WorktreeCleanupRequest {
  worktreeId?: string
  conversationId?: number
  path?: string
  nodeId?: string
  deleteBranch?: boolean
  force?: boolean
}

export interface WorktreeCleanupResult {
  removed: boolean
  path: string
  branch: string
  nodeId: string
  branchDeleted: boolean
}
