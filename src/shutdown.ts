/**
 * ShutdownManager — Orchestrates graceful shutdown for all Veil roles.
 *
 * Design principles:
 * - Idempotent: register() and shutdown() can be called multiple times safely.
 * - Per-component timeouts: each cleanup gets its own deadline.
 * - Global hard timeout: 35s max before process.exit(1). Operators should
 *   configure systemd/Docker stop timeout ≥ 40s to allow clean exit.
 * - Second SIGINT/SIGTERM force-kills immediately.
 * - No new dependencies — pure Node.js primitives.
 */

import { createLogger } from './logger.js';

const log = createLogger('shutdown');

export interface CleanupEntry {
  name: string;
  fn: () => Promise<void>;
  timeoutMs: number;
}

export class ShutdownManager {
  private cleanups: CleanupEntry[] = [];
  private _isShuttingDown = false;
  private _hasCompleted = false;
  private signalCount = 0;
  private hardTimer: ReturnType<typeof setTimeout> | null = null;
  private globalTimeoutMs: number;
  private boundSignalHandler: (() => void) | null = null;
  private listenersAttached = false;

  /** Callback for CLI UX: called with status messages during shutdown. */
  public onStatus: ((message: string) => void) | null = null;

  constructor(globalTimeoutMs: number = 35_000) {
    this.globalTimeoutMs = globalTimeoutMs;
  }

  get isShuttingDown(): boolean {
    return this._isShuttingDown;
  }

  get hasCompleted(): boolean {
    return this._hasCompleted;
  }

  /**
   * Register a cleanup function. Cleanups run in registration order.
   * Each gets its own timeoutMs — if it exceeds that, we log and move on.
   *
   * Idempotent: registering the same name twice replaces the previous entry.
   */
  register(name: string, fn: () => Promise<void>, timeoutMs: number = 10_000): void {
    const existing = this.cleanups.findIndex((c) => c.name === name);
    if (existing !== -1) {
      this.cleanups[existing] = { name, fn, timeoutMs };
    } else {
      this.cleanups.push({ name, fn, timeoutMs });
    }
  }

  /**
   * Attach process signal listeners (SIGINT, SIGTERM, unhandledRejection, uncaughtException).
   * Call this only from CLI — tests should call shutdown() directly.
   */
  attachSignalListeners(): void {
    if (this.listenersAttached) return;
    this.listenersAttached = true;

    this.boundSignalHandler = () => {
      this.signalCount++;
      if (this.signalCount === 1) {
        this.shutdown().then((code) => {
          process.exit(code);
        });
      } else {
        // Second signal: force exit
        this.onStatus?.('Shutdown already in progress, force exiting…');
        log.warn('force_exit', { signals: this.signalCount });
        process.exit(1);
      }
    };

    process.on('SIGINT', this.boundSignalHandler);
    process.on('SIGTERM', this.boundSignalHandler);

    // Safety nets — log and trigger shutdown on unhandled errors
    process.on('unhandledRejection', (reason) => {
      log.error('unhandled_rejection', { error: String(reason) });
      if (!this._isShuttingDown) {
        this.shutdown().then((code) => process.exit(code));
      }
    });

    process.on('uncaughtException', (err) => {
      log.error('uncaught_exception', { error: err.message, stack: err.stack });
      if (!this._isShuttingDown) {
        this.shutdown().then(() => process.exit(1));
      }
    });
  }

  /**
   * Detach signal listeners. Used in tests to prevent cross-test interference.
   */
  detachSignalListeners(): void {
    if (this.boundSignalHandler) {
      process.removeListener('SIGINT', this.boundSignalHandler);
      process.removeListener('SIGTERM', this.boundSignalHandler);
      this.boundSignalHandler = null;
    }
    this.listenersAttached = false;
  }

  /**
   * Run all registered cleanups sequentially, respecting per-component timeouts.
   * Returns 0 for clean shutdown, 1 for timeout/error.
   *
   * Idempotent: calling shutdown() again returns immediately with the previous result.
   */
  async shutdown(): Promise<number> {
    if (this._hasCompleted) return 0;
    if (this._isShuttingDown) {
      // Already running — wait for it to finish
      return new Promise<number>((resolve) => {
        const check = setInterval(() => {
          if (this._hasCompleted) {
            clearInterval(check);
            resolve(0);
          }
        }, 100);
      });
    }

    this._isShuttingDown = true;
    let exitCode = 0;

    // Global hard timeout — absolute guarantee against zombies
    this.hardTimer = setTimeout(() => {
      log.error('hard_timeout', { timeoutMs: this.globalTimeoutMs });
      this.onStatus?.('Shutdown timed out, force exiting…');
      process.exit(1);
    }, this.globalTimeoutMs);
    // Don't let this timer keep the process alive
    this.hardTimer.unref();

    this.onStatus?.('Shutting down…');
    log.info('shutdown_start', { components: this.cleanups.map((c) => c.name) });

    for (const entry of this.cleanups) {
      try {
        this.onStatus?.(`  Stopping ${entry.name}…`);
        log.info('cleanup_start', { name: entry.name, timeoutMs: entry.timeoutMs });

        await Promise.race([
          entry.fn(),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error(`Timeout after ${entry.timeoutMs}ms`)), entry.timeoutMs),
          ),
        ]);

        log.info('cleanup_done', { name: entry.name });
      } catch (err) {
        // Log and proceed — never let one component block the rest
        const message = (err as Error).message;
        log.error('cleanup_error', { name: entry.name, error: message });
        exitCode = 1;
      }
    }

    if (this.hardTimer) {
      clearTimeout(this.hardTimer);
      this.hardTimer = null;
    }

    this._hasCompleted = true;
    this.onStatus?.(exitCode === 0 ? 'Done ✓' : 'Done (with errors)');
    log.info('shutdown_complete', { exitCode });

    return exitCode;
  }

  /**
   * Reset state. Only useful in tests.
   */
  reset(): void {
    this.detachSignalListeners();
    if (this.hardTimer) {
      clearTimeout(this.hardTimer);
      this.hardTimer = null;
    }
    this.cleanups = [];
    this._isShuttingDown = false;
    this._hasCompleted = false;
    this.signalCount = 0;
    this.onStatus = null;
  }
}

/**
 * Create a ShutdownManager for CLI use with signal listeners attached.
 * For tests, use `new ShutdownManager()` directly — no global side effects.
 */
export function createShutdownManager(globalTimeoutMs?: number): ShutdownManager {
  const manager = new ShutdownManager(globalTimeoutMs);
  manager.attachSignalListeners();
  return manager;
}
