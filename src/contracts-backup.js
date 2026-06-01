// ═══════════════════════════════════════════════════════════════════
// contracts-backup — Durabilità dei contratti CARGOS su Google Drive
//
// PERCHÉ: il disco di Render (free tier) è effimero → a ogni deploy il DB
// SQLite si azzera, e con esso i contratti CARGOS (records legali) e le
// ricevute. Per non perderli SENZA costi, li replichiamo su Google Drive
// (gratis, durevole, off-site) e li ripristiniamo quando il DB è vuoto.
//
// PRIVACY: si esportano i BLOB GIÀ CIFRATI (AES-256-GCM). Il file su Drive è
// quindi cifrato: inutile senza ENCRYPTION_KEY (che vive solo nelle env).
//
// La prova LEGALE primaria resta la ricevuta PEC di consegna alla Questura;
// questo è un secondo livello di sicurezza per lo storico nell'app.
// ═══════════════════════════════════════════════════════════════════

import { exportContractsBackup, importContractsBackup, countContracts } from './db/index.js';
import * as google from './google.js';
import { logger } from './logger.js';

const DRIVE_FILENAME = 'cargos-contracts-backup.json';
let _timer = null;

// Backup immediato su Drive di tutti i contratti + ricevute (snapshot completo).
export async function backupContractsToDrive(reason = 'manual') {
  if (!google.isConnected()) return { ok: false, reason: 'google_not_connected' };
  try {
    const data = exportContractsBackup();
    if (!data.contracts.length && !data.receipts.length) return { ok: true, skipped: 'empty' };
    const res = await google.uploadToDrive(DRIVE_FILENAME, JSON.stringify(data));
    logger.info({ count: data.contracts.length, receipts: data.receipts.length, reason }, 'cargos.backup.drive.ok');
    return { ok: true, fileId: res.id, count: data.contracts.length };
  } catch (err) {
    logger.error({ err: err.message, reason }, 'cargos.backup.drive.error');
    return { ok: false, reason: err.message };
  }
}

// Backup "debounced": dopo una modifica ai contratti, esegue tra qualche secondo.
// Evita raffiche se arrivano più contratti ravvicinati (ne basta uno: è snapshot pieno).
export function scheduleContractsBackup(reason = 'change') {
  if (_timer) clearTimeout(_timer);
  _timer = setTimeout(() => { backupContractsToDrive(reason).catch(() => {}); }, 5000);
  _timer.unref?.();
}

// Ripristino: SOLO se il DB locale è vuoto (es. appena azzerato da un deploy) e
// Drive è collegato. Non sovrascrive mai dati locali esistenti (INSERT OR IGNORE).
export async function restoreContractsFromDriveIfEmpty() {
  try {
    if (countContracts() > 0) return { restored: 0, reason: 'db_not_empty' };
    if (!google.isConnected()) return { restored: 0, reason: 'google_not_connected' };
    const content = await google.downloadFromDrive(DRIVE_FILENAME);
    if (!content) return { restored: 0, reason: 'no_backup_on_drive' };
    const data = JSON.parse(content);
    const r = importContractsBackup(data);
    logger.info({ restored: r.restored, receipts: r.receipts }, 'cargos.restore.drive.ok');
    return r;
  } catch (err) {
    logger.error({ err: err.message }, 'cargos.restore.drive.error');
    return { restored: 0, reason: err.message };
  }
}
