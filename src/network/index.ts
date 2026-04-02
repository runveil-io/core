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

export type ConnectionState = 'connecting' | 'connected' | 'disconnecting' | 'disconnected' | 'reconnecting' | 'failed';

export interface Connection {
  ws: WebSocket;
  send(msg: WsMessage): void;
  close(): void;
  readonly readyState: ConnectionState;
}

export interface ConnectionOptions {
  url: string;
  onMessage: (msg: WsMessage) => void;
  onClose: (code: number, reason: string) => void;
  onError: (err: Error) => void;
  reconnect?: boolean;
  pingIntervalMs?: number;
  maxReconnectAttempts?: number;
  onStateChange?: (state: ConnectionState) => void;
  onFailed?: () => void;
}

const WS_STATE_MAP: Record<number, ConnectionState> = {
  [WebSocket.CONNECTING]: 'connecting',
  [WebSocket.OPEN]: 'connected',
  [WebSocket.CLOSING]: 'disconnecting',
  [WebSocket.CLOSED]: 'disconnected',
};

function wrapConnection(ws: WebSocket): Connection {
  return {
    ws,
    send(msg: WsMessage): void {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(msg));
      }
    },
    close(): void {
      ws.close();
    },
    get readyState(): ConnectionState {
      return WS_STATE_MAP[ws.readyState] ?? 'disconnected';
    },
  };
}

export function connect(options: ConnectionOptions): Promise<Connection> {
  const {
    url,
    onMessage,
    onClose,
    onError,
    reconnect = true,
    pingIntervalMs = PING_INTERVAL_MS,
    maxReconnectAttempts = 10,
    onStateChange,
    onFailed,
  } = options;
  let pingInterval: ReturnType<typeof setInterval> | null = null;
  let pongTimeout: ReturnType<typeof setTimeout> | null = null;
  let reconnectTimeout: ReturnType<typeof setTimeout> | null = null;
  let reconnectAttempt = 0;
  let intentionallyClosed = false;
  let isFirstConnect = true;

  let currentState: ConnectionState = 'disconnected';
  function setState(state: ConnectionState) {
    if (currentState !== state) {
      currentState = state;
      onStateChange?.(state);
    }
  }

  // Shared connection object — ws is swapped on reconnect
  const conn: Connection = {
    ws: null as unknown as WebSocket,
    send(msg: WsMessage): void {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify(msg));
      }
    },
    close(): void {
      intentionallyClosed = true;
      cleanup();
      setState('disconnecting');
      this.ws?.close();
    },
    get readyState(): ConnectionState {
      return currentState;
    },
  };

  function cleanup(): void {
    if (pingInterval) { clearInterval(pingInterval); pingInterval = null; }
    if (pongTimeout) { clearTimeout(pongTimeout); pongTimeout = null; }
    if (reconnectTimeout) { clearTimeout(reconnectTimeout); reconnectTimeout = null; }
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
      setState(reconnectAttempt === 0 ? 'connecting' : 'reconnecting');
      const ws = new WebSocket(url, { maxPayload: MAX_MESSAGE_SIZE });
      conn.ws = ws;

      ws.on('open', () => {
        reconnectAttempt = 0;
        setState('connected');
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
        
        if (intentionallyClosed) {
          setState('disconnected');
          return;
        }

        if (reconnect) {
          if (reconnectAttempt >= maxReconnectAttempts) {
             setState('failed');
             onFailed?.();
             return;
          }
          setState('reconnecting');
          const delay = Math.min(
            WS_RECONNECT_BASE_MS * Math.pow(2, reconnectAttempt),
            WS_RECONNECT_MAX_MS,
          );
          const jitter = Math.random() * 1000;
          reconnectAttempt++;
          if (reconnectTimeout) clearTimeout(reconnectTimeout);
          reconnectTimeout = setTimeout(() => {
            doConnect().catch(() => { /* handled by onClose/error */ });
          }, delay + jitter);
        } else {
          setState('disconnected');
        }
      });

      ws.on('error', (err) => {
        onError(err);
        if (ws.readyState !== WebSocket.OPEN) {
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

export function createServer(options: {
  port: number;
  onConnection: (conn: Connection, req: IncomingMessage) => void;
}): { close(): void; port: number; address: () => { port: number } } {
  const wss = new WebSocketServer({
    port: options.port,
    maxPayload: MAX_MESSAGE_SIZE,
  });

  wss.on('connection', (ws, req) => {
    const conn = wrapConnection(ws);
    options.onConnection(conn, req);
  });

  return {
    close() { wss.close(); },
    get port() { return (wss.address() as { port: number }).port; },
    address() { return wss.address() as { port: number }; },
  };
}
