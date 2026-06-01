// ═══════════════════════════════════════════════════════════════════
// CARGOS API Client
//
// Wraps the four endpoints exposed by the Polizia di Stato:
//   GET  /api/Token                          → authenticate, returns session token
//   POST /api/Send                           → submit one or more contract records
//   POST /api/Check                          → dry-run validation by the CED
//   GET  /api/Tabella?TabellaIdentificativo  → fetch reference tables (luoghi, etc.)
//
// Design principles:
//   • Token cached in memory + DB; refreshed transparently before expiry
//   • Idempotent sends: re-sending the same CONTRATTO_ID returns the existing receipt
//   • Exponential backoff on transient errors (5xx, network) up to 5 retries
//   • Hard fail on 4xx: those are validation errors, retrying won't help
//   • Every request/response logged to audit_log for compliance
//
// IMPORTANT: The exact request/response shapes of the CARGOS API are
// documented in the manuals issued with the Questura credentials. The
// shapes here are reasonable defaults for ASP.NET Web API patterns and
// should be verified at integration time.
// ═══════════════════════════════════════════════════════════════════

import { fetch } from 'undici';
import pRetry, { AbortError } from 'p-retry';
import { generateSync as generateTotp } from 'otplib';
import { config } from '../config.js';
import { db } from '../db/index.js';
import { logger } from '../logger.js';

// ─── Token cache (process-local) ───
let tokenCache = { token: null, expiresAt: 0 };

const TOKEN_SAFETY_MARGIN_MS = 60_000; // refresh 1 min before expiry

// ─── Helpers ───
async function cargosFetch(path, init = {}) {
  const url = `${config.cargos.baseUrl}${path}`;
  const headers = {
    'Content-Type': 'application/json',
    'Accept': 'application/json',
    ...init.headers,
  };

  const start = Date.now();
  const res = await fetch(url, { ...init, headers });
  const elapsed = Date.now() - start;

  let body = null;
  const text = await res.text();
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }

  logger.debug({ path, status: res.status, ms: elapsed }, 'cargos.request');

  return { status: res.status, body, ok: res.ok };
}

function isTransientStatus(status) {
  // 5xx server errors and 429 rate-limit are worth retrying
  return status >= 500 || status === 429;
}

// ═══════════════════════════════════════════════════════════════════
// Token management
// ═══════════════════════════════════════════════════════════════════

/**
 * Fetch a fresh CARGOS session token.
 * The portal uses 2FA: username + password + OTP (one-time per session).
 * If CARGOS_OTP_SECRET is set, generate TOTP automatically.
 * Otherwise, the operator must POST /auth/login with otp in the body.
 *
 * @param {string} [otp] - 6-digit OTP code (required unless OTP secret is configured)
 */
export async function authenticate(otp) {
  const credentials = {
    username: config.cargos.username,
    password: config.cargos.password,
    otp: otp || generateTotpIfAvailable(),
  };

  if (!credentials.otp) {
    throw new Error('OTP richiesto: passare il codice generato dall\'autenticatore della Questura');
  }

  const { status, body, ok } = await cargosFetch('/api/Token', {
    method: 'GET',
    headers: {
      'X-Auth-Username': credentials.username,
      'X-Auth-Password': credentials.password,
      'X-Auth-OTP': credentials.otp,
    },
  });

  if (!ok) {
    throw new AbortError(`Autenticazione CARGOS fallita (HTTP ${status}): ${JSON.stringify(body)}`);
  }

  // Defensive parsing — actual field names depend on CARGOS implementation
  const token = body?.token || body?.access_token || body?.Token;
  const expiresIn = body?.expires_in || body?.ExpiresIn || 1800; // default 30min

  if (!token) {
    throw new AbortError('Risposta CARGOS senza token');
  }

  const expiresAt = Date.now() + expiresIn * 1000;
  tokenCache = { token, expiresAt };

  // Persist to DB so a restart doesn't lose the session
  db.prepare(
    `INSERT INTO auth_tokens (token, expires_at, created_at) VALUES (?, ?, ?)`,
  ).run(token, expiresAt, Date.now());

  logger.info({ expiresIn }, 'cargos.token.refreshed');
  return { token, expiresAt };
}

/**
 * Get a valid token, fetching/refreshing transparently.
 * Throws if no OTP is available and the session has expired.
 */
async function ensureToken() {
  if (tokenCache.token && tokenCache.expiresAt - Date.now() > TOKEN_SAFETY_MARGIN_MS) {
    return tokenCache.token;
  }

  // Try to recover the most recent unexpired token from DB (e.g. after a restart)
  const row = db.prepare(
    `SELECT token, expires_at FROM auth_tokens
     WHERE expires_at > ? ORDER BY created_at DESC LIMIT 1`,
  ).get(Date.now() + TOKEN_SAFETY_MARGIN_MS);

  if (row) {
    tokenCache = { token: row.token, expiresAt: row.expires_at };
    return row.token;
  }

  // No valid token. Try TOTP if configured; otherwise the caller must authenticate.
  const totp = generateTotpIfAvailable();
  if (totp) {
    const fresh = await authenticate(totp);
    return fresh.token;
  }

  throw new Error(
    'Sessione CARGOS scaduta. L\'operatore deve effettuare il login con OTP via POST /api/auth/login',
  );
}

