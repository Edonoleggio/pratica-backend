// ═══════════════════════════════════════════════════════════════════
// API Routes
//
// Public surface consumed by the Pratica frontend:
//   POST   /api/auth/login          → exchange operator OTP for a session
//   GET    /api/health              → liveness + CARGOS reachability
//   POST   /api/contracts/check     → dry-run validation against tracciato + CED
//   POST   /api/contracts           → create + queue/send a contract
//   GET    /api/contracts           → list (filters by status, date range)
//   GET    /api/contracts/:id       → fetch one (decrypted)
//   GET    /api/contracts/:id/csv   → export single record as CARGOS CSV
//   POST   /api/contracts/csv-batch → export multiple records as CSV (PEC fallback)
//   GET    /api/tables/:id          → fetch reference tables (luoghi, etc.)
// ═══════════════════════════════════════════════════════════════════

import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { cargosRecordSchema, formatErrors } from './cargos/schema.js';
import { verifyAdminPassword, isAdminAuthConfigured } from './admin-auth.js';
import * as cargos from './cargos/client.js';
import { buildCsv, buildFilename, buildPecSubject } from './cargos/csv.js';
import {
  audit,
  saveContract,
  setContractStatus,
  getContract,
  listContracts,
  scheduleRetry,
  deleteContract,
  getStoreValue,
  setStoreValue,
} from './db/index.js';
import { config } from './config.js';
import { logger } from './logger.js';

export const router = Router();

// ─── Helper: which operator is acting? ───
function operatorOf(req) {
  return req.header('X-Operator-Id') || config.defaultOperatorId;
}

// ─── Helper: enrich a record with agency defaults ───
// Saves the operator from typing the agency block on every contract.
function withAgencyDefaults(record) {
  return {
    AGENZIA_ID: config.agency.id,
    AGENZIA_NOME: config.agency.nome,
    AGENZIA_LUOGO_COD: config.agency.luogoCod,
    AGENZIA_INDIRIZZO: config.agency.indirizzo,
    AGENZIA_RECAPITO_TEL: config.agency.tel,
    ...record,
  };
}

// ═══════════════════════════════════════════════════════════════════
// AUTH
// ═══════════════════════════════════════════════════════════════════

router.post('/auth/login', async (req, res, next) => {
  try {
    const body = z.object({ otp: z.string().regex(/^\d{6}$/, 'OTP a 6 cifre') }).parse(req.body);
    const result = await cargos.authenticate(body.otp);
    audit({ operatorId: operatorOf(req), action: 'auth.login', requestIp: req.ip });
    res.json({ ok: true, expiresAt: result.expiresAt });
  } catch (err) {
    next(err);
  }
});

// ═══════════════════════════════════════════════════════════════════
// ADMIN — verifica password "Modalità Admin" lato server
//
// La password admin non vive più nel browser: il frontend invia la
// password digitata e il server risponde solo ok/ko, confrontandola con
// l'hash scrypt in ADMIN_PASSWORD_HASH. Rate-limit anti-brute-force.
// ═══════════════════════════════════════════════════════════════════

const adminVerifyLimiter = rateLimit({
  windowMs: 5 * 60_000,        // 5 minuti
  max: 10,                     // max 10 tentativi per IP
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: 'troppi_tentativi', hint: 'Riprova tra qualche minuto' },
});

router.post('/auth/admin-verify', adminVerifyLimiter, (req, res) => {
  if (!isAdminAuthConfigured()) {
    // Hash non impostato sul server → il frontend ricadrà sul comportamento legacy.
    return res.status(503).json({ ok: false, error: 'admin_auth_non_configurato' });
  }
  const password = String(req.body?.password || '');
  const ok = verifyAdminPassword(password);
  audit({
    operatorId: operatorOf(req),
    action: ok ? 'admin.verify.ok' : 'admin.verify.fail',
    requestIp: req.ip,
  });
  if (!ok) return res.status(401).json({ ok: false });
  res.json({ ok: true });
});

// ═══════════════════════════════════════════════════════════════════
// HEALTH
// ═══════════════════════════════════════════════════════════════════

router.get('/health', async (_req, res) => {
  const cargosHealth = await cargos.probeHealth();
  res.json({
    ok: true,
    service: 'pratica-backend',
    timestamp: new Date().toISOString(),
    cargos: cargosHealth,
  });
});

// ═══════════════════════════════════════════════════════════════════
// CONTRACTS — CHECK (dry-run)
// ═══════════════════════════════════════════════════════════════════

