/**
 * Adapter connecting `birpc` events to a WebSocket `'message'` stream: parses incoming JSON frames,
 * rejects non-objects via `onInvalidFrame`, and keeps wrapper references so `off()` cleanly removes
 * listeners on `$close`.
 */
export interface SocketBirpcEvents {
  on(callback: (data: unknown) => void): void;
  off(callback: (data: unknown) => void): void;
}

/** Minimal socket surface satisfied by `ws.WebSocket` and test EventEmitter fakes. */
export interface MessageListenerSocket {
  on(event: 'message', listener: (raw: unknown, isBinary: boolean) => void): unknown;
  off(event: 'message', listener: (raw: unknown, isBinary: boolean) => void): unknown;
}

export function createSocketBirpcEvents(
  socket: MessageListenerSocket,
  /** Called on malformed JSON or non-object RPC frames so the caller can retire the connection. */
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
          onInvalidFrame(`received invalid JSON frame (length=${text.length})`);
          return;
        }
        if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) callback(parsed);
        else onInvalidFrame('received invalid RPC frame');
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
