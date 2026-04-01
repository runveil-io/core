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

export type ConnectionReadyState = 'connecting' | 'connected' | 'disconnecting' | 'disconnected' | 'reconnecting';

export interface Connection {
  ws: WebSocket;
  send(msg: WsMessage): void;
  close(): void;
  readonly readyState: ConnectionReadyState;
  onStateChange?: (state: ConnectionReadyState) => void;
  readonly reconnectAttempts: number;
  readonly maxReconnectAttempts: number;
}

export interface ConnectionOptions {
  url: string;
  onMessage: (msg: WsMessage) => void;
  onClose: (code: number, reason: string) => void;
  onError: (err: Error) => void;
  onStateChange?: (state: ConnectionReadyState) => void;
  reconnect?: boolean;
  pingIntervalMs?: number;
  maxReconnectAttempts?: number;
}

const WS_STATE_MAP: Record<number, ConnectionReadyState> = {
  [WebSocket.CONNECTING]: 'connecting',
  [WebSocket.OPEN]: 'connected',
  [WebSocket.CLOSING]: 'disconnecting',
  [WebSocket.CLOSED]: 'disconnected',
};

function jitter(): number {
  return Math.random() * 1000;
}

function reconnectDelay(attempt: number): number {
  const baseDelay = Math.min(
    WS_RECONNECT_BASE_MS * Math.pow(2, attempt),
    WS_RECONNECT_MAX_MS,
  );
  return Math.floor(baseDelay + jitter());
}

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
    get readyState(): ConnectionReadyState {
      return WS_STATE_MAP[ws.readyState] ?? 'disconnected';
    },
    reconnectAttempts: 0,
    maxReconnectAttempts: Infinity,
  };
}

export function connect(options: ConnectionOptions): Promise<Connection> {
  const {
    url,
    onMessage,
    onClose,
    onError,
    onStateChange,
    reconnect = true,
    pingIntervalMs = PING_INTERVAL_MS,
    maxReconnectAttempts = 10,
  } = options;

  let pingInterval: ReturnType<typeof setInterval> | null = null;
  let pongTimeout: ReturnType<typeof setTimeout> | null = null;
  let reconnectAttempt = 0;
  let intentionallyClosed = false;
  let isFirstConnect = true;
  let currentState: ConnectionReadyState = 'connecting';

  const setState = (newState: ConnectionReadyState) => {
    currentState = newState;
    conn.readyState = newState;
    onStateChange?.(newState);
    log.debug('ws_state_change', { state: newState, attempt: reconnectAttempt });
  };

  const conn: Connection = {
    ws: null as unknown as WebSocket,
    send(msg: WsMessage): void {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify(msg));
      }
    },
    close(): void {
      intentionallyClosed = true;
      setState('disconnecting');
      cleanup();
      this.ws?.close();
      setState('disconnected');
    },
    get readyState(): ConnectionReadyState {
      return currentState;
    },
    get reconnectAttempts() { return reconnectAttempt; },
    get maxReconnectAttempts() { return maxReconnectAttempts; },
    onStateChange,
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
    setState(isFirstConnect ? 'connecting' : 'reconnecting');
    return new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(url, { maxPayload: MAX_MESSAGE_SIZE });
      conn.ws = ws;

      ws.on('open', () => {
        reconnectAttempt = 0;
        setupPing(ws);
        setState('connected');
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
        setState('disconnected');
        onClose(code, reason.toString());

        if (reconnect && !intentionallyClosed) {
          if (reconnectAttempt >= maxReconnectAttempts) {
            log.error('reconnect_exhausted', { url, attempts: reconnectAttempt });
            onError(new Error('Reconnect exhausted after ' + maxReconnectAttempts + ' attempts'));
            return;
          }
          const delay = reconnectDelay(reconnectAttempt);
          reconnectAttempt++;
          log.debug('reconnect_scheduled', { attempt: reconnectAttempt, delayMs: delay, maxAttempts: maxReconnectAttempts });
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
