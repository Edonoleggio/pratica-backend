// ═══════════════════════════════════════════════════════════════════
// CSV Fallback Generator
//
// When the CARGOS portal is unreachable, D.M. 29/10/2021 §4.3 allows
// transmission via PEC of a CSV file with the same tracciato structure.
// Each Questura accepts at the address listed in the agency's adesione.
//
// Format rules (from the official manual):
//   • Separator: pipe '|' (NOT comma — comma can appear in addresses)
//   • Encoding: UTF-8 with BOM (some Questura mail clients require BOM)
//   • Line terminator: CRLF
//   • One row per record, in the exact field order of the tracciato
//   • Empty optional fields → empty string (not "NULL")
//   • Header row: NOT included (raw data only)
//   • Date format identical to API: DD/MM/YYYY HH:MM
// ═══════════════════════════════════════════════════════════════════

// Ordered list of all 46 fields — order is normative
const FIELD_ORDER = [
  'CONTRATTO_ID',
  'CONTRATTO_DATA',
  'CONTRATTO_TIPOP',
  'CONTRATTO_CHECKOUT_DATA',
  'CONTRATTO_CHECKOUT_LUOGO_COD',
  'CONTRATTO_CHECKOUT_INDIRIZZO',
  'CONTRATTO_CHECKIN_DATA',
  'CONTRATTO_CHECKIN_LUOGO_COD',
  'CONTRATTO_CHECKIN_INDIRIZZO',
  'OPERATORE_ID',
  'AGENZIA_ID',
  'AGENZIA_NOME',
  'AGENZIA_LUOGO_COD',
  'AGENZIA_INDIRIZZO',
  'AGENZIA_RECAPITO_TEL',
  'VEICOLO_TIPO',
  'VEICOLO_MARCA',
  'VEICOLO_MODELLO',
  'VEICOLO_TARGA',
  'VEICOLO_COLORE',
  'VEICOLO_GPS',
  'VEICOLO_BLOCCOM',
  'CONDUCENTE_CONTRAENTE_COGNOME',
  'CONDUCENTE_CONTRAENTE_NOME',
  'CONDUCENTE_CONTRAENTE_NASCITA_DATA',
  'CONDUCENTE_CONTRAENTE_NASCITA_LUOGO_COD',
  'CONDUCENTE_CONTRAENTE_CITTADINANZA_COD',
  'CONDUCENTE_CONTRAENTE_RESIDENZA_LUOGO_COD',
  'CONDUCENTE_CONTRAENTE_RESIDENZA_INDIRIZZO',
  'CONDUCENTE_CONTRAENTE_DOCIDE_TIPO_COD',
  'CONDUCENTE_CONTRAENTE_DOCIDE_NUMERO',
  'CONDUCENTE_CONTRAENTE_DOCIDE_LUOGORIL_COD',
  'CONDUCENTE_CONTRAENTE_PATENTE_NUMERO',
  'CONDUCENTE_CONTRAENTE_PATENTE_LUOGORIL_COD',
  'CONDUCENTE_CONTRAENTE_RECAPITO',
  'CONDUCENTE2_COGNOME',
  'CONDUCENTE2_NOME',
  'CONDUCENTE2_NASCITA_DATA',
  'CONDUCENTE2_NASCITA_LUOGO_COD',
  'CONDUCENTE2_CITTADINANZA_COD',
  'CONDUCENTE2_DOCIDE_TIPO_COD',
  'CONDUCENTE2_DOCIDE_NUMERO',
  'CONDUCENTE2_DOCIDE_LUOGORIL_COD',
  'CONDUCENTE2_PATENTE_NUMERO',
  'CONDUCENTE2_PATENTE_LUOGORIL_COD',
  'CONDUCENTE2_RECAPITO',
];

const SEP = '|';
const EOL = '\r\n';
const BOM = '\uFEFF';

function escapeField(v) {
  if (v == null) return '';
  let s = String(v);
  // Strip the separator if it leaks into a free-text field (defensive — CARGOS spec
  // does not define quoting; safer to neutralize than to break parsing on the receiving side).
  if (s.includes(SEP)) s = s.replaceAll(SEP, '/');
  // Strip newlines from address fields
  s = s.replace(/[\r\n\t]+/g, ' ').trim();
  return s;
}

/**
 * Render a single record as a pipe-delimited line.
 */
export function renderLine(record) {
  return FIELD_ORDER.map((f) => escapeField(record[f])).join(SEP);
}

/**
 * Build the full CSV body for one or more records.
 * Returns a Buffer ready to be attached to a PEC.
 */
export function buildCsv(records) {
  const arr = Array.isArray(records) ? records : [records];
  if (arr.length === 0) throw new Error('No records to export');
  if (arr.length > 100) {
    throw new Error('Massimo 100 record per file (vincolo CARGOS); suddividere in più invii');
  }
  const body = arr.map(renderLine).join(EOL) + EOL;
  return Buffer.from(BOM + body, 'utf8');
}

/**
 * Build a file name following the convention seen in Questura instructions:
 *   CARGOS_<AGENZIA_ID>_<YYYYMMDD>_<HHMM>.csv
 */
export function buildFilename(agenziaId, when = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = `${when.getFullYear()}${pad(when.getMonth() + 1)}${pad(when.getDate())}_${pad(
    when.getHours(),
  )}${pad(when.getMinutes())}`;
  return `CARGOS_${agenziaId}_${stamp}.csv`;
}

/**
 * Build the suggested PEC subject line, per Questura convention:
 *   "CONTRATTI DI NOLEGGIO gg/mm/aaaa NOMESOCIETA"
 */
export function buildPecSubject(agenziaNome, when = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  const date = `${pad(when.getDate())}/${pad(when.getMonth() + 1)}/${when.getFullYear()}`;
  return `CONTRATTI DI NOLEGGIO ${date} ${agenziaNome.toUpperCase()}`;
}
