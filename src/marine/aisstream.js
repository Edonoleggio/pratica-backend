// ═══════════════════════════════════════════════════════════════════
// AISStream.io — sorgente AIS LIVE gratuita (WebSocket).
// Sostituisce VesselAPI (quota free minuscola → http_429). AISStream è
// gratuito e in tempo reale: ci si connette, ci si abbona a un'area + MMSI,
// si raccolgono le posizioni per qualche secondo e si chiude.
//
// Richiede una chiave gratuita (env AISSTREAM_KEY) da https://aisstream.io
// (login GitHub → genera API key). Nessuna carta di credito.
//
// undici (già dipendenza) espone WebSocket anche su Node 20.
// ═══════════════════════════════════════════════════════════════════
import { WebSocket } from 'undici';
import { logger } from '../logger.js';

const ENDPOINT = 'wss://stream.aisstream.io/v0/stream';
// Riquadro Sicilia ⇄ Pelagie (cattura le navi anche in rotta, non solo al porto).
// AISStream vuole due angoli [[lat,lon],[lat,lon]].
const DEFAULT_BBOX = [[34.8, 11.7], [37.8, 14.4]];

// Raccoglie le ultime posizioni dei MMSI dati ascoltando lo stream per windowMs.
// Risolve SEMPRE (mai reject): { ok, vessels: [{mmsi,name,lat,lon,sog,cog,navStatus,timestamp}], error? }
export function fetchAisStreamVessels(mmsis, key, { boundingBox = DEFAULT_BBOX, windowMs = 9000 } = {}) {
  return new Promise((resolve) => {
    if (!key) { resolve({ ok: false, error: 'no_key', vessels: [] }); return; }
    const wanted = new Set((mmsis || []).map(String));
    const byMmsi = new Map();
    let settled = false;
    let ws;

    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { ws && ws.close(); } catch { /* noop */ }
      resolve({ ok: !error || byMmsi.size > 0, error: error || null, vessels: [...byMmsi.values()] });
    };

    const timer = setTimeout(() => finish(null), windowMs);

    try {
      ws = new WebSocket(ENDPOINT);
    } catch (e) {
      resolve({ ok: false, error: e.message, vessels: [] });
      return;
    }

    ws.addEventListener('open', () => {
      const sub = {
        APIKey: key,
        BoundingBoxes: [boundingBox],
        FilterMessageTypes: ['PositionReport', 'ShipStaticData'],
      };
      if (wanted.size) sub.FiltersShipMMSI = [...wanted];
      try { ws.send(JSON.stringify(sub)); } catch (e) { finish(e.message); }
    });

    ws.addEventListener('message', (ev) => {
      let msg;
      try { msg = JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString()); } catch { return; }
      if (msg?.error) { finish(msg.error); return; }   // chiave errata / abuso → esci
      const meta = msg?.MetaData || {};
      const mmsi = String(meta.MMSI || '');
      if (!mmsi) return;
      if (wanted.size && !wanted.has(mmsi)) return;
      const cur = byMmsi.get(mmsi) || { mmsi };
      const name = (meta.ShipName || '').trim();
      if (name) cur.name = name;
      if (msg.MessageType === 'PositionReport') {
        const pr = msg.Message?.PositionReport || {};
        const lat = pr.Latitude ?? meta.latitude;
        const lon = pr.Longitude ?? meta.longitude;
        if (typeof lat === 'number') cur.lat = lat;
        if (typeof lon === 'number') cur.lon = lon;
        if (typeof pr.Sog === 'number') cur.sog = pr.Sog;
        if (typeof pr.Cog === 'number') cur.cog = pr.Cog;
        if (pr.NavigationalStatus != null) cur.navStatus = pr.NavigationalStatus;
        cur.timestamp = meta.time_utc || new Date().toISOString();
      }
      byMmsi.set(mmsi, cur);
      // Se abbiamo già tutti i MMSI richiesti con posizione, chiudi prima.
      if (wanted.size && [...wanted].every((m) => byMmsi.get(m)?.lat != null)) finish(null);
    });

    ws.addEventListener('error', (ev) => { finish(ev?.message || 'ws_error'); });
    ws.addEventListener('close', () => finish(null));
  }).catch((e) => ({ ok: false, error: e.message, vessels: [] }));
}

export const _aisInternal = { DEFAULT_BBOX };
