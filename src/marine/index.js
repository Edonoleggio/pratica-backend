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

const CACHE_TTL_MS = 4 * 60 * 1000;     // 4 minuti (le posizioni cambiano lentamente in mare)
const SRC_TIMEOUT_MS = 12000;
let _cache = null;                       // { at, payload }

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
  const d = pos?.data || pos;   // tollerante a wrapper { data: {...} }
  // ETA/destinazione (endpoint separato; opzionale, se fallisce ignora)
  let eta = null, destination = null;
  try {
    const er = await withTimeout(fetch(`${base}/vessel/${encodeURIComponent(mmsi)}/eta?filter.idType=mmsi`, { headers }), SRC_TIMEOUT_MS, 'vesselapi_eta');
    if (er.ok) { const ej = await er.json(); const e = ej?.data || ej; eta = e?.eta || e?.eta_utc || null; destination = e?.destination || e?.dest || null; }
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

export async function getLampedusaVessels() {
  if (_cache && Date.now() - _cache.at < CACHE_TTL_MS) return { ..._cache.payload, cached: true };

  const { vesselApiKey: key, vesselApiBase: base, vesselsMmsi, portLat, portLon } = config.marine;
  const port = { lat: portLat, lon: portLon, name: 'Porto di Lampedusa' };

  if (!key || !vesselsMmsi.length) {
    const payload = { ok: true, port, vessels: [], configured: false, generatedAt: new Date().toISOString() };
    _cache = { at: Date.now(), payload };
    return payload;
  }

  const results = await Promise.all(
    vesselsMmsi.map((m) => fetchVessel(m, key, base).catch((e) => ({ mmsi: m, ok: false, error: e.message })))
  );

  const vessels = results.map((v) => {
    if (!v.ok || v.lat == null || v.lon == null) {
      return { mmsi: v.mmsi, name: v.name || '', kind: vesselKind(v.name), ok: false, error: v.error || 'no_position' };
    }
    const distKm = Math.round(distanceKm(v.lat, v.lon, port.lat, port.lon));
    const brgToPort = bearing(v.lat, v.lon, port.lat, port.lon);
    const cog = v.cog == null ? null : Number(v.cog);
    // "in avvicinamento" se si muove (>2 nodi) e la rotta punta verso il porto (±55°)
    const diff = cog == null ? 999 : Math.min(Math.abs(cog - brgToPort), 360 - Math.abs(cog - brgToPort));
    const moving = (v.sog ?? 0) > 2;
    const approaching = moving && diff <= 55;
    const atPort = distKm <= 3 && (v.sog ?? 0) < 1.5;
    // ETA stimata dalla distanza/velocità se in avvicinamento (1 nodo = 1.852 km/h)
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
      timestamp: v.timestamp,
    };
  });

  const payload = { ok: true, port, vessels, configured: true, generatedAt: new Date().toISOString() };
  _cache = { at: Date.now(), payload };
  return payload;
}
