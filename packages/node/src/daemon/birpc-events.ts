/**
 * birpc events adapt (ws socket 'message'):on register parse JSON + frame validate
 * wrap function,off must excerpt except the same wrap reference - - if directly socket.off(birpc original
 * callback), excerpt do not actual register wrap,$close after listener leftover (reference inconsistent).
 */
export interface SocketBirpcEvents {
  on(callback: (data: unknown) => void): void;
  off(callback: (data: unknown) => void): void;
}

/** most small socket side (ws.WebSocket satisfy; test available EventEmitter false body). */
export interface MessageListenerSocket {
  on(event: 'message', listener: (raw: unknown, isBinary: boolean) => void): unknown;
  off(event: 'message', listener: (raw: unknown, isBinary: boolean) => void): unknown;
}

export function createSocketBirpcEvents(
  socket: MessageListenerSocket,
  /** illegal frame call back (such as terminate connect);message is diagnose description. */
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
          onInvalidFrame(`receives illegal JSON frame length=${text.length}`);
          return;
        }
        if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) callback(parsed);
        else onInvalidFrame('receives illegal RPC frame');
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
