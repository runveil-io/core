// src/logger.ts
import { inspect } from 'util';
import { env } from 'process';

const logLevelOrder = { debug: 0, info: 1, warn: 2, error: 3 };
const logLevel = env.VEIL_LOG_LEVEL || 'info';
const isJsonFormat = env.VEIL_LOG_FORMAT === 'json';

function log(level: string, module: string, msg: string, context: any = {}) {
  if (logLevelOrder[level] >= logLevelOrder[logLevel]) {
    const logObject = {
      ts: new Date().toISOString(),
      level,
      module,
      msg,
      ...context,
    };

    if (isJsonFormat) {
      console.log(JSON.stringify(logObject));
    } else {
      console.log(inspect(logObject, { colors: true, depth: null }));
    }
  }
}

export const logger = {
  debug: (module: string, msg: string, context: any = {}) => log('debug', module, msg, context),
  info: (module: string, msg: string, context: any = {}) => log('info', module, msg, context),
  warn: (module: string, msg: string, context: any = {}) => log('warn', module, msg, context),
  error: (module: string, msg: string, context: any = {}) => log('error', module, msg, context),
};