import WebSocket, { WebSocketServer } from 'ws';
import type { IncomingMessage } from 'node:http';
import type { WsMessage } from '../types.js';
import { createLogger } from '../logger.js';

const log = createLogger('network');
import {
  PING_INTERVAL_MS,
  PONG_TIMEOUT_MS,
  WS_RECONNECT_BASE_MS,
  WS_RECONNECT_MAX_MS,
  MAX_MESSAGE_SIZE,
} from '../config/bootstrap.js';

export interface Connection {
  ws: WebSocket;
  send(msg: WsMessage): void;
  close(code?: number, reason?: string): void;
  readonly readyState: 'connecting' | 'open' | 'closing' | 'closed';
}

export interface ConnectionOptions {
  url: string;
  onMessage: (msg: WsMessage) => void;
  onClose: (code: number, reason: string) => void;
  onError: (err: Error) => void;
  reconnect?: boolean;
  pingIntervalMs?: number;
}

const WS_STATE_MAP: Record<number, Connection['readyState']> = {
  [WebSocket.CONNECTING]: 'connecting',
  [WebSocket.OPEN]: 'open',
  [WebSocket.CLOSING]: 'closing',
  [WebSocket.CLOSED]: 'closed',
};

function wrapConnection(ws: WebSocket): Connection {
  return {
    ws,
    send(msg: WsMessage): void {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(msg));
      }
    },
    close(code: number = 1001, reason: string = 'going_away'): void {
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close(code, reason);
      }
    },
    get readyState(): Connection['readyState'] {
      return WS_STATE_MAP[ws.readyState] ?? 'closed';
    },
  };
}

export function connect(options: ConnectionOptions): Promise<Connection> {
  const { url, onMessage, onClose, onError, reconnect = true, pingIntervalMs = PING_INTERVAL_MS } = options;
  let pingInterval: ReturnType<typeof setInterval> | null = null;
  let pongTimeout: ReturnType<typeof setTimeout> | null = null;
  let reconnectAttempt = 0;
  let intentionallyClosed = false;
  let isFirstConnect = true;

  // Shared connection object — ws is swapped on reconnect
  const conn: Connection = {
    ws: null as unknown as WebSocket,
    send(msg: WsMessage): void {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify(msg));
      }
    },
    close(code: number = 1001, reason: string = 'going_away'): void {
      intentionallyClosed = true;
      cleanup();
      if (this.ws?.readyState === WebSocket.OPEN || this.ws?.readyState === WebSocket.CONNECTING) {
        this.ws.close(code, reason);
      }
    },
    get readyState(): Connection['readyState'] {
      return WS_STATE_MAP[this.ws?.readyState ?? WebSocket.CLOSED] ?? 'closed';
    },
  };

  function cleanup(): void {
    if (pingInterval) { clearInterval(pingInterval); pingInterval = null; }
    if (pongTimeout) { clearTimeout(pongTimeout); pongTimeout = null; }
  }

  function setupPing(ws: WebSocket): void {
    cleanup();
    pingInterval = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.ping();
        pongTimeout = setTimeout(() => {
          log.warn('pong_timeout', { url });
          ws.terminate();
        }, PONG_TIMEOUT_MS);
      }
    }, pingIntervalMs);

    ws.on('pong', () => {
      if (pongTimeout) { clearTimeout(pongTimeout); pongTimeout = null; }
    });
  }

  function doConnect(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(url, { maxPayload: MAX_MESSAGE_SIZE });
      conn.ws = ws;

      ws.on('open', () => {
        reconnectAttempt = 0;
        setupPing(ws);
        resolve();
      });

      ws.on('message', (data) => {
        try {
          const msg: WsMessage = JSON.parse(data.toString());
          onMessage(msg);
        } catch {
          log.error('invalid_ws_message');
        }
      });

      ws.on('close', (code, reason) => {
        cleanup();
        onClose(code, reason.toString());
        if (reconnect && !intentionallyClosed) {
          const delay = Math.min(
            WS_RECONNECT_BASE_MS * Math.pow(2, reconnectAttempt),
            WS_RECONNECT_MAX_MS,
          );
          reconnectAttempt++;
          setTimeout(() => {
            doConnect().catch(() => { /* reconnect failures handled by onClose */ });
          }, delay);
        }
      });

      ws.on('error', (err) => {
        onError(err);
        if (isFirstConnect && ws.readyState !== WebSocket.OPEN) {
          reject(err);
        }
      });
    });
  }

  return doConnect().then(() => {
    isFirstConnect = false;
    return conn;
  });
}

export interface ServerHandle {
  close(): void;
  /** Close all connected clients with a close code and wait for them to finish (with timeout). */
  closeAll(code?: number, reason?: string, timeoutMs?: number): Promise<void>;
  readonly port: number;
  address(): { port: number };
  /** Current number of connected clients. */
  readonly connectionCount: number;
}

export function createServer(options: {
  port: number;
  onConnection: (conn: Connection, req: IncomingMessage) => void;
}): ServerHandle {
  const wss = new WebSocketServer({
    port: options.port,
    maxPayload: MAX_MESSAGE_SIZE,
  });

  // Track all connected sockets for bulk close
  const connections = new Set<WebSocket>();

  wss.on('connection', (ws, req) => {
    connections.add(ws);
    ws.on('close', () => connections.delete(ws));
    const conn = wrapConnection(ws);
    options.onConnection(conn, req);
  });

  return {
    close() { wss.close(); },

    closeAll(code: number = 1001, reason: string = 'going_away', timeoutMs: number = 5000): Promise<void> {
      // Snapshot to avoid mutation during iteration
      const snapshot = Array.from(connections);
      if (snapshot.length === 0) {
        wss.close();
        return Promise.resolve();
      }

      return new Promise<void>((resolve) => {
        let remaining = snapshot.length;
        const timer = setTimeout(() => {
          // Force-terminate any that haven't closed yet
          for (const ws of snapshot) {
            if (ws.readyState !== WebSocket.CLOSED) {
              ws.terminate();
            }
          }
          connections.clear();
          wss.close();
          resolve();
        }, timeoutMs);
        timer.unref();

        for (const ws of snapshot) {
          if (ws.readyState === WebSocket.CLOSED) {
            remaining--;
            if (remaining === 0) {
              clearTimeout(timer);
              connections.clear();
              wss.close();
              resolve();
            }
            continue;
          }

          ws.once('close', () => {
            remaining--;
            if (remaining === 0) {
              clearTimeout(timer);
              connections.clear();
              wss.close();
              resolve();
            }
          });

          if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
            ws.close(code, reason);
          }
        }
      });
    },

    get port() { return (wss.address() as { port: number }).port; },
    address() { return wss.address() as { port: number }; },
    get connectionCount() { return connections.size; },
  };
}
