/**
 * birpc events 适配（ws socket 'message'）：on 注册「解析 JSON + 帧校验」
 * 包装函数，off 必须摘除同一包装引用——若直接 socket.off(birpc 原始
 * callback)，摘不掉实际注册的包装，$close 后监听器残留（引用不一致）。
 */
export interface SocketBirpcEvents {
  on(callback: (data: unknown) => void): void;
  off(callback: (data: unknown) => void): void;
}

/** 最小 socket 面（ws.WebSocket 满足；测试可用 EventEmitter 假体）。 */
export interface MessageListenerSocket {
  on(event: 'message', listener: (raw: unknown, isBinary: boolean) => void): unknown;
  off(event: 'message', listener: (raw: unknown, isBinary: boolean) => void): unknown;
}

export function createSocketBirpcEvents(
  socket: MessageListenerSocket,
  /** 非法帧回调（如终止连接）；message 为诊断描述。 */
  onInvalidFrame: (message: string) => void,
): SocketBirpcEvents {
  const wrappers = new Map<(data: unknown) => void, (raw: unknown, isBinary: boolean) => void>();
  return {
    on(callback) {
      const wrapper = (raw: unknown): void => {
        const text = typeof raw === 'string' ? String(raw) : Buffer.from(raw as ArrayBuffer).toString('utf8');
        let parsed: unknown;
        try {
          parsed = JSON.parse(text);
        } catch {
          onInvalidFrame(`收到非法 JSON 帧长度=${text.length}`);
          return;
        }
        if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) callback(parsed);
        else onInvalidFrame('收到非法 RPC 帧');
      };
      wrappers.set(callback, wrapper);
      socket.on('message', wrapper);
    },
    off(callback) {
      const wrapper = wrappers.get(callback);
      if (wrapper === undefined) return;
      wrappers.delete(callback);
      socket.off('message', wrapper);
    },
  };
}
