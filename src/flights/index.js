// ═══════════════════════════════════════════════════════════════════
// flights/ — Aggregatore voli per l'aeroporto di Lampedusa (LICD / LMP)
//
// Interroga PIÙ FONTI in parallelo, normalizza in uno schema comune, UNISCE
// e DEDUPLICA per numero di volo, con cache in memoria e fallback se una
// fonte è giù o non configurata.
//
// Fonti (ognuna attiva solo se le sue credenziali sono nelle env):
//   1. FlightRadar24 API   — primaria   (config.flights.fr24Token)
//   2. AeroDataBox (RapidAPI) — secondaria (config.flights.aeroDataBoxKey)
//   3. OpenSky Network     — fallback   (config.flights.openSky.* o anonimo)
//
// Schema normalizzato di un volo:
//   { flightNumber, airline, originIata, originIcao, originName,
//     scheduledArrival, estimatedArrival, actualArrival, status, sources[] }
// status ∈ scheduled | enroute | landed | delayed | cancelled | unknown
// ═══════════════════════════════════════════════════════════════════

import { config } from '../config.js';
import { logger } from '../logger.js';

const CACHE_TTL_MS = 10 * 60 * 1000;     // 10 minuti
const SOURCE_TIMEOUT_MS = 12000;          // timeout per singola fonte
const _cache = new Map();                 // key (date) → { at, payload }

const ICAO = () => config.flights.airportIcao || 'LICD';
const IATA = () => config.flights.airportIata || 'LMP';

// ─── Utilità ────────────────────────────────────────────────────────
function normFlightNo(s) {
  return (s || '').toString().toUpperCase().replace(/\s+/g, '').trim();
}
function dayWindowUtc(dateISO) {
  // Finestra generosa che copre l'intera giornata locale di Lampedusa (UTC+1/+2).
  // Da [date-1 22:00Z] a [date 22:00Z] ≈ giorno locale. Per semplicità usiamo
  // 00:00Z→24:00Z del giorno richiesto (sufficiente per una lista giornaliera).
  const from = new Date(`${dateISO}T00:00:00Z`);
  const to = new Date(`${dateISO}T23:59:59Z`);
  return { from, to };
}
function utcIso(s) {
  // Normalizza un datetime a ISO UTC. FR24 manda "2026-05-30T06:15:10" (UTC senza Z).
  if (!s) return null;
  const str = String(s).trim();
  if (/[zZ]$|[+-]\d{2}:?\d{2}$/.test(str)) return str;   // ha già tz
  return str.replace(' ', 'T') + 'Z';
}
function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error(`${label}_timeout`)), ms)),
  ]);
}

// ─── Fonte 1: FlightRadar24 API (flight-summary) ────────────────────
// Doc: https://fr24api.flightradar24.com/docs/endpoints/flight-summary
// NB: confermare param/endpoint col token reale; in caso di errore la fonte
// viene semplicemente saltata dall'aggregatore.
async function fetchFR24(dateISO) {
  const token = config.flights.fr24Token;
  if (!token) return { enabled: false };
  const base = config.flights.fr24BaseUrl || 'https://fr24api.flightradar24.com';
  const { from, to } = dayWindowUtc(dateISO);
  const params = new URLSearchParams({
    // FR24 vuole "YYYY-MM-DDTHH:mm:ss" UTC SENZA suffisso 'Z' (con 'Z' → HTTP 400).
    flight_datetime_from: from.toISOString().slice(0, 19),
    flight_datetime_to: to.toISOString().slice(0, 19),
    airports: `inbound:${ICAO()}`,   // arrivi a Lampedusa
  });
  const url = `${base}/api/flight-summary/light?${params.toString()}`;
  try {
    const r = await withTimeout(fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        'Accept-Version': 'v1',
      },
    }), SOURCE_TIMEOUT_MS, 'fr24');
    if (!r.ok) return { enabled: true, ok: false, error: `http_${r.status}`, flights: [] };
    const json = await r.json();
    const rows = json?.data || json?.flights || [];
    // Schema flight-summary/light: { flight, callsign, operating_as, painted_as,
    // orig_icao, datetime_takeoff, datetime_landed, ... }. I datetime sono UTC
    // SENZA suffisso 'Z' → lo aggiungiamo per farli interpretare come UTC.
    const flights = rows.map((f) => ({
      flightNumber: normFlightNo(f.flight || f.flight_number || f.callsign),
      airline: f.operating_as || f.painted_as || f.airline || '',
      originIata: f.orig_iata || f.origin_iata || '',
      originIcao: f.orig_icao || f.origin_icao || '',
      originName: f.orig_name || '',
      scheduledArrival: utcIso(f.datetime_scheduled_arrival || f.scheduled_arrival),
      estimatedArrival: utcIso(f.datetime_estimated_arrival || f.estimated_arrival),
      actualArrival: utcIso(f.datetime_landed || f.datetime_arrival),
      status: f.datetime_landed ? 'landed' : (f.datetime_takeoff ? 'enroute' : 'scheduled'),
      sources: ['fr24'],
    })).filter((f) => f.flightNumber || f.originIata || f.originIcao);
    return { enabled: true, ok: true, flights };
  } catch (err) {
    return { enabled: true, ok: false, error: err.message, flights: [] };
  }
}

