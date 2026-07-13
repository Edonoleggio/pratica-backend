// ═══════════════════════════════════════════════════════════════════
// marine/ — Tracking live delle navi per Lampedusa (traghetti + aliscafi)
//
// Lampedusa ha pochissimi collegamenti via mare: il traghetto Siremar
// (Porto Empedocle–Linosa–Lampedusa) e gli aliscafi Liberty Lines.
// Tracciamo una LISTA CONFIGURABILE di navi per MMSI (env), via VesselAPI
// (REST, free tier): posizione AIS, velocità, rotta, stato, + ETA/destinazione.
//
// Risponde sempre 200 con { ok, port, vessels[], configured, generatedAt }
// così il frontend degrada pulito (offline / non configurato).
// ═══════════════════════════════════════════════════════════════════

import { config } from '../config.js';
import { logger } from '../logger.js';
import { getVesselNames, getSchedule } from './timetable.js';
import { startAisStreamPersistent } from './aisstream.js';

// TTL cache: il free tier VesselAPI ha quota mensile bassa → cache lunga
// (default 30 min, da env MARINE_CACHE_MIN) per non bruciarla (http_429).
const CACHE_TTL_MS = Math.max(5, (config.marine?.cacheMin || 30)) * 60 * 1000;
const RATELIMIT_BACKOFF_MS = 60 * 60 * 1000;   // dopo un 429, riprova non prima di 1h
const SRC_TIMEOUT_MS = 12000;
let _cache = null;                       // { at, payload }
let _lastGood = null;                    // ultimo payload con posizioni valide
let _rateLimitedUntil = 0;               // timestamp: non interrogare l'API prima di questo istante

// ── AISStream: connessione PERSISTENTE, posizioni per MMSI ─────────
// AIS è "a impulsi" e la copertura alle Pelagie è rada: l'unica strategia
// che non perde impulsi è ascoltare SEMPRE (una websocket aperta, gratis,
// senza quota). Ogni impulso aggiorna _positions; la risposta HTTP legge
// da lì ed è sempre immediata. Avviata pigramente alla prima richiesta.
const _positions = new Map();            // mmsi → { mmsi,name,lat,lon,sog,cog,navStatus,timestamp }
let _aisClient = null;                   // handle { state(), stop() } della connessione persistente

function ensureAisClient(mmsis, key) {
  if (_aisClient) return;
  _aisClient = startAisStreamPersistent(mmsis, key, {
    onUpdate: (u) => {
      const prev = _positions.get(u.mmsi) || { mmsi: u.mmsi };
      _positions.set(u.mmsi, { ...prev, ...u });
    },
    onLog: (msg, extra) => logger.warn(extra || {}, msg),
  });
}

const toRad = (d) => (d * Math.PI) / 180;
const toDeg = (r) => (r * 180) / Math.PI;

// Distanza haversine in km tra due coordinate
function distanceKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = toRad(lat2 - lat1), dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
// Rotta iniziale (bearing) da punto1 a punto2, in gradi 0-360
function bearing(lat1, lon1, lat2, lon2) {
  const dLon = toRad(lon2 - lon1);
  const y = Math.sin(dLon) * Math.cos(toRad(lat2));
  const x = Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) - Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(dLon);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}
function withTimeout(p, ms, label) {
  return Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`${label}_timeout`)), ms))]);
}

// Stato navigazione AIS (codice → etichetta sintetica)
function navLabel(code) {
  const n = Number(code);
  if (n === 1 || n === 2) return 'alla fonda';
  if (n === 5) return 'ormeggiata';
  if (n === 0 || n === 8) return 'in navigazione';
  return null;
}

// UN/LOCODE → nome leggibile (porti rilevanti per le Pelagie)
const PORT_LOCODE = {
  ITLMP: 'Lampedusa', ITLIU: 'Linosa', ITPOE: 'Porto Empedocle', ITPEM: 'Porto Empedocle',
  ITPAL: 'Palermo', ITTPS: 'Trapani', ITCAT: 'Catania',
};
function portName(code) {
  if (!code) return null;
  const k = String(code).toUpperCase().trim();
  return PORT_LOCODE[k] || code;
}