router.post('/contracts/check', async (req, res, next) => {
  try {
    const enriched = withAgencyDefaults(req.body);
    const parsed = cargosRecordSchema.safeParse(enriched);

    if (!parsed.success) {
      return res.status(400).json({
        ok: false,
        stage: 'local-validation',
        errors: formatErrors(parsed.error),
      });
    }

    // Optional: CED check (expensive, costs an API call)
    if (req.query.ced === 'true') {
      const cedResult = await cargos.checkRecords(parsed.data);
      return res.json({ ok: cedResult.ok, stage: 'ced-check', ced: cedResult });
    }

    res.json({ ok: true, stage: 'local-validation', record: parsed.data });
  } catch (err) {
    next(err);
  }
});

// ═══════════════════════════════════════════════════════════════════
// CONTRACTS — CREATE
//
// Accepts a contract record. Behavior diverges by vehicle type:
//   • Auto (VEICOLO_TIPO = 'A')  → validate, persist, send to CARGOS
//   • Moto (VEICOLO_TIPO = 'M')  → persist only, mark as 'paper'
//                                 (motoveicoli excluded by D.L. 113/2018 art. 17)
//
// The 'mode' query param controls send timing:
//   • mode=sync   → return only after CARGOS replies (default; max 30s)
//   • mode=async  → queue and return immediately; worker sends in background
// ═══════════════════════════════════════════════════════════════════

router.post('/contracts', async (req, res, next) => {
  try {
    const operatorId = operatorOf(req);
    const enriched = withAgencyDefaults({ OPERATORE_ID: operatorId, ...req.body });

    // Validate against tracciato (full validation even for moto — clean records anyway)
    const parsed = cargosRecordSchema.safeParse(enriched);
    if (!parsed.success) {
      audit({
        operatorId,
        action: 'contract.rejected',
        contractId: enriched.CONTRATTO_ID,
        requestIp: req.ip,
        details: { errors: formatErrors(parsed.error) },
      });
      return res.status(400).json({
        ok: false,
        errors: formatErrors(parsed.error),
      });
    }

    const record = parsed.data;
    const isMoto = record.VEICOLO_TIPO === 'M';
    const cargosRequired = !isMoto;

    // Persist immediately — never lose a contract in flight
    saveContract({
      id: record.CONTRATTO_ID,
      operatorId,
      vehicleType: record.VEICOLO_TIPO,
      cargosRequired,
      status: cargosRequired ? 'pending' : 'paper',
      payload: record,
    });

    audit({
      operatorId,
      action: 'contract.created',
      contractId: record.CONTRATTO_ID,
      requestIp: req.ip,
      details: { type: record.VEICOLO_TIPO, cargosRequired },
    });

    // Moto → done. Just return the contract ID.
    if (!cargosRequired) {
      return res.status(201).json({
        ok: true,
        contractId: record.CONTRATTO_ID,
        status: 'paper',
        message: 'Motoveicolo — nessun invio CARGOS richiesto (D.L. 113/2018 art. 17)',
      });
    }

    // Auto → send (sync or async)
    const mode = req.query.mode === 'async' ? 'async' : 'sync';

    if (mode === 'async') {
      return res.status(202).json({
        ok: true,
        contractId: record.CONTRATTO_ID,
        status: 'pending',
        message: 'In coda per invio. Stato consultabile via GET /api/contracts/:id',
      });
    }

    // Sync send
    try {
      const result = await cargos.sendRecords(record);
      setContractStatus(record.CONTRATTO_ID, 'sent');
      audit({
        operatorId,
        action: 'cargos.send.success',
        contractId: record.CONTRATTO_ID,
        details: { idempotent: result.idempotent || false },
      });
      return res.status(201).json({
        ok: true,
        contractId: record.CONTRATTO_ID,
        status: 'sent',
        receipt: result.receipt,
      });
    } catch (err) {
      setContractStatus(record.CONTRATTO_ID, 'error', err.message);
      audit({
        operatorId,
        action: 'cargos.send.error',
        contractId: record.CONTRATTO_ID,
        details: { error: err.message },
      });
      // Still 201: the contract is saved locally; the user can retry.
      return res.status(201).json({
        ok: false,
        contractId: record.CONTRATTO_ID,
        status: 'error',
        error: err.message,
        hint: 'Pratica salvata in locale. Riprovare l\'invio o usare il fallback CSV/PEC.',
      });
    }
  } catch (err) {
    next(err);
  }
});

// ═══════════════════════════════════════════════════════════════════
// CONTRACTS — LIST + GET
// ═══════════════════════════════════════════════════════════════════

router.get('/contracts', (req, res) => {
  const status = req.query.status;
  const since = req.query.since ? Number(req.query.since) : undefined;
  const limit = Math.min(Number(req.query.limit) || 50, 500);
  res.json({ contracts: listContracts({ status, since, limit }) });
});

