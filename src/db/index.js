// ═══════════════════════════════════════════════════════════════════
// SQLite store with PII encryption at rest
//
// Why SQLite: a single agency processes maybe 50–500 contracts/day.
// SQLite handles that easily, requires zero external services, runs
// from a single file. Perfect for on-prem at the rental counter or
// a small VPS. For multi-agency tenants, swap the driver for Postgres.
//
// Why encrypt: contracts contain identity-document numbers, addresses,
// nationality. GDPR Art. 32 requires "appropriate technical measures"
// for PII at rest. Encryption with a key never written to disk satisfies
// this requirement; the database file alone is useless if exfiltrated.
// ═══════════════════════════════════════════════════════════════════

import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import crypto from 'node:crypto';
import { config } from '../config.js';

mkdirSync(dirname(config.dbPath), { recursive: true });

export const db = new Database(config.dbPath);

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('synchronous = NORMAL');

// ─── Migrations ───
// One schema, applied idempotently. For a real product, use a proper
// migration framework (e.g. Umzug). Inline is fine while the schema is small.
db.exec(`
  CREATE TABLE IF NOT EXISTS contracts (
    id                  TEXT PRIMARY KEY,           -- CONTRATTO_ID
    created_at          INTEGER NOT NULL,
    updated_at          INTEGER NOT NULL,
    operator_id         TEXT NOT NULL,
    vehicle_type        TEXT NOT NULL,              -- 'A' | 'M'
    cargos_required     INTEGER NOT NULL DEFAULT 1,
    status              TEXT NOT NULL,              -- draft|pending|sent|error|paper
    payload_encrypted   BLOB,                        -- AES-256-GCM ciphertext
    payload_iv          BLOB,
    payload_tag         BLOB,
    last_error          TEXT,
    attempt_count       INTEGER NOT NULL DEFAULT 0,
    next_attempt_at     INTEGER
  );

  CREATE INDEX IF NOT EXISTS idx_contracts_status     ON contracts(status, next_attempt_at);
  CREATE INDEX IF NOT EXISTS idx_contracts_created    ON contracts(created_at DESC);

  CREATE TABLE IF NOT EXISTS receipts (
    id                  TEXT PRIMARY KEY,
    contract_id         TEXT NOT NULL,
    received_at         INTEGER NOT NULL,
    receipt_id          TEXT NOT NULL,
    raw_response_json   TEXT NOT NULL,
    FOREIGN KEY (contract_id) REFERENCES contracts(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_receipts_contract ON receipts(contract_id);

  CREATE TABLE IF NOT EXISTS audit_log (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp    INTEGER NOT NULL,
    operator_id  TEXT NOT NULL,
    action       TEXT NOT NULL,
    contract_id  TEXT,
    request_ip   TEXT,
    details_json TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_audit_contract  ON audit_log(contract_id);
  CREATE INDEX IF NOT EXISTS idx_audit_timestamp ON audit_log(timestamp DESC);

  CREATE TABLE IF NOT EXISTS auth_tokens (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    token      TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_tokens_expires ON auth_tokens(expires_at DESC);

  CREATE TABLE IF NOT EXISTS reference_tables (
    table_id   TEXT NOT NULL,
    code       TEXT NOT NULL,
    label      TEXT NOT NULL,
    cached_at  INTEGER NOT NULL,
    PRIMARY KEY (table_id, code)
  );

  CREATE TABLE IF NOT EXISTS kv_store (
    key        TEXT PRIMARY KEY,
    value_json TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );
`);

// ═══════════════════════════════════════════════════════════════════
// Encryption helpers (AES-256-GCM, authenticated)
// Key must be 32 bytes (64 hex chars). Provided via ENCRYPTION_KEY env.
// ═══════════════════════════════════════════════════════════════════

const ALGO = 'aes-256-gcm';
const KEY = Buffer.from(config.encryptionKey, 'hex');

if (KEY.length !== 32) {
  throw new Error(
    'ENCRYPTION_KEY must be 32 bytes (64 hex chars). Generate with:\n' +
      '  node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"',
  );
}

export function encryptJSON(obj) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, KEY, iv);
  const plaintext = Buffer.from(JSON.stringify(obj), 'utf8');
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { ciphertext: encrypted, iv, tag };
}