// Tipo nave (traghetto/aliscafo) da una mappa nota o dal nome
function vesselKind(name) {
  const t = (name || '').toLowerCase();
  if (t.includes('sansovino') || t.includes('cossyra') || t.includes('pietro novelli')) return 'traghetto';
  if (t.includes('hsc') || t.includes('liberty')) return 'aliscafo';
  return 'nave';
}

async function fetchVessel(mmsi, key, base) {
  const headers = { Authorization: `Bearer ${key}`, Accept: 'application/json' };
  // Posizione corrente
  const posUrl = `${base}/vessel/${encodeURIComponent(mmsi)}/position?filter.idType=mmsi`;
  const r = await withTimeout(fetch(posUrl, { headers }), SRC_TIMEOUT_MS, 'vesselapi');
  if (!r.ok) return { mmsi, ok: false, error: `http_${r.status}` };
  const pos = await r.json();
  const d = pos?.vesselPosition || pos?.data || pos;   // risposta reale: { vesselPosition: {...} }
  // ETA/destinazione (endpoint separato; opzionale, se fallisce ignora)
  let eta = null, destination = null;
  try {
    const er = await withTimeout(fetch(`${base}/vessel/${encodeURIComponent(mmsi)}/eta?filter.idType=mmsi`, { headers }), SRC_TIMEOUT_MS, 'vesselapi_eta');
    if (er.ok) { const ej = await er.json(); const e = ej?.vesselEta || ej?.data || ej; eta = e?.eta || e?.eta_utc || null; destination = portName(e?.destination_port || e?.destination); }
  } catch {}
  return {
    mmsi: String(d?.mmsi || mmsi),
    ok: true,
    name: d?.vessel_name || d?.name || '',
    lat: typeof d?.latitude === 'number' ? d.latitude : (d?.lat ?? null),
    lon: typeof d?.longitude === 'number' ? d.longitude : (d?.lon ?? null),
    sog: d?.sog ?? d?.speed ?? null,        // nodi
    cog: d?.cog ?? d?.course ?? null,        // rotta
    navStatus: d?.nav_status ?? d?.navStatus ?? null,
    timestamp: d?.timestamp || d?.processed_timestamp || null,
    eta, destination,
  };
}

// Trasforma una posizione AIS grezza ({mmsi,name,lat,lon,sog,cog,navStatus,
// timestamp,eta?,destination?}) nel record arricchito (distanza, stato, ETA).
function processVessel(v, port) {
  if (!v || v.lat == null || v.lon == null) {
    return { mmsi: v?.mmsi, name: v?.name || '', kind: vesselKind(v?.name), ok: false, error: v?.error || 'no_position' };
  }
  const distKm = Math.round(distanceKm(v.lat, v.lon, port.lat, port.lon));
  const brgToPort = bearing(v.lat, v.lon, port.lat, port.lon);
  const cog = v.cog == null ? null : Number(v.cog);
  const ts = v.timestamp ? new Date(v.timestamp).getTime() : null;
  const ageMin = ts ? Math.round((Date.now() - ts) / 60000) : null;
  const stale = ageMin != null && ageMin > 180;
  const diff = cog == null ? 999 : Math.min(Math.abs(cog - brgToPort), 360 - Math.abs(cog - brgToPort));
  const moving = (v.sog ?? 0) > 2;
  const approaching = moving && diff <= 55;
  const atPort = distKm <= 3 && (v.sog ?? 0) < 1.5;
  let etaMin = null;
  if (approaching && (v.sog ?? 0) > 0) etaMin = Math.round((distKm / (v.sog * 1.852)) * 60);
  let stato = navLabel(v.navStatus);
  if (atPort) stato = 'a Lampedusa';
  else if (approaching) stato = 'in avvicinamento';
  else if (!stato) stato = moving ? 'in navigazione' : 'ferma';
  return {
    mmsi: v.mmsi, name: v.name, kind: vesselKind(v.name), ok: true,
    lat: v.lat, lon: v.lon, sog: v.sog, cog,
    distanceKm: distKm, approaching, atPort, stato,
    etaMin, etaAis: v.eta || null, destination: v.destination || null,
    timestamp: v.timestamp, ageMin, stale,
  };
}