router.get('/contracts/:id', (req, res) => {
  const c = getContract(req.params.id);
  if (!c) return res.status(404).json({ ok: false, error: 'not_found' });
  res.json({
    id: c.id,
    status: c.status,
    vehicleType: c.vehicle_type,
    cargosRequired: !!c.cargos_required,
    createdAt: c.created_at,
    updatedAt: c.updated_at,
    operatorId: c.operator_id,
    attemptCount: c.attempt_count,
    lastError: c.last_error,
    payload: c.payload,
  });
});

// ═══════════════════════════════════════════════════════════════════
// CONTRACTS — RETRY a failed send
// ═══════════════════════════════════════════════════════════════════

router.post('/contracts/:id/retry', async (req, res, next) => {
  try {
    const c = getContract(req.params.id);
    if (!c) return res.status(404).json({ ok: false, error: 'not_found' });
    if (c.status === 'sent') return res.json({ ok: true, status: 'sent', message: 'già inviato' });

    setContractStatus(c.id, 'pending');
    const result = await cargos.sendRecords(c.payload);
    setContractStatus(c.id, 'sent');
    audit({
      operatorId: operatorOf(req),
      action: 'cargos.send.retry.success',
      contractId: c.id,
    });
    res.json({ ok: true, status: 'sent', receipt: result.receipt });
  } catch (err) {
    setContractStatus(req.params.id, 'error', err.message);
    next(err);
  }
});

// ═══════════════════════════════════════════════════════════════════
// CSV FALLBACK
// ═══════════════════════════════════════════════════════════════════

router.get('/contracts/:id/csv', (req, res) => {
  const c = getContract(req.params.id);
  if (!c) return res.status(404).json({ ok: false, error: 'not_found' });
  const csv = buildCsv(c.payload);
  res.set({
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': `attachment; filename="${buildFilename(config.agency.id)}"`,
  });
  res.send(csv);
});

router.post('/contracts/csv-batch', (req, res) => {
  const ids = z.array(z.string()).max(100).parse(req.body.ids);
  const records = ids.map((id) => getContract(id)).filter(Boolean).map((c) => c.payload);

  if (records.length === 0) {
    return res.status(400).json({ ok: false, error: 'no_valid_contracts' });
  }

  const csv = buildCsv(records);
  const filename = buildFilename(config.agency.id);
  const subject = buildPecSubject(config.agency.nome);

  res.json({
    filename,
    pecSubject: subject,
    pecAddress: config.questuraPec,
    csvBase64: csv.toString('base64'),
    instructions:
      'Inviare via PEC alla Questura competente con oggetto specificato. Conservare ricevuta di consegna.',
  });
});

// ═══════════════════════════════════════════════════════════════════
// REFERENCE TABLES
// ═══════════════════════════════════════════════════════════════════

router.get('/tables/:id', async (req, res, next) => {
  try {
    const result = await cargos.fetchTable(req.params.id);
    res.json(result);
  } catch (err) {
    next(err);
  }
});
// ═══════════════════════════════════════════════════════════════════
// PAPER CONTRACTS — contratti senza invio CARGOS
// ═══════════════════════════════════════════════════════════════════

router.post('/contracts/paper', (req, res) => {
  try {
    const operatorId = operatorOf(req);
    const data = req.body;
    const id = `EDO-${new Date().getFullYear()}-${Date.now()}`;

    saveContract({
      id,
      operatorId,
      vehicleType: data.tipoVeicolo || 'unknown',
      cargosRequired: false,
      status: 'paper',
      payload: data,
    });

    audit({
      operatorId,
      action: 'contract.paper.created',
      contractId: id,
      details: { type: data.tipoVeicolo },
    });

    res.status(201).json({ ok: true, contractId: id, status: 'paper' });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});
// ═══════════════════════════════════════════════════════════════════
// DELETE CONTRACT
// ═══════════════════════════════════════════════════════════════════

router.delete('/contracts/:id', (req, res) => {
  const c = getContract(req.params.id);
  if (!c) return res.status(404).json({ ok: false, error: 'not_found' });
  deleteContract(req.params.id);
  audit({
    operatorId: operatorOf(req),
    action: 'contract.deleted',
    contractId: req.params.id,
    requestIp: req.ip,
  });
  res.json({ ok: true });
});
// ═══════════════════════════════════════════════════════════════════
// KEY-VALUE STORE — sincronizzazione dati tra dispositivi
// ═══════════════════════════════════════════════════════════════════

router.get('/store/:key', (req, res) => {
  const value = getStoreValue(req.params.key);
  res.json({ ok: true, key: req.params.key, value: value ?? null });
});

router.put('/store/:key', (req, res) => {
  setStoreValue(req.params.key, req.body.value);
  res.json({ ok: true });
});
