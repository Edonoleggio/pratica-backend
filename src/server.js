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
      if (!origin || config.allowedOrigins.includes(origin)) return cb(null, true);
      cb(new Error(`Origin ${origin} not allowed by CORS`));
    },
    credentials: true,
  }),
);

app.use(express.json({ limit: '10mb' }));
app.use(pinoHttp({ logger }));

// ─── Rate limiting ───
app.use(
  '/api/contracts',
  rateLimit({
    windowMs: 60_000,
    max: 60,
    standardHeaders: true,
    legacyHeaders: false,
  }),
);

// ─── RentMe Proxy ───
app.all('/api/rentme-proxy', async (req, res) => {
  try {
    const pathParam = req.query.path || '';
    const remainingQuery = Object.entries(req.query)
      .filter(([k]) => k !== 'path')
      .reduce((acc, [k, v]) => { acc[k] = v; return acc; }, {});
    const url = new URL(`https://rentme.altervista.org/${pathParam}`);
    Object.entries(remainingQuery).forEach(([k, v]) => url.searchParams.set(k, v));
    const fetchOptions = {
      method: req.method,
      headers: { 'Content-Type': 'application/json' },
    };
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      fetchOptions.body = JSON.stringify(req.body);
    }
    const upstream = await fetch(url.toString(), fetchOptions);
    const text = await upstream.text();
    res.status(upstream.status)
      .set('Content-Type', upstream.headers.get('content-type') || 'application/json')
      .send(text);
  } catch (err) {
    logger.error({ err }, 'rentme-proxy.error');
    res.status(502).json({ ok: false, error: 'rentme_proxy_error', detail: err.message });
  }
});

    const target = 'https://rentme.altervista.org/edox-proxy.php';
    const url = new URL(target);
    Object.entries(req.query).forEach(([k, v]) => url.searchParams.set(k, v));
    const fetchOptions = {
      method: req.method,
      headers: { 'Content-Type': 'application/json' },
    };
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      fetchOptions.body = JSON.stringify(req.body);
    }
    const upstream = await fetch(url.toString(), fetchOptions);
    const text = await upstream.text();
    res.status(upstream.status)
      .set('Content-Type', upstream.headers.get('content-type') || 'application/json')
      .send(text);
  } catch (err) {
    logger.error({ err }, 'rentme-proxy.error');
    res.status(502).json({ ok: false, error: 'rentme_proxy_error', detail: err.message });
  }
});

// ─── Routes ───
app.use('/api', router);

// ─── 404 + error handlers ───
app.use((_req, res) => res.status(404).json({ ok: false, error: 'not_found' }));

app.use((err, req, res, _next) => {
  logger.error({ err }, 'unhandled');
  res.status(err.status || 500).json({
    ok: false,
    error: err.message || 'internal_error',
  });
});

// ═══════════════════════════════════════════════════════════════════
// Background worker
// ═══════════════════════════════════════════════════════════════════

const WORKER_INTERVAL_MS = 5_000;
const RETRY_BACKOFFS = [0, 30_000, 120_000, 600_000, 1_800_000];

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
  setTimeout(() => process.exit(1), 10_000).unref();
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
