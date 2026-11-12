/**
 * Hub 侧前台 TCP 端口转发契约（POST /api/nodes/:id/forward 与
 * /api/nodes/forward/* 的共享请求/响应类型；`helm nodes forward*` CLI 同权）。
 *
 * 生命周期（前台租约）：
 * - 监听器只在显式命令期间存在：创建后未在有限期限内绑定监控事件流
 *   （持有者）即自动停止；绑定后最后一个持有者断开时停止；显式
 *   DELETE / 宿主 close 同样停止——绝不残留监听器；
 * - 只读 list/get 不是持有者；持有/释放经 events 事件流隐式完成。
 */

/** POST /api/nodes/:id/forward 请求体。 */
export interface NodeForwardInput {
  /** Hub 侧监听地址（如 127.0.0.1 / 0.0.0.0；严格校验）。 */
  listenHost: string
  /** Hub 侧监听端口（1..65535；0 不可用——显式端口才能转发）。 */
  listenPort: number
  /** 目标主机（节点视角；省略默认 127.0.0.1）。 */
  targetHost?: string
  /** 目标端口（1..65535）。 */
  targetPort: number
}

/** 转发会话快照（GET /api/nodes/forward 与 /api/nodes/forward/:id）。 */
export interface NodeForwardSession {
  forwardId: string
  nodeId: string
  listenHost: string
  listenPort: number
  targetHost: string
  targetPort: number
  activeConnections: number
  totalConnections: number
  lastError?: string
}

/** GET /api/nodes/forward/:id/events 的 NDJSON 事件帧。 */
export type NodeForwardEvent =
  | { type: 'started'; listenHost: string; listenPort: number }
  | { type: 'connection'; count: number }
  | { type: 'error'; message: string }
  /** 终态帧：stop 先发本帧再关停（监控流据此正常结束，不悬挂）。 */
  | { type: 'stopped' }
