// ═══════════════════════════════════════════════════════════════════
// STRUTTURE da Google My Maps — il titolare tiene i segnaposto (strutture
// partner, punti di consegna) su una mappa My Maps condivisa "chiunque col
// link"; questo modulo legge il KML pubblico della mappa:
//   https://www.google.com/maps/d/kml?mid=<MID>&forcekml=1
// (meccanismo VERIFICATO il 12/6/2026 su una mappa pubblica: KML valido con
// <Placemark><name>/<coordinates>). Niente API key, niente OAuth.
//
// Env: MYMAPS_MID = l'id della mappa (il "mid=" del link di condivisione).
// Cache 10 min · timeout 12s · errori → ultimo buono o not_configured/fetch_error.
// Le liste di "luoghi salvati" personali di Google Maps NON hanno API: questa
// è l'unica via automatizzabile (documentato all'utente).
// ═══════════════════════════════════════════════════════════════════
const TTL_MS = 10 * 60 * 1000;
let _cache = { at: 0, payload: null };

function decodeXml(s) {
  return String(s || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export async function getMyMapsPlaces() {
  const mid = (process.env.MYMAPS_MID || '').replace(/\s/g, '');
  if (!mid) return { ok: false, error: 'not_configured' };
  if (_cache.payload && Date.now() - _cache.at < TTL_MS) return { ..._cache.payload, cached: true };

  const url = `https://www.google.com/maps/d/kml?mid=${encodeURIComponent(mid)}&forcekml=1`;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 12000);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36' },
    });
    if (!res.ok) throw new Error('http_' + res.status);
    const kml = await res.text();
    if (!kml.includes('<kml')) throw new Error('not_kml'); // mappa privata → pagina HTML di login
    const mapName = decodeXml((kml.match(/<Document>\s*<name>([\s\S]*?)<\/name>/) || [])[1] || '');
    const places = [...kml.matchAll(/<Placemark>([\s\S]*?)<\/Placemark>/g)].map(([, pm]) => {
      const nome = decodeXml((pm.match(/<name>([\s\S]*?)<\/name>/) || [])[1] || '');
      const descrizione = decodeXml((pm.match(/<description>([\s\S]*?)<\/description>/) || [])[1] || '');
      const c = pm.match(/<coordinates>\s*([\-0-9.]+),([\-0-9.]+)/); // KML = lon,lat
      return nome && c ? {
        nome,
        descrizione: descrizione || null,
        lng: Number(c[1]),
        lat: Number(c[2]),
      } : null;
    }).filter(Boolean);
    const payload = { ok: true, mapName, places, count: places.length, generatedAt: new Date().toISOString() };
    _cache = { at: Date.now(), payload };
    return payload;
  } catch (err) {
    if (_cache.payload) return { ..._cache.payload, cached: true, staleError: err.message };
    return { ok: false, error: 'fetch_error', detail: err.message };
  } finally {
    clearTimeout(t);
  }
}