// Normalizza lo stato AeroDataBox (Unknown/Expected/EnRoute/Approaching/
// Arrived/Departed/Delayed/Canceled/Diverted...) allo schema comune.
function mapAdbStatus(s) {
  const t = (s || '').toLowerCase();
  if (t.includes('cancel')) return 'cancelled';
  if (t.includes('arriv') || t.includes('land')) return 'landed';
  if (t.includes('divert')) return 'cancelled';
  if (t.includes('delay')) return 'delayed';
  if (t.includes('enroute') || t.includes('en route') || t.includes('approach') || t.includes('depart')) return 'enroute';
  return 'scheduled';   // Expected / Unknown / Scheduled
}

// ─── Fonte 2: AeroDataBox (RapidAPI) ────────────────────────────────
// GET /flights/airports/icao/{icao}/{from}/{to}?direction=Arrival
// Max 12h per chiamata → due chiamate per coprire la giornata.
async function fetchAeroDataBox(dateISO) {
  const key = config.flights.aeroDataBoxKey;
  if (!key) return { enabled: false };
  const host = 'aerodatabox.p.rapidapi.com';
  const fmt = (d) => d.toISOString().slice(0, 16);   // YYYY-MM-DDTHH:mm
  const halves = [
    [new Date(`${dateISO}T00:00:00Z`), new Date(`${dateISO}T11:59:00Z`)],
    [new Date(`${dateISO}T12:00:00Z`), new Date(`${dateISO}T23:59:00Z`)],
  ];
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  try {
    const all = [];
    for (let h = 0; h < halves.length; h++) {
      const [from, to] = halves[h];
      // Pausa tra le due chiamate: il free tier RapidAPI limita ~1 req/s.
      if (h > 0) await sleep(1300);
      const url = `https://${host}/flights/airports/icao/${ICAO()}/${fmt(from)}/${fmt(to)}`
        + `?direction=Arrival&withLeg=true&withCancelled=true&withCodeshared=false&withLocation=false`;
      const doFetch = () => withTimeout(fetch(url, {
        headers: { 'X-RapidAPI-Key': key, 'X-RapidAPI-Host': host },
      }), SOURCE_TIMEOUT_MS, 'adb');
      let r = await doFetch();
      if (r.status === 429) { await sleep(1500); r = await doFetch(); }   // retry una volta su rate-limit
      if (!r.ok) continue;
      const json = await r.json();
      for (const a of (json?.arrivals || [])) {
        const mv = a.arrival || a.movement || {};
        const sched = mv.scheduledTime || mv.scheduledTimeUtc || {};
        const est = mv.revisedTime || mv.predictedTime || {};
        all.push({
          flightNumber: normFlightNo(a.number),
          airline: a.airline?.name || '',
          originIata: a.departure?.airport?.iata || a.movement?.airport?.iata || '',
          originIcao: a.departure?.airport?.icao || a.movement?.airport?.icao || '',
          originName: a.departure?.airport?.name || a.movement?.airport?.name || '',
          scheduledArrival: sched.utc ? sched.utc.replace(' ', 'T') : (typeof sched === 'string' ? sched : null),
          estimatedArrival: est.utc ? est.utc.replace(' ', 'T') : null,
          actualArrival: null,
          status: mapAdbStatus(a.status),
          sources: ['aerodatabox'],
        });
      }
    }
    return { enabled: true, ok: true, flights: all };
  } catch (err) {
    return { enabled: true, ok: false, error: err.message, flights: [] };
  }
}

// ─── Fonte 3: OpenSky Network (fallback, solo voli atterrati) ───────
let _openSkyToken = null;
async function openSkyAuth() {
  const { clientId, clientSecret } = config.flights.openSky;
  if (!clientId || !clientSecret) return null;   // proverà anonimo
  if (_openSkyToken && _openSkyToken.exp > Date.now()) return _openSkyToken.value;
  const url = 'https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token';
  const body = new URLSearchParams({ grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret });
  const r = await withTimeout(fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body }), SOURCE_TIMEOUT_MS, 'opensky_auth');
  if (!r.ok) return null;
  const json = await r.json();
  _openSkyToken = { value: json.access_token, exp: Date.now() + (json.expires_in - 30) * 1000 };
  return _openSkyToken.value;
}
async function fetchOpenSky(dateISO) {
  const { from, to } = dayWindowUtc(dateISO);
  const begin = Math.floor(from.getTime() / 1000);
  const end = Math.floor(to.getTime() / 1000);
  const url = `https://opensky-network.org/api/flights/arrival?airport=${ICAO()}&begin=${begin}&end=${end}`;
  try {
    const token = await openSkyAuth();
    const headers = token ? { Authorization: `Bearer ${token}` } : {};
    const r = await withTimeout(fetch(url, { headers }), SOURCE_TIMEOUT_MS, 'opensky');
    if (!r.ok) return { enabled: true, ok: false, error: `http_${r.status}`, flights: [] };
    const rows = await r.json();
    const flights = (Array.isArray(rows) ? rows : []).map((f) => ({
      flightNumber: normFlightNo(f.callsign),
      airline: '',
      originIata: '',
      originIcao: f.estDepartureAirport || '',
      originName: '',
      scheduledArrival: null,
      estimatedArrival: null,
      actualArrival: f.lastSeen ? new Date(f.lastSeen * 1000).toISOString() : null,
      status: 'landed',
      sources: ['opensky'],
    })).filter((f) => f.flightNumber);
    return { enabled: true, ok: true, flights };
  } catch (err) {
    return { enabled: true, ok: false, error: err.message, flights: [] };
  }
}

