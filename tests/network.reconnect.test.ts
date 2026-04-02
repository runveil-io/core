import { describe, it, expect, afterEach, vi, beforeEach } from 'vitest';
import { connect, createServer } from '../src/network/index.js';
import type { ConnectionState } from '../src/network/index.js';
import { WS_RECONNECT_MAX_MS, WS_RECONNECT_BASE_MS } from '../src/config/bootstrap.js';

describe('network reconnect details', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('state transitions: connecting -> connected -> disconnecting -> disconnected -> reconnecting', async () => {
    const states: ConnectionState[] = [];
    
    const server = createServer({ port: 0, onConnection() {} });
    const port = server.address().port;

    const connectPromise = connect({
      url: `ws://localhost:${port}`,
      onMessage() {}, onClose() {}, onError() {},
      reconnect: true, maxReconnectAttempts: 3,
      onStateChange(state) { states.push(state); },
    });

    vi.runOnlyPendingTimers();
    await vi.waitFor(() => { if (states.at(-1) !== 'connected') throw new Error('not yet connected'); });

    const conn = await connectPromise;
    expect(states.at(-1)).toBe('connected');

    server.close();
    conn.ws.terminate(); // Force unexpected drop
    
    await vi.waitFor(() => { if (!states.includes('reconnecting')) throw new Error('not yet reconnecting'); });
    expect(states.includes('reconnecting')).toBe(true);

    conn.close(); // intentionally close
    await vi.waitFor(() => { if (!states.includes('disconnected')) throw new Error('not disconnected'); });
    expect(states.at(-1)).toBe('disconnected');
    expect(states.includes('disconnecting')).toBe(true);
  });

  it('max reconnect attempts triggers failed state', async () => {
    const states: ConnectionState[] = [];
    let failedEmitted = false;
    
    const server = createServer({ port: 0, onConnection() {} });
    const port = server.address().port;

    const conn = await connect({
      url: `ws://localhost:${port}`,
      onMessage() {}, onClose() {}, onError() {},
      reconnect: true, maxReconnectAttempts: 2,
      onStateChange(state) { states.push(state); },
      onFailed() { failedEmitted = true; }
    });

    // Close server and drop conn
    server.close();
    conn.ws.terminate();

    await vi.waitFor(() => {
        vi.runAllTimers();
        if (!failedEmitted) throw new Error('not failed');
    });
    
    expect(states.includes('failed')).toBe(true);
    expect(failedEmitted).toBe(true);
  });

  it('jitter and backoff timing matches requirements', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0); // 0 jitter for predictable timing

    const states: ConnectionState[] = [];
    const server = createServer({ port: 0, onConnection() {} });
    const port = server.address().port;

    const conn = await connect({
      url: `ws://localhost:${port}`,
      onMessage() {}, onClose() {}, onError() {},
      reconnect: true, maxReconnectAttempts: 3,
      onStateChange(s) { states.push(s); }
    });

    server.close();
    conn.ws.terminate(); // kick off retry

    // Wait for the close event to process
    await Promise.resolve();
    
    // We are now 'reconnecting'. 
    expect(states.at(-1)).toBe('reconnecting');
    
    // Delay 1: 1000ms. If we advance by 999ms, we shouldn't be 'connecting'.
    vi.advanceTimersByTime(999);
    expect(states.at(-1)).toBe('reconnecting');
    
    // Advance 1ms more -> reaches 1000ms, timeout fires, becomes 'connecting'
    vi.advanceTimersByTime(1);
    await Promise.resolve(); // allow setTimeout and promise tick
    expect(states.at(-1)).toBe('connecting');

    // That connection instantly fails (server is down).
    // wait for error/close:
    await Promise.resolve();
    await vi.waitFor(() => { if (states.at(-1) !== 'reconnecting') throw new Error(); });

    // Delay 2: 2000ms
    vi.advanceTimersByTime(1999);
    expect(states.at(-1)).toBe('reconnecting');

    vi.advanceTimersByTime(1);
    await Promise.resolve(); 
    expect(states.at(-1)).toBe('connecting');

    // Wait for fail
    await vi.waitFor(() => { if (states.at(-1) !== 'reconnecting') throw new Error(); });

    // Delay 3: 4000ms
    vi.advanceTimersByTime(3999);
    expect(states.at(-1)).toBe('reconnecting');

    vi.advanceTimersByTime(1);
    await Promise.resolve(); 
    expect(states.at(-1)).toBe('connecting');
  });

});
