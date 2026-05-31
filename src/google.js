// ═══════════════════════════════════════════════════════════════════
// Google Drive — backup lato server con refresh token (login una volta sola)
//
// Flusso "authorization code" con access_type=offline: dopo il consenso
// iniziale dell'utente, Google fornisce un refresh_token che il server
// conserva (cifrato) e usa per ottenere access_token freschi all'infinito,
// senza più popup. L'access_token dura ~1h; il refresh_token resta valido
// finché l'utente non revoca l'accesso.
//
// Env richieste: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI
// Scope: drive.file (accesso ai soli file creati dall'app — minimo necessario).
// ═══════════════════════════════════════════════════════════════════

import { config } from './config.js';
import { encryptJSON, decryptJSON, getStoreValue, setStoreValue } from './db/index.js';
import { logger } from './logger.js';

const SCOPE = 'https://www.googleapis.com/auth/drive.file';
const TOKEN_KEY = 'google:refresh_token'; // chiave nel kv_store

export function isGoogleConfigured() {
  return Boolean(config.google.clientId && config.google.clientSecret && config.google.redirectUri);
}

// URL a cui mandare l'utente per il consenso iniziale (una volta sola).
export function buildAuthUrl(state = '') {
  const p = new URLSearchParams({
    client_id: config.google.clientId,
    redirect_uri: config.google.redirectUri,
    response_type: 'code',
    scope: SCOPE,
    access_type: 'offline',   // chiede il refresh_token
    prompt: 'consent',         // forza il rilascio del refresh_token anche se già autorizzato
    include_granted_scopes: 'true',
    state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${p.toString()}`;
}

// Scambia il code (dal callback) per access_token + refresh_token.
export async function exchangeCodeForTokens(code) {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: config.google.clientId,
      client_secret: config.google.clientSecret,
      redirect_uri: config.google.redirectUri,
      grant_type: 'authorization_code',
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Google token error: ${JSON.stringify(data)}`);
  return data; // { access_token, refresh_token, expires_in, ... }
}

// Salva il refresh_token cifrato nel DB.
export function saveRefreshToken(rt) {
  const enc = encryptJSON({ rt });
  setStoreValue(TOKEN_KEY, {
    c: enc.ciphertext.toString('hex'),
    i: enc.iv.toString('hex'),
    t: enc.tag.toString('hex'),
  });
}

export function getRefreshToken() {
  const s = getStoreValue(TOKEN_KEY);
  if (!s || !s.c) return null;
  try {
    const dec = decryptJSON(Buffer.from(s.c, 'hex'), Buffer.from(s.i, 'hex'), Buffer.from(s.t, 'hex'));
    return dec.rt || null;
  } catch (err) {
    logger.error({ err: err.message }, 'google.refresh_token.decrypt_error');
    return null;
  }
}

export function isConnected() {
  return Boolean(getRefreshToken());
}

// Ottiene un access_token fresco usando il refresh_token salvato.
export async function getFreshAccessToken() {
  const rt = getRefreshToken();
  if (!rt) throw new Error('Google non collegato (nessun refresh token)');
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      refresh_token: rt,
      client_id: config.google.clientId,
      client_secret: config.google.clientSecret,
      grant_type: 'refresh_token',
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Google refresh error: ${JSON.stringify(data)}`);
  return data.access_token;
}

// Carica un contenuto JSON su Google Drive (upload multipart).
export async function uploadToDrive(filename, contentString) {
  const accessToken = await getFreshAccessToken();
  const boundary = 'edo-boundary-' + Date.now();
  const metadata = { name: filename, mimeType: 'application/json' };
  const body =
    `--${boundary}\r\n` +
    'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
    JSON.stringify(metadata) + '\r\n' +
    `--${boundary}\r\n` +
    'Content-Type: application/json\r\n\r\n' +
    contentString + '\r\n' +
    `--${boundary}--`;
  const res = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': `multipart/related; boundary="${boundary}"`,
    },
    body,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Google Drive upload error: ${JSON.stringify(data)}`);
  return data; // { id, name, ... }
}