export async function getLampedusaVessels() {
  const { vesselApiKey, vesselApiBase, vesselsMmsi, portLat, portLon, aisStreamKey } = config.marine;
  const port = { lat: portLat, lon: portLon, name: 'Porto di Lampedusa' };
  const schedule = getSchedule(new Date().toISOString().slice(0, 10));   // orari: sempre presenti

  // ── Sorgente LIVE preferita: AISStream (gratis, no quota) ──────────
  // Risposta SEMPRE immediata dalle posizioni memorizzate; la connessione
  // persistente ascolta in background e cattura OGNI impulso. Le posizioni
  // persistono tra un impulso e l'altro → le navi restano visibili anche da ferme.
  if (aisStreamKey && vesselsMmsi.length) {
    ensureAisClient(vesselsMmsi, aisStreamKey);
    const nomi = getVesselNames();   // nome/kind noti dagli orari, anche senza posizione AIS
    const vessels = vesselsMmsi.map((m) => {
      const v = processVessel(_positions.get(String(m)) || { mmsi: m, ok: false, error: 'no_position' }, port);
      const info = nomi[String(m)];
      if (info && !v.name) { v.name = info.name; v.kind = info.kind; }
      return v;
    });
    return {
      ok: true, port, vessels, schedule, source: 'aisstream', configured: true,
      collecting: _positions.size === 0,   // hint: nessun impulso ancora catturato
      ais: _aisClient.state(),             // diagnosi viva: connected/framesTotal/lastError/reconnects…
      generatedAt: new Date().toISOString(),
    };
  }

  if (_cache && Date.now() - _cache.at < CACHE_TTL_MS) {
    return { ..._cache.payload, schedule, cached: true };
  }

  // ── Fallback: VesselAPI (REST, free tier con quota → 429) ──────────
  if (!vesselApiKey || !vesselsMmsi.length) {
    const payload = { ok: true, port, vessels: [], schedule, configured: !!(aisStreamKey || vesselApiKey), generatedAt: new Date().toISOString() };
    _cache = { at: Date.now(), payload };
    return payload;
  }
  if (Date.now() < _rateLimitedUntil) {
    if (_lastGood) return { ..._lastGood, schedule, cached: true, rateLimited: true };
    return { ok: true, port, vessels: [], schedule, configured: true, rateLimited: true, generatedAt: new Date().toISOString() };
  }
  const results = await Promise.all(
    vesselsMmsi.map((m) => fetchVessel(m, vesselApiKey, vesselApiBase).catch((e) => ({ mmsi: m, ok: false, error: e.message })))
  );
  const allRateLimited = results.length > 0 && results.every((v) => v.error === 'http_429');
  if (allRateLimited) {
    _rateLimitedUntil = Date.now() + RATELIMIT_BACKOFF_MS;
    if (_lastGood) { _cache = { at: Date.now(), payload: _lastGood }; return { ..._lastGood, schedule, cached: true, rateLimited: true }; }
    const payload = { ok: true, port, vessels: [], schedule, configured: true, rateLimited: true, generatedAt: new Date().toISOString() };
    _cache = { at: Date.now(), payload };
    return payload;
  }
  const vessels = results.map((v) => processVessel(v, port));
  const payload = { ok: true, port, vessels, schedule, source: 'vesselapi', configured: true, generatedAt: new Date().toISOString() };
  _cache = { at: Date.now(), payload };
  if (vessels.some((v) => v.ok)) _lastGood = payload;
  return payload;
}
