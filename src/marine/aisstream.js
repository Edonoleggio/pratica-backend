// ═══════════════════════════════════════════════════════════════════
// AISStream.io — sorgente AIS LIVE gratuita (WebSocket).
//
// CONNESSIONE PERSISTENTE: una sola websocket sempre aperta che ascolta
// gli impulsi AIS delle navi richieste. Sostituisce la vecchia raccolta
// "a finestre" (22s ogni 3 min): con la copertura rada delle Pelagie gli
// impulsi sono sporadici e una finestra al 12% del tempo li perdeva quasi
// tutti; in più riconnettersi ~20 volte/ora faceva scattare il throttling
// del server (handshake rifiutato, "non-101" — visto live il 13/7/2026).
//
// Richiede una chiave gratuita (env AISSTREAM_KEY) da https://aisstream.io
// (login GitHub → genera API key). Nessuna carta di credito, nessuna quota.
//
// ⚠️ Trappola nota: con chiave RIFIUTATA il server droppa la connessione
// (close 1006) SENZA frame d'errore → il close va sempre riportato come
// errore `closed_<code>`, mai trattato come fine pulita.
//
// undici (già dipendenza) espone WebSocket anche su Node 20.
// ═══════════════════════════════════════════════════════════════════
import { WebSocket } from 'undici';

const ENDPOINT = 'wss://stream.aisstream.io/v0/stream';
// Riquadro Sicilia ⇄ Pelagie (cattura le navi anche in rotta, non solo al porto).
// AISStream vuole due angoli [[lat,lon],[lat,lon]].
const DEFAULT_BBOX = [[34.8, 11.7], [37.8, 14.4]];

const BACKOFF_MIN_MS = 5000;             // prima ri-connessione dopo 5s
const BACKOFF_MAX_MS = 10 * 60 * 1000;   // mai più rada di 10 min
const HEALTHY_MS = 60 * 1000;            // connessione durata >60s = sana → backoff riparte dal minimo
const IDLE_MS = 15 * 60 * 1000;          // 15 min senza NESSUN frame → socket morto silenzioso, riconnetti

// Apre e MANTIENE una connessione ad AISStream per i MMSI dati.
// - onUpdate({mmsi,name?,lat?,lon?,sog?,cog?,navStatus?,timestamp?}) a ogni impulso delle navi richieste
// - state() → diagnosi { connected, connectedAt, lastFrameAt, framesTotal, lastOwnAt, lastError, reconnects }
//   (framesTotal conta TUTTI i frame ricevuti, anche di altre navi: distingue
//   "stream vivo ma navi mute" da "abbonamento rotto/stream muto")
// - stop() chiude tutto (per i test).
export function startAisStreamPersistent(mmsis, key, { boundingBox = DEFAULT_BBOX, onUpdate, onLog } = {}) {
  const wanted = new Set((mmsis || []).map(String));
  const st = {
    connected: false, connectedAt: null,
    lastFrameAt: null, framesTotal: 0,
    lastOwnAt: null, lastError: key ? null : 'no_key',
    reconnects: 0,
  };
  let ws = null;
  let idleTimer = null;
  let backoff = BACKOFF_MIN_MS;
  let stopped = false;

  const log = (msg, extra) => { try { onLog && onLog(msg, extra); } catch { /* noop */ } };

  function connect() {
    if (stopped || !key) return;
    let done = false;                      // guardia per-connessione (error+close arrivano entrambi)
    let openedAt = 0;

    const fail = (why) => {
      if (done || stopped) return;
      done = true;
      clearTimeout(idleTimer);
      try { ws && ws.close(); } catch { /* noop */ }
      st.connected = false;
      st.lastError = why;
      st.reconnects += 1;
      // Backoff: riparte dal minimo solo se la connessione era durata (evita
      // il martellamento quando il server accetta e droppa subito).
      if (openedAt && Date.now() - openedAt > HEALTHY_MS) backoff = BACKOFF_MIN_MS;
      const wait = backoff;
      backoff = Math.min(backoff * 2, BACKOFF_MAX_MS);
      log(`aisstream: connessione persa (${why}), riprovo tra ${Math.round(wait / 1000)}s`, { why, wait });
      setTimeout(connect, wait);
    };

    const armIdle = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => fail('idle_no_frames'), IDLE_MS);
    };

    try {
      ws = new WebSocket(ENDPOINT);
    } catch (e) {
      fail(e.message);
      return;
    }

    ws.addEventListener('open', () => {
      openedAt = Date.now();
      const sub = {
        APIKey: key,
        BoundingBoxes: [boundingBox],
        FilterMessageTypes: ['PositionReport', 'ShipStaticData'],
      };
      if (wanted.size) sub.FiltersShipMMSI = [...wanted];
      try {
        ws.send(JSON.stringify(sub));
        st.connected = true;
        st.connectedAt = new Date().toISOString();
        st.lastError = null;
        armIdle();
      } catch (e) { fail(e.message); }
    });

    ws.addEventListener('message', (ev) => {
      st.framesTotal += 1;
      st.lastFrameAt = new Date().toISOString();
      armIdle();
      let msg;
      try { msg = JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString()); } catch { return; }
      if (msg?.error) { fail(String(msg.error)); return; }   // chiave errata / abuso → esci e riprova
      const meta = msg?.MetaData || {};
      const mmsi = String(meta.MMSI || '');
      if (!mmsi) return;
      if (wanted.size && !wanted.has(mmsi)) return;
      const upd = { mmsi };
      const name = (meta.ShipName || '').trim();
      if (name) upd.name = name;
      if (msg.MessageType === 'PositionReport') {
        const pr = msg.Message?.PositionReport || {};
        const lat = pr.Latitude ?? meta.latitude;
        const lon = pr.Longitude ?? meta.longitude;
        if (typeof lat === 'number') upd.lat = lat;
        if (typeof lon === 'number') upd.lon = lon;
        if (typeof pr.Sog === 'number') upd.sog = pr.Sog;
        if (typeof pr.Cog === 'number') upd.cog = pr.Cog;
        if (pr.NavigationalStatus != null) upd.navStatus = pr.NavigationalStatus;
        upd.timestamp = meta.time_utc || new Date().toISOString();
      }
      if (upd.lat != null || upd.name) {
        st.lastOwnAt = new Date().toISOString();
        try { onUpdate && onUpdate(upd); } catch { /* noop */ }
      }
    });

    ws.addEventListener('error', (ev) => { fail(ev?.message || ev?.error?.message || 'ws_error'); });
    // Chiusura = SEMPRE anomala per una connessione persistente (noi non chiudiamo mai).
    ws.addEventListener('close', (ev) => fail(`closed_${ev?.code || 'unknown'}`));
  }

  connect();
  return {
    state: () => ({ ...st }),
    stop: () => { stopped = true; clearTimeout(idleTimer); try { ws && ws.close(); } catch { /* noop */ } },
  };
}

export const _aisInternal = { DEFAULT_BBOX };