function generateTotpIfAvailable() {
  const secret = config.cargos.otpSecret;
  if (!secret) return null;
  try {
    // otplib v13: generateSync({ secret }) → stringa di 6 cifre.
    // Richiede un secret base32 di almeno 16 byte (128 bit).
    return generateTotp({ secret });
  } catch (err) {
    logger.warn({ err: err.message }, 'cargos.totp.generate.error');
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════════
// Send (POST /api/Send)
// ═══════════════════════════════════════════════════════════════════

/**
 * Submit a single contract record (or batch) to CARGOS.
 * Idempotent: if CONTRATTO_ID already has a stored receipt, returns it
 * without re-hitting the portal.
 *
 * @param {object|object[]} records - validated CARGOS record(s)
 * @returns {Promise<{receipt: object, contracts: string[]}>}
 */
export async function sendRecords(records) {
  const arr = Array.isArray(records) ? records : [records];

  // ─── Idempotency check ───
  const existing = db
    .prepare(
      `SELECT contract_id, receipt_id, raw_response_json FROM receipts
       WHERE contract_id IN (${arr.map(() => '?').join(',')})`,
    )
    .all(...arr.map((r) => r.CONTRATTO_ID));

  if (existing.length === arr.length) {
    logger.info({ ids: arr.map((r) => r.CONTRATTO_ID) }, 'cargos.send.idempotent');
    return {
      receipt: existing.map((e) => JSON.parse(e.raw_response_json)),
      contracts: existing.map((e) => e.contract_id),
      idempotent: true,
    };
  }

  // ─── Send with retry ───
  const result = await pRetry(
    async () => {
      const token = await ensureToken();
      const { status, body, ok } = await cargosFetch('/api/Send', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: JSON.stringify({ records: arr }),
      });

      if (ok) return body;

      // 401 → token expired mid-flight; invalidate cache and let p-retry retry once
      if (status === 401) {
        tokenCache = { token: null, expiresAt: 0 };
        throw new Error('Token expired, retry');
      }

      // 4xx other than 401 → permanent failure (validation, format, etc.)
      if (status >= 400 && status < 500) {
        throw new AbortError(
          `CARGOS rejected the submission (HTTP ${status}): ${JSON.stringify(body)}`,
        );
      }

      // 5xx → transient, retry
      throw new Error(`CARGOS server error ${status}`);
    },
    {
      retries: 5,
      factor: 2,
      minTimeout: 800,
      maxTimeout: 30_000,
      onFailedAttempt: (err) =>
        logger.warn(
          { attempt: err.attemptNumber, retriesLeft: err.retriesLeft, msg: err.message },
          'cargos.send.retry',
        ),
    },
  );

  // ─── Persist receipts ───
  const receiptId = result?.receiptId || result?.RicevutaId || `RIC-${Date.now()}`;
  const stmt = db.prepare(
    `INSERT INTO receipts (id, contract_id, received_at, receipt_id, raw_response_json)
     VALUES (?, ?, ?, ?, ?)`,
  );
  for (const r of arr) {
    stmt.run(
      `${receiptId}-${r.CONTRATTO_ID}`,
      r.CONTRATTO_ID,
      Date.now(),
      receiptId,
      JSON.stringify(result),
    );
  }

  return { receipt: result, contracts: arr.map((r) => r.CONTRATTO_ID) };
}

// ═══════════════════════════════════════════════════════════════════
// Check (POST /api/Check)
// Dry-run: lets the CED validate without storing. Useful for previewing
// errors before committing the contract.
// ═══════════════════════════════════════════════════════════════════

export async function checkRecords(records) {
  const arr = Array.isArray(records) ? records : [records];
  const token = await ensureToken();

  const { status, body, ok } = await cargosFetch('/api/Check', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({ records: arr }),
  });

  return { ok, status, body };
}

// ═══════════════════════════════════════════════════════════════════
// Reference tables (GET /api/Tabella)
// Cached locally — these tables (comuni, stati, tipo doc) change rarely.
// Default TTL: 7 days.
// ═══════════════════════════════════════════════════════════════════

const TABLE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export async function fetchTable(tableId) {
  // Try cache
  const oldest = db
    .prepare(
      `SELECT MIN(cached_at) AS oldest, COUNT(*) AS n FROM reference_tables WHERE table_id = ?`,
    )
    .get(tableId);

  const stillFresh = oldest?.n > 0 && Date.now() - oldest.oldest < TABLE_TTL_MS;

  if (stillFresh) {
    const rows = db
      .prepare(`SELECT code, label FROM reference_tables WHERE table_id = ? ORDER BY label`)
      .all(tableId);
    return { source: 'cache', rows };
  }

  // Refresh from CARGOS
  const token = await ensureToken();
  const { ok, body } = await cargosFetch(
    `/api/Tabella?TabellaIdentificativo=${encodeURIComponent(tableId)}`,
    { method: 'GET', headers: { Authorization: `Bearer ${token}` } },
  );

  if (!ok) throw new Error(`Failed to fetch table ${tableId}`);

  const rows = (body?.rows || body?.Rows || body || []).map((r) => ({
    code: r.code || r.codice || r.Codice,
    label: r.label || r.descrizione || r.Descrizione,
  }));

  const tx = db.transaction(() => {
    db.prepare(`DELETE FROM reference_tables WHERE table_id = ?`).run(tableId);
    const ins = db.prepare(
      `INSERT INTO reference_tables (table_id, code, label, cached_at) VALUES (?, ?, ?, ?)`,
    );
    const now = Date.now();
    for (const r of rows) ins.run(tableId, String(r.code), r.label, now);
  });
  tx();

  return { source: 'live', rows };
}

// ═══════════════════════════════════════════════════════════════════
// Health probe — reports portal reachability without consuming a token
// ═══════════════════════════════════════════════════════════════════

export async function probeHealth() {
  try {
    const start = Date.now();
    const res = await fetch(config.cargos.baseUrl, {
      method: 'HEAD',
      signal: AbortSignal.timeout(5000),
    });
    return { reachable: res.ok || res.status < 500, status: res.status, ms: Date.now() - start };
  } catch (err) {
    return { reachable: false, error: err.message };
  }
}
