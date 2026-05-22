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
    const url = new URL(`https://rentmealtervista.duckdns.org/api/rest/${pathParam}`);
    Object.entries(req.query)
      .filter(([k]) => k !== 'path')
      .forEach(([k, v]) => url.searchParams.set(k, v));
    const fetchOptions = {
      method: req.method,
      headers: { 'Content-Type': 'application/json' },
    };
    if (req.method !== 'GET' && req.me
