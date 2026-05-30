// ═══════════════════════════════════════════════════════════════════
// Verifica password "Modalità Admin" lato server.
//
// La password admin NON deve vivere nel browser (sarebbe leggibile dalla
// console). Qui si confronta la password inviata con un hash scrypt
// memorizzato nella env var ADMIN_PASSWORD_HASH. Si usa solo crittografia
// integrata di Node (nessuna dipendenza esterna).
//
// Formato di ADMIN_PASSWORD_HASH:  scrypt$<saltHex>$<hashHex>
// Genera l'hash con lo script: node scripts/hash-admin-password.js "<password>"
// ═══════════════════════════════════════════════════════════════════

import crypto from 'node:crypto';

const KEYLEN = 64;

// Genera la stringa hash da salvare in ADMIN_PASSWORD_HASH.
export function hashAdminPassword(plain) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(plain), salt, KEYLEN);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

// Confronta una password in chiaro con l'hash memorizzato (timing-safe).
// Ritorna false se l'hash non è configurato o è malformato.
export function verifyAdminPassword(plain, stored = process.env.ADMIN_PASSWORD_HASH || '') {
  const parts = String(stored).split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const salt = Buffer.from(parts[1], 'hex');
  const expected = Buffer.from(parts[2], 'hex');
  if (salt.length === 0 || expected.length === 0) return false;
  let actual;
  try {
    actual = crypto.scryptSync(String(plain), salt, expected.length);
  } catch {
    return false;
  }
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

export function isAdminAuthConfigured() {
  return Boolean(process.env.ADMIN_PASSWORD_HASH);
}
