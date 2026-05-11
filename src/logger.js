import pino from 'pino';
import { config } from './config.js';

export const logger = pino({
  level: config.logLevel,
  // In production: ship to stdout as JSON for the host log collector to ingest.
  // In dev: pretty-print to terminal.
  ...(config.env === 'development'
    ? {
        transport: {
          target: 'pino-pretty',
          options: { colorize: true, translateTime: 'HH:MM:ss', ignore: 'pid,hostname' },
        },
      }
    : {}),
  // Redact obvious secrets so they never end up in logs
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers["x-auth-password"]',
      'req.headers["x-auth-otp"]',
      '*.password',
      '*.otp',
      '*.token',
    ],
    censor: '[REDACTED]',
  },
});
