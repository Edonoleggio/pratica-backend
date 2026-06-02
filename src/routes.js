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
import * as google from './google.js';
import * as cargos from './cargos/client.js';
import { buildCsv, buildFilename, buildPecSubject } from './cargos/csv.js';
import * as pec from './cargos/pec.js';
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
import { getLampedusaArrivals } from './flights/index.js';
import { getLampedusaVessels } from './marine/index.js';
import { scheduleContractsBackup, restoreContractsFromDriveIfEmpty } from './contracts-backup.js';

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
// RENTME — elenco veicoli dell'agenzia
//
// L'UUID azienda (RENTME_USER_ID) vive solo qui come env, non nel codice
// del sito. Il backend chiama RentMe e restituisce SOLO i veicoli di
// Edonoleggio (filtrati per uuidDittaAssociata), così il frontend non
// deve né conoscere l'UUID né filtrare.
// ═══════════════════════════════════════════════════════════════════

router.get('/rentme/veicoli', async (req, res, next) => {
  try {
    const uid = config.rentme.userId;
    if (!uid) return res.status(503).json({ ok: false, error: 'rentme_non_configurato' });
    const url = `${config.rentme.apiBase}/user/getVeicoli/${encodeURIComponent(uid)}`;
    const upstream = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!upstream.ok) {
      return res.status(502).json({ ok: false, error: 'rentme_upstream', status: upstream.status });
    }
    const all = await upstream.json();
    // RentMe risponde { listObject: [...] }. Filtra i soli veicoli di Edonoleggio.
    const veicoli = (all?.listObject || [])
      .filter((v) => !v.uuidDittaAssociata || v.uuidDittaAssociata === uid);
    res.json({ ok: true, count: veicoli.length, veicoli });
  } catch (err) {
    logger.error({ err: err.message }, 'rentme.veicoli.error');
    res.status(502).json({ ok: false, error: 'rentme_error', detail: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════
// VOLI — arrivi all'aeroporto di Lampedusa (aggregatore multi-fonte)
// GET /api/voli/lampedusa[?date=YYYY-MM-DD]
// Risponde sempre 200 con { ok, flights[], sources{}, configured } anche se
// nessuna fonte è configurata (configured:false) → il frontend degrada pulito.
// ═══════════════════════════════════════════════════════════════════
router.get('/voli/lampedusa', async (req, res) => {
  try {
    const date = /^\d{4}-\d{2}-\d{2}$/.test(req.query.date || '') ? req.query.date : undefined;
    const data = await getLampedusaArrivals(date);
    res.json(data);
  } catch (err) {
    logger.error({ err: err.message }, 'voli.lampedusa.error');
    res.status(502).json({ ok: false, error: 'voli_error', detail: err.message });
  }
});

// GET /api/navi/lampedusa → tracking AIS traghetti/aliscafi (vedi marine/index.js)
router.get('/navi/lampedusa', async (_req, res) => {
  try {
    res.json(await getLampedusaVessels());
  } catch (err) {
    logger.error({ err: err.message }, 'navi.lampedusa.error');
    res.status(502).json({ ok: false, error: 'navi_error', detail: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════
// GOOGLE DRIVE — collegamento una-tantum + backup lato server
// ═══════════════════════════════════════════════════════════════════

// L'utente apre questo: viene mandato a Google per il consenso (una volta sola).
router.get('/google/connect', (req, res) => {
  if (!google.isGoogleConfigured()) {
    return res.status(503).send('Google non configurato sul server (mancano GOOGLE_CLIENT_ID/SECRET/REDIRECT_URI).');
  }
  res.redirect(google.buildAuthUrl());
});

// Google rimanda qui col code: lo scambiamo per il refresh token e lo salviamo.
router.get('/google/callback', async (req, res, next) => {
  try {
    const code = req.query.code;
    if (!code) return res.status(400).send('Codice mancante.');
    const tokens = await google.exchangeCodeForTokens(code);
    if (tokens.refresh_token) {
      google.saveRefreshToken(tokens.refresh_token);
      audit({ operatorId: operatorOf(req), action: 'google.connected', requestIp: req.ip });
      // Appena Drive è collegato: se il DB è vuoto (es. dopo un deploy), ripristina
      // i contratti dall'ultimo backup su Drive. Poi rifai subito un backup.
      restoreContractsFromDriveIfEmpty()
        .then((r) => { if (r.restored) logger.info({ restored: r.restored }, 'cargos.restore.on_connect'); })
        .catch(() => {});
    }
    // Pagina di conferma. Se Google ha restituito il refresh_token, lo mostriamo
    // UNA VOLTA con le istruzioni per renderlo permanente (env GOOGLE_REFRESH_TOKEN
    // su Render). Visibile solo a chi completa il consenso (richiede login Google).
    const rt = tokens.refresh_token ? String(tokens.refresh_token) : '';
    const rtEsc = rt.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const permanenceBlock = rt
      ? `<div style="max-width:680px;margin:24px auto 0;text-align:left;background:#f5f7fa;border:1px solid #d8e0ea;border-radius:10px;padding:18px 20px">
           <p style="margin:0 0 8px;font-weight:600">Rendi il collegamento permanente (consigliato, 1 minuto)</p>
           <p style="margin:0 0 10px;color:#444;font-size:14px;line-height:1.5">Così Drive resta collegato anche dopo i futuri aggiornamenti del server, senza rifare questo passaggio. Su <b>Render → pratica-backend → Environment</b> aggiungi una variabile:</p>
           <p style="margin:0 0 4px;font-size:13px;color:#555">Nome:</p>
           <code style="display:block;background:#fff;border:1px solid #ccd;border-radius:6px;padding:8px 10px;font-size:13px;margin-bottom:10px">GOOGLE_REFRESH_TOKEN</code>
           <p style="margin:0 0 4px;font-size:13px;color:#555">Valore (copialo tutto):</p>
           <code style="display:block;background:#fff;border:1px solid #ccd;border-radius:6px;padding:8px 10px;font-size:13px;word-break:break-all;user-select:all">${rtEsc}</code>
           <p style="margin:12px 0 0;color:#666;font-size:12.5px">Poi premi <b>Save Changes</b> (il server si riavvia da solo). Tieni questo valore riservato: chiudi la scheda dopo averlo copiato.</p>
         </div>`
      : `<p style="color:#999;font-size:13px">(Token permanente non restituito da Google in questo accesso — è comunque tutto funzionante.)</p>`;
    res.set('Content-Type', 'text/html; charset=utf-8').send(
      `<html><body style="font-family:sans-serif;text-align:center;padding:40px 16px">
       <h2>✅ Google Drive collegato</h2>
       <p>Il backup automatico su Drive è attivo.</p>
       ${permanenceBlock}
       <p style="margin-top:24px"><a href="${config.google.appUrl}">Torna a Pratica</a></p>
       </body></html>`,
    );
  } catch (err) {
    next(err);
  }
});

// Stato del collegamento (per il pulsante nel sito).
// connected = il token funziona DAVVERO (non solo presente). tokenPresent =
// esiste un token (env o DB) ma potrebbe essere scaduto/non valido.
router.get('/google/status', async (_req, res) => {
  const configured = google.isGoogleConfigured();
  const tokenPresent = google.isConnected();
  const connected = tokenPresent ? await google.isConnectedValid() : false;
  res.json({ ok: true, configured, connected, tokenPresent });
});

// Carica un backup su Drive (il sito invia i dati; l'upload lo fa il server,
// così non serve nessun popup Google nel browser).
router.post('/google/backup', async (req, res, next) => {
  try {
    if (!google.isConnected()) return res.status(409).json({ ok: false, error: 'google_non_collegato' });
    const data = req.body;
    if (!data || typeof data !== 'object') return res.status(400).json({ ok: false, error: 'payload_non_valido' });
    const filename = `edonoleggio-backup-${new Date().toISOString().slice(0, 10)}.json`;
    const result = await google.uploadToDrive(filename, JSON.stringify(data));
    audit({ operatorId: operatorOf(req), action: 'google.backup', details: { fileId: result.id } });
    res.json({ ok: true, fileId: result.id, filename: result.name });
  } catch (err) {
    logger.error({ err: err.message }, 'google.backup.error');
    res.status(502).json({ ok: false, error: 'google_backup_error', detail: err.message });
  }
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

    // Replica i contratti su Drive (durabilità anti-azzeramento disco). Debounced.
    scheduleContractsBackup('contract.created');

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
      scheduleContractsBackup('cargos.send.success');
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
    scheduleContractsBackup('contract.retry');
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
  const parsed = z.array(z.string()).max(100).safeParse(req.body.ids);
  if (!parsed.success) {
    return res.status(400).json({ ok: false, error: 'ids non validi', detail: formatErrors(parsed.error) });
  }
  const ids = parsed.data;
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
// PEC AUTOMATICA — predisposta ma SPENTA di default (PEC_AUTO_ENABLED!=='true').
// Si attiva più avanti senza modifiche al codice, solo impostando le env su Render.
// ═══════════════════════════════════════════════════════════════════

// Stato della PEC automatica (per diagnostica / pannello frontend).
router.get('/pec/status', (_req, res) => {
  res.json({
    ok: true,
    autoEnabled: pec.isPecAutoEnabled(),     // interruttore generale
    configured: pec.isPecConfigured(),       // credenziali + destinatario presenti
    to: config.questuraPec || null,
  });
});

// Verifica connessione + credenziali SMTP SENZA inviare nulla (per la predisposizione).
router.post('/pec/verify', async (_req, res, next) => {
  try {
    // Endpoint diagnostico: sempre 200, l'esito è nel campo `ok` (così durante la
    // predisposizione "non configurata" non genera falsi 5xx nei log).
    res.json(await pec.verifyPec());
  } catch (err) {
    next(err);
  }
});

// Invia i contratti indicati alla Questura via PEC. INVIA DAVVERO solo se l'interruttore
// è acceso (PEC_AUTO_ENABLED=true) E le credenziali ci sono → doppia sicurezza.
router.post('/contracts/send-pec', async (req, res, next) => {
  try {
    if (!pec.isPecAutoEnabled()) {
      return res.status(409).json({
        ok: false, error: 'pec_auto_non_attiva',
        hint: 'PEC automatica spenta. Impostare PEC_AUTO_ENABLED=true (+ PEC_USER/PEC_PASS) su Render per attivarla.',
      });
    }
    if (!pec.isPecConfigured()) {
      return res.status(409).json({ ok: false, error: 'pec_non_configurata', hint: 'Mancano PEC_USER/PEC_PASS o QUESTURA_PEC.' });
    }
    const parsed = z.array(z.string()).min(1).max(100).safeParse(req.body?.ids);
    if (!parsed.success) {
      return res.status(400).json({ ok: false, error: 'ids non validi', detail: formatErrors(parsed.error) });
    }
    const records = parsed.data.map((id) => getContract(id)).filter(Boolean).map((c) => c.payload);
    if (records.length === 0) return res.status(400).json({ ok: false, error: 'no_valid_contracts' });

    const result = await pec.sendCargosPec(records);
    audit({ operatorId: operatorOf(req), action: 'cargos.pec.sent', requestIp: req.ip, details: { count: records.length, messageId: result.messageId } });
    res.json({ ok: true, ...result });
  } catch (err) {
    logger.error({ err: err.message }, 'pec.send.error');
    res.status(502).json({ ok: false, error: 'pec_send_error', detail: err.message });
  }
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
    scheduleContractsBackup('contract.paper');

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
  scheduleContractsBackup('contract.deleted');
  res.json({ ok: true });
});
// ═══════════════════════════════════════════════════════════════════
// KEY-VALUE STORE — sincronizzazione dati tra dispositivi
//
// Protetto da STORE_SECRET (se configurato). Il frontend invia il
// token via header  Authorization: Bearer <token>  oppure query
// ?token=<token> (stesso pattern di backup.js).
// Se STORE_SECRET non è impostato il check è saltato (fallback per
// ambienti di sviluppo o deploy non ancora aggiornati).
// ═══════════════════════════════════════════════════════════════════

function checkStoreAuth(req, res, next) {
  const secret = config.storeSecret;
  if (!secret) return next();
  const auth = req.headers['authorization'] || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : (req.query.token || '');
  if (token !== secret) {
    return res.status(401).json({ ok: false, error: 'store_token_non_valido' });
  }
  next();
}

router.get('/store/:key', checkStoreAuth, (req, res) => {
  const value = getStoreValue(req.params.key);
  res.json({ ok: true, key: req.params.key, value: value ?? null });
});

router.put('/store/:key', checkStoreAuth, (req, res) => {
  setStoreValue(req.params.key, req.body.value);
  res.json({ ok: true });
});
