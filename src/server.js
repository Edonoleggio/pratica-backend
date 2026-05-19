// ═══════════════════════════════════════════════════════════════════
// Pratica Backend — Server entry point
// ═══════════════════════════════════════════════════════════════════

import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import pinoHttp from 'pino-http';
import { config } from './config.js';
import { logger } from './logger.js';
import { router } from './routes.js';
import * as cargos from './cargos/client.js';
import { nextPendingContracts, getContract, setContractStatus, scheduleRetry, audit } from './db/index.js';

const app = express();

// ─── Security middleware ───
app.use(helmet());
app.use(
  cors({
    origin: (origin, cb) => {
      // Allow same-origin and explicitly listed front-ends
      if (!origin || config.allowedOrigins.includes(origin)) return cb(null, true);
      cb(new Error(`Origin ${origin} not allowed by CORS`));
    },
    credentials: true,
  }),
);

app.use(express.json({ limit: '10mb' }));
app.use(pinoHttp({ logger }));

// ─── Rate limiting ───
// Generous for the agency's own UI; prevents accidental flood on /contracts
app.use(
  '/api/contracts',
  rateLimit({
    windowMs: 60_000,
    max: 60, // 60 req/min — well above realistic counter throughput
    standardHeaders: true,
    legacyHeaders: false,
  }),
);

// ─── Routes ───
app.use('/api', router);

// ─── 404 + error handlers ───
app.use((_req, res) => res.status(404).json({ ok: false, error: 'not_found' }));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, _next) => {
  logger.error({ err }, 'unhandled');
  res.status(err.status || 500).json({
    ok: false,
    error: err.message || 'internal_error',
  });
});

// ═══════════════════════════════════════════════════════════════════
// Background worker — drains pending contracts
//
// Why async: when the operator clicks "send", we want them to move on
// to the next customer in <1s. The send to CARGOS happens in the
// background, with retries. The UI polls or uses SSE to learn the
// outcome.
// ═══════════════════════════════════════════════════════════════════

const WORKER_INTERVAL_MS = 5_000;
const RETRY_BACKOFFS = [0, 30_000, 120_000, 600_000, 1_800_000]; // 0, 30s, 2m, 10m, 30m

async function workerTick() {
  const ids = nextPendingContracts(5);
  if (ids.length === 0) return;

  for (const id of ids) {
    const c = getContract(id);
    if (!c || c.status !== 'pending') continue;

    try {
      const result = await cargos.sendRecords(c.payload);
      setContractStatus(id, 'sent');
      audit({
        operatorId: c.operator_id,
        action: 'cargos.send.worker.success',
        contractId: id,
        details: { attempt: c.attempt_count + 1, idempotent: result.idempotent || false },
      });
      logger.info({ id }, 'worker.sent');
    } catch (err) {
      const attempt = c.attempt_count + 1;
      const backoff = RETRY_BACKOFFS[Math.min(attempt, RETRY_BACKOFFS.length - 1)];

      if (attempt >= RETRY_BACKOFFS.length) {
        setContractStatus(id, 'error', `giving up after ${attempt} attempts: ${err.message}`);
        audit({
          operatorId: c.operator_id,
          action: 'cargos.send.worker.giveup',
          contractId: id,
          details: { error: err.message, attempts: attempt },
        });
        logger.error({ id, err: err.message, attempts: attempt }, 'worker.giveup');
      } else {
        setContractStatus(id, 'pending', err.message);
        scheduleRetry(id, backoff);
        logger.warn({ id, attempt, nextRetryIn: backoff }, 'worker.retry');
      }
    }
  }
}

if (config.env !== 'test') {
  setInterval(() => {
    workerTick().catch((err) => logger.error({ err }, 'worker.tick.failed'));
  }, WORKER_INTERVAL_MS);
}

// ═══════════════════════════════════════════════════════════════════
// Boot
// ═══════════════════════════════════════════════════════════════════

const server = app.listen(config.port, () => {
  logger.info(
    {
      port: config.port,
      env: config.env,
      cargos: config.cargos.baseUrl,
      agency: config.agency.id || '(not configured)',
    },
    'pratica.boot',
  );
});

// ─── Graceful shutdown ───
const shutdown = (signal) => {
  logger.info({ signal }, 'shutdown.start');
  server.close(() => {
    logger.info('shutdown.complete');
    process.exit(0);
  });
  // Force exit after 10s if connections hang
  setTimeout(() => process.exit(1), 10_000).unref();
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
