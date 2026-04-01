// src/logger.ts

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_SEVERITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

export interface LogContext {
  [key: string]: any;
}

export class Logger {
  private module: string;

  constructor(module: string) {
    this.module = module;
  }

  private shouldLog(level: LogLevel): boolean {
    const minLevel = (process.env.VEIL_LOG_LEVEL || 'info') as LogLevel;
    const minSeverity = LEVEL_SEVERITY[minLevel] ?? LEVEL_SEVERITY.info;
    const currentSeverity = LEVEL_SEVERITY[level];
    return currentSeverity >= minSeverity;
  }

  private format(level: LogLevel, msg: string, context?: LogContext): string {
    const isJson = process.env.VEIL_LOG_FORMAT === 'json';
    const ts = new Date().toISOString();

    if (isJson) {
      return JSON.stringify({
        ts,
        level,
        module: this.module,
        msg,
        ...context,
      });
    }

    // Human-readable format
    let out = `[${ts}] [${level.toUpperCase()}] [${this.module}] ${msg}`;
    if (context && Object.keys(context).length > 0) {
      out += ` ${JSON.stringify(context)}`;
    }
    return out;
  }

  public debug(msg: string, context?: LogContext): void {
    if (this.shouldLog('debug')) {
      console.log(this.format('debug', msg, context));
    }
  }

  public info(msg: string, context?: LogContext): void {
    if (this.shouldLog('info')) {
      console.log(this.format('info', msg, context));
    }
  }

  public warn(msg: string, context?: LogContext): void {
    if (this.shouldLog('warn')) {
      console.warn(this.format('warn', msg, context));
    }
  }

  public error(msg: string, context?: LogContext): void {
    if (this.shouldLog('error')) {
      console.error(this.format('error', msg, context));
    }
  }
}
