// src/network/index.ts

import { EventEmitter } from 'events';
import { setTimeout, clearTimeout } from 'timers';

interface WebSocketConfig {
  url: string;
  maxAttempts: number;
  baseReconnectMs: number;
  maxReconnectMs: number;
  jitterMs: number;
}

enum ConnectionState {
  CONNECTING = 'connecting',
  CONNECTED = 'connected',
  DISCONNECTING = 'disconnecting',
  DISCONNECTED = 'disconnected',
  RECONNECTING = 'reconnecting',
}

class WebSocketClient extends EventEmitter {
  private socket: WebSocket | null = null;
  private config: WebSocketConfig;
  private reconnectAttempts = 0;
  private reconnectTimeout: NodeJS.Timeout | null = null;
  private currentState: ConnectionState = ConnectionState.DISCONNECTED;

  constructor(config: WebSocketConfig) {
    super();
    this.config = config;
  }

  private setState(newState: ConnectionState) {
    this.currentState = newState;
    this.emit('stateChange', newState);
  }

  private connect() {
    if (this.currentState !== ConnectionState.DISCONNECTED) return;

    this.setState(ConnectionState.CONNECTING);
    this.socket = new WebSocket(this.config.url);

    this.socket.onopen = () => {
      this.setState(ConnectionState.CONNECTED);
      this.reconnectAttempts = 0;
    };

    this.socket.onclose = () => {
      this.setState(ConnectionState.DISCONNECTED);
      this.reconnect();
    };

    this.socket.onerror = (error) => {
      console.error('WebSocket error:', error);
      this.reconnect();
    };
  }

  private reconnect() {
    if (this.reconnectAttempts >= this.config.maxAttempts) {
      this.emit('failed');
      return;
    }

    const backoff = Math.min(
      this.config.baseReconnectMs * Math.pow(2, this.reconnectAttempts),
      this.config.maxReconnectMs
    );
    const jitter = Math.random() * this.config.jitterMs;

    this.reconnectTimeout = setTimeout(() => {
      this.reconnectAttempts++;
      this.setState(ConnectionState.RECONNECTING);
      this.connect();
    }, backoff + jitter);
  }

  public disconnect() {
    if (this.socket) {
      this.setState(ConnectionState.DISCONNECTING);
      this.socket.close();
      this.socket = null;
    }
  }

  public getCurrentState() {
    return this.currentState;
  }
}

export default WebSocketClient;