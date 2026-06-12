// ═══════════════════════════════════════════════════════════════════
// AVVISI Liberty Lines (corse sospese / variazioni) filtrati per le PELAGIE.
// Fonte: pagina pubblica https://www.libertylines.it/avvisi/ — lista HTML
// statica WordPress. Verificato il 12/6/2026: niente RSS, /wp-json/wp/v2/posts
// vuoto → il parsing leggero dei titoli <h2|h3><a> è l'unica via; il dettaglio
// di ogni avviso viene scaricato per capire se riguarda Lampedusa/Linosa.
// (Caronte & Tourist carica gli avvisi via JavaScript → NON integrabile in modo
// affidabile senza browser headless; documentato, non tentato.)
//
// Robustezza: timeout 12s · cache lista 20 min · cache dettaglio 6h per URL ·
// qualsiasi errore → ultima lista buona (o []) — /api/navi non si rompe MAI per
// colpa degli avvisi.
// ═══════════════════════════════════════════════════════════════════
const LIST_URL = 'https://www.libertylines.it/avvisi/';
const KEYWORDS = /lampedusa|linosa|pelagie/i;
const LIST_TTL_MS = 20 * 60 * 1000;
const DETAIL_TTL_MS = 6 * 60 * 60 * 1000;
const MAX_AVVISI = 8;

let _list = { at: 0, items: [] };
const _details = new Map(); // url → { at, text }

async function fetchText(url, timeoutMs = 12000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      // NB: UA "bot-like" (es. "compatible; nome-bot") → 403 dal WAF del sito (verificato 12/6).
      headers: {
        'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
        accept: 'text/html',
        'accept-language': 'it-IT,it;q=0.9',
      },
    });
    if (!res.ok) throw new Error('http_' + res.status);
    return await res.text();
  } finally {
    clearTimeout(t);
  }
}

function stripHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&#8211;|&ndash;/gi, '–')
    .replace(/&#8217;|&rsquo;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

async function detailText(url) {
  const hit = _details.get(url);
  if (hit && Date.now() - hit.at < DETAIL_TTL_MS) return hit.text;
  const html = await fetchText(url);
  // SOLO il corpo dell'articolo: il tema (Elementor) lo mette in
  // .elementor-widget-theme-post-content (verificato 12/6) — prima del container
  // c'è il menu che ELENCA gli avvisi recenti → matchare lì = falsi positivi.
  const i = html.indexOf('elementor-widget-theme-post-content');
  const j = i >= 0 ? html.indexOf('>', i) + 1 : 0; // dal primo '>' dopo la classe (slice a metà tag = residui)
  const body = html.slice(j, j + 8000);
  const text = stripHtml(body).slice(0, 4000);
  _details.set(url, { at: Date.now(), text });
  if (_details.size > 50) _details.delete(_details.keys().next().value);
  return text;
}

export async function getAvvisiPelagie() {
  if (Date.now() - _list.at < LIST_TTL_MS) return _list.items;
  try {
    const html = await fetchText(LIST_URL);
    const anchors = [...html.matchAll(/<h[23][^>]*>\s*<a[^>]+href="([^"]+)"[^>]*>([^<]+)<\/a>/g)].slice(0, MAX_AVVISI);
    const out = [];
    for (const [, url, rawTitle] of anchors) {
      const title = stripHtml(rawTitle);
      let text = '';
      try { text = await detailText(url); } catch { /* dettaglio ko → giudica dal titolo */ }
      if (!KEYWORDS.test(title) && !KEYWORDS.test(text)) continue;
      // estratto: la finestra di testo attorno alla prima keyword
      let excerpt = null;
      const k = text.search(KEYWORDS);
      if (k >= 0) excerpt = ('…' + text.slice(Math.max(0, k - 100), k + 180).trim() + '…');
      const dateM = title.match(/(\d{2})\/(\d{2})\/(\d{4})/) || text.match(/(\d{2})\/(\d{2})\/(\d{4})/);
      out.push({
        title,
        url,
        date: dateM ? `${dateM[3]}-${dateM[2]}-${dateM[1]}` : null,
        excerpt,
        operator: 'Liberty Lines',
      });
    }
    _list = { at: Date.now(), items: out };
    return out;
  } catch {
    return _list.items || []; // pagina giù/cambiata → degrada in silenzio
  }
}
