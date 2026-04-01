/**
 * Structured logging for Veil protocol.
 *
 * Environment variables:
 *   VEIL_LOG_LEVEL  — minimum level: debug | info | warn | error (default: info)
 *   VEIL_LOG_FORMAT — "json" forces JSON even on TTY; otherwise human-readable on TTY
 */

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 } as const;
type Level = keyof typeof LEVELS;

function currentLevel(): Level {
  const env = (process.env.VEIL_LOG_LEVEL ?? 'info').toLowerCase();
  return env in LEVELS ? (env as Level) : 'info';
}

function useJson(): boolean {
  if (process.env.VEIL_LOG_FORMAT === 'json') return true;
  return !process.stderr.isTTY;
}

function formatHuman(level: Level, module: string, msg: string, ctx?: Record<string, unknown>): string {
  const ts = new Date().toISOString();
  const tag = level.toUpperCase().padEnd(5);
  const extra = ctx && Object.keys(ctx).length ? ' ' + JSON.stringify(ctx) : '';
  return `${ts} ${tag} [${module}] ${msg}${extra}`;
}

function formatJson(level: Level, module: string, msg: string, ctx?: Record<string, unknown>): string {
  return JSON.stringify({ ts: new Date().toISOString(), level, module, msg, ...ctx });
}

function write(level: Level, module: string, msg: string, ctx?: Record<string, unknown>): void {
  if (LEVELS[level] < LEVELS[currentLevel()]) return;
  const line = useJson()
    ? formatJson(level, module, msg, ctx)
    : formatHuman(level, module, msg, ctx);
  if (level === 'error') {
    process.stderr.write(line + '\n');
  } else {
    process.stdout.write(line + '\n');
  }
}

export interface Logger {
  debug(msg: string, ctx?: Record<string, unknown>): void;
  info(msg: string, ctx?: Record<string, unknown>): void;
  warn(msg: string, ctx?: Record<string, unknown>): void;
  error(msg: string, ctx?: Record<string, unknown>): void;
}

export function createLogger(module: string): Logger {
  return {
    debug: (msg, ctx) => write('debug', module, msg, ctx),
    info: (msg, ctx) => write('info', module, msg, ctx),
    warn: (msg, ctx) => write('warn', module, msg, ctx),
    error: (msg, ctx) => write('error', module, msg, ctx),
  };
}
