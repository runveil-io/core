// src/cli.ts
import { program } from 'commander';
import { shutdown } from './shutdown';

program
  .command('start')
  .action(() => {
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);

    console.log('Shutting down...');
    shutdown();
  });

// src/shutdown.ts
import { WebSocketServer } from 'ws';
import { Server } from 'http';
import { db } from './db';
import { logger } from './logger';

let wss: WebSocketServer | null = null;
let httpServer: Server | null = null;

export function setWebSocketServer(server: WebSocketServer) {
  wss = server;
}

export function setHttpServer(server: Server) {
  httpServer = server;
}

export async function shutdown() {
  logger.info('Shutting down...');

  if (wss) {
    wss.clients.forEach(client => {
      client.close(1001, 'Shutting down');
    });
    wss.close(() => {
      logger.info('WebSocket server closed');
    });
  }

  if (httpServer) {
    httpServer.close(() => {
      logger.info('HTTP server closed');
    });
  }

  await db.flush();
  logger.info('Database flushed');

  process.exit(0);
}

// src/consumer/index.ts
import { WebSocketServer } from 'ws';
import { setWebSocketServer } from '../shutdown';
import { logger } from '../logger';

const wss = new WebSocketServer({ port: 8080 });
setWebSocketServer(wss);

wss.on('connection', (ws) => {
  ws.on('message', (message) => {
    logger.info(`Received message: ${message}`);
  });
});

// src/provider/index.ts
import { Server } from 'http';
import { setHttpServer } from '../shutdown';
import { logger } from '../logger';

const httpServer = Server((req, res) => {
  res.writeHead(200);
  res.end('Hello World\n');
});

setHttpServer(httpServer);

httpServer.listen(3000, () => {
  logger.info('HTTP server started on port 3000');
});

// src/db.ts
import { Database } from 'sqlite3';
import { logger } from './logger';

const db = new Database(':memory:');

export async function flush() {
  return new Promise((resolve, reject) => {
    db.checkpoint((err) => {
      if (err) {
        logger.error('Failed to flush database', err);
        reject(err);
      } else {
        logger.info('Database flushed');
        resolve();
      }
    });
  });
}

// src/logger.ts
import { createLogger, format, transports } from 'winston';

export const logger = createLogger({
  level: 'info',
  format: format.combine(
    format.timestamp(),
    format.errors({ stack: true }),
    format.splat(),
    format.json()
  ),
  transports: [
    new transports.Console(),
    new transports.File({ filename: 'combined.log' })
  ]
});