// ─── Merge & dedup ──────────────────────────────────────────────────
function mergeFlights(lists) {
  const byKey = new Map();
  const pick = (a, b) => a || b;     // preferisci il primo valore non-nullo
  for (const f of lists.flat()) {
    const key = f.flightNumber
      || `${f.originIcao || f.originIata}|${(f.scheduledArrival || f.estimatedArrival || '').slice(0, 13)}`;
    if (!key) continue;
    const cur = byKey.get(key);
    if (!cur) { byKey.set(key, { ...f, sources: [...f.sources] }); continue; }
    byKey.set(key, {
      flightNumber: pick(cur.flightNumber, f.flightNumber),
      airline: pick(cur.airline, f.airline),
      originIata: pick(cur.originIata, f.originIata),
      originIcao: pick(cur.originIcao, f.originIcao),
      originName: pick(cur.originName, f.originName),
      scheduledArrival: pick(cur.scheduledArrival, f.scheduledArrival),
      estimatedArrival: pick(cur.estimatedArrival, f.estimatedArrival),
      actualArrival: pick(cur.actualArrival, f.actualArrival),
      // status: preferisci lo stato "più avanzato"
      status: rankStatus(f.status) > rankStatus(cur.status) ? f.status : cur.status,
      sources: [...new Set([...cur.sources, ...f.sources])],
    });
  }
  const order = { scheduled: 0, enroute: 1, delayed: 1, landed: 2, cancelled: 3, unknown: 0 };
  return [...byKey.values()].sort((a, b) => {
    const ta = a.estimatedArrival || a.scheduledArrival || a.actualArrival || '';
    const tb = b.estimatedArrival || b.scheduledArrival || b.actualArrival || '';
    return ta.localeCompare(tb);
  });
}
function rankStatus(s) {
  return ({ scheduled: 0, enroute: 1, delayed: 1, landed: 2, cancelled: 2, unknown: -1 })[s] ?? 0;
}

// ─── API pubblica ───────────────────────────────────────────────────
export async function getLampedusaArrivals(dateISO) {
  const date = dateISO || new Date().toISOString().slice(0, 10);
  const cached = _cache.get(date);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
    return { ...cached.payload, cached: true };
  }

  const [fr24, adb, opensky] = await Promise.all([
    fetchFR24(date).catch((e) => ({ enabled: true, ok: false, error: e.message, flights: [] })),
    fetchAeroDataBox(date).catch((e) => ({ enabled: true, ok: false, error: e.message, flights: [] })),
    fetchOpenSky(date).catch((e) => ({ enabled: true, ok: false, error: e.message, flights: [] })),
  ]);

  const flights = mergeFlights([fr24.flights || [], adb.flights || [], opensky.flights || []]);
  const openSkyHasCreds = !!(config.flights.openSky.clientId && config.flights.openSky.clientSecret);
  const sources = {
    fr24: { enabled: !!fr24.enabled, ok: !!fr24.ok, count: (fr24.flights || []).length, error: fr24.error },
    aerodatabox: { enabled: !!adb.enabled, ok: !!adb.ok, count: (adb.flights || []).length, error: adb.error },
    // OpenSky viene SEMPRE tentato (anche anonimo) ma lo consideriamo "configurato"
    // solo con credenziali OAuth2; resta un fallback per i voli atterrati.
    opensky: { enabled: openSkyHasCreds, ok: !!opensky.ok, count: (opensky.flights || []).length, error: opensky.error },
  };
  // "configured" = c'è almeno una chiave seria, oppure è arrivato qualche volo.
  const anyConfigured = !!config.flights.fr24Token || !!config.flights.aeroDataBoxKey
    || openSkyHasCreds || flights.length > 0;

  const payload = {
    ok: true,
    airport: { icao: ICAO(), iata: IATA(), name: 'Lampedusa' },
    date,
    flights,
    sources,
    configured: anyConfigured,
    generatedAt: new Date().toISOString(),
  };
  _cache.set(date, { at: Date.now(), payload });
  if (!anyConfigured) logger.warn('flights.no_source_configured');
  return payload;
}