export function decryptJSON(ciphertext, iv, tag) {
  const decipher = crypto.createDecipheriv(ALGO, KEY, iv);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return JSON.parse(plaintext.toString('utf8'));
}

// ═══════════════════════════════════════════════════════════════════
// Audit logging (immutable, append-only)
// ═══════════════════════════════════════════════════════════════════

const insertAuditStmt = db.prepare(
  `INSERT INTO audit_log (timestamp, operator_id, action, contract_id, request_ip, details_json)
   VALUES (?, ?, ?, ?, ?, ?)`,
);

export function audit({ operatorId, action, contractId = null, requestIp = null, details = {} }) {
  insertAuditStmt.run(
    Date.now(),
    operatorId,
    action,
    contractId,
    requestIp,
    JSON.stringify(details),
  );
}

// ═══════════════════════════════════════════════════════════════════
// Contract repository
// ═══════════════════════════════════════════════════════════════════

const upsertContractStmt = db.prepare(
  `INSERT INTO contracts (
    id, created_at, updated_at, operator_id, vehicle_type, cargos_required,
    status, payload_encrypted, payload_iv, payload_tag, attempt_count
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
   ON CONFLICT(id) DO UPDATE SET
     updated_at = excluded.updated_at,
     status = excluded.status,
     payload_encrypted = excluded.payload_encrypted,
     payload_iv = excluded.payload_iv,
     payload_tag = excluded.payload_tag`,
);

export function saveContract({ id, operatorId, vehicleType, cargosRequired, status, payload }) {
  const enc = encryptJSON(payload);
  const now = Date.now();
  upsertContractStmt.run(
    id,
    now,
    now,
    operatorId,
    vehicleType,
    cargosRequired ? 1 : 0,
    status,
    enc.ciphertext,
    enc.iv,
    enc.tag,
  );
}

export function setContractStatus(id, status, error = null) {
  db.prepare(
    `UPDATE contracts
     SET status = ?, last_error = ?, updated_at = ?,
         attempt_count = attempt_count + (CASE WHEN ? = 'error' THEN 1 ELSE 0 END)
     WHERE id = ?`,
  ).run(status, error, Date.now(), status, id);
}

export function getContract(id) {
  const row = db.prepare(`SELECT * FROM contracts WHERE id = ?`).get(id);
  if (!row) return null;
  let payload = null;
  if (row.payload_encrypted) {
    try {
      payload = decryptJSON(row.payload_encrypted, row.payload_iv, row.payload_tag);
    } catch (err) {
      payload = { _decrypt_error: err.message };
    }
  }
  return { ...row, payload };
}

export function listContracts({ status, since, limit = 50 } = {}) {
  let sql = `SELECT id, created_at, status, vehicle_type, cargos_required, last_error, attempt_count
             FROM contracts WHERE 1=1`;
  const params = [];
  if (status) {
    sql += ` AND status = ?`;
    params.push(status);
  }
  if (since) {
    sql += ` AND created_at >= ?`;
    params.push(since);
  }
  sql += ` ORDER BY created_at DESC LIMIT ?`;
  params.push(limit);
  return db.prepare(sql).all(...params);
}

/**
 * Find pending contracts ready for the next send attempt.
 * Used by the background worker.
 */
export function nextPendingContracts(limit = 10) {
  return db
    .prepare(
      `SELECT id FROM contracts
       WHERE status = 'pending'
         AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
         AND cargos_required = 1
       ORDER BY created_at ASC
       LIMIT ?`,
    )
    .all(Date.now(), limit)
    .map((r) => r.id);
}

export function scheduleRetry(id, delayMs) {
  db.prepare(
    `UPDATE contracts SET next_attempt_at = ?, updated_at = ? WHERE id = ?`,
  ).run(Date.now() + delayMs, Date.now(), id);
}
// ═══════════════════════════════════════════════════════════════════
// Key-Value Store — sincronizzazione dati tra dispositivi
// ═══════════════════════════════════════════════════════════════════

export function getStoreValue(key) {
  const row = db.prepare(`SELECT value_json FROM kv_store WHERE key = ?`).get(key);
  if (!row) return null;
  try { return JSON.parse(row.value_json); } catch { return null; }
}

export function setStoreValue(key, value) {
  db.prepare(
    `INSERT INTO kv_store (key, value_json, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`
  ).run(key, JSON.stringify(value), Date.now());
}
