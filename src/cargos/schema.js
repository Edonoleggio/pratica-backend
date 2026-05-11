// ═══════════════════════════════════════════════════════════════════
// CARGOS Tracciato — Zod schema mirroring the official record format
// Source: https://cargos.poliziadistato.it/CARGOS_API/
// Reference: D.M. 29 ottobre 2021, Allegato A
// ═══════════════════════════════════════════════════════════════════
//
// Every field name, type, length, and obligatoriness is taken verbatim
// from the official spec. This schema is the single source of truth
// for what is allowed to leave this server toward CARGOS.
//
// Field IDs (0..45) preserved as comments for cross-reference with
// the official tracciato table.
//
// ═══════════════════════════════════════════════════════════════════

import { z } from 'zod';

// ─── Date format helpers ───
// CARGOS uses Italian date format. Two flavors:
//   "DD/MM/YYYY HH:MM"  — datetime (16 chars)
//   "DD/MM/YYYY"        — date only (10 chars)
const DATETIME_RE = /^(0[1-9]|[12]\d|3[01])\/(0[1-9]|1[0-2])\/\d{4} ([01]\d|2[0-3]):[0-5]\d$/;
const DATE_RE = /^(0[1-9]|[12]\d|3[01])\/(0[1-9]|1[0-2])\/\d{4}$/;

const cargosDateTime = z.string().regex(DATETIME_RE, {
  message: 'Formato richiesto: DD/MM/AAAA HH:MM',
});

const cargosDate = z.string().regex(DATE_RE, {
  message: 'Formato richiesto: DD/MM/AAAA',
});

// String with max length (trim + reject empty unless optional)
const str = (max, label) =>
  z
    .string()
    .trim()
    .min(1, `${label} obbligatorio`)
    .max(max, `${label}: massimo ${max} caratteri`);

// Optional string (empty allowed → coerced to null on serialization)
const strOpt = (max) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .or(z.literal(''))
    .transform((v) => (v === '' ? undefined : v));

// Codici tabellati: numerici interi, max 9 cifre
const tableCode = z.coerce
  .number()
  .int()
  .nonnegative()
  .max(999_999_999);

// Boolean as 0/1 int (CARGOS encodes flags this way)
const flagInt = z
  .union([z.literal(0), z.literal(1), z.boolean()])
  .transform((v) => (typeof v === 'boolean' ? (v ? 1 : 0) : v))
  .optional();

// ─── Reference codes (one-letter enums per spec) ───
export const TIPO_PAGAMENTO = z.enum(['C', 'B', 'T', 'A'], {
  errorMap: () => ({ message: 'Tipo pagamento: C(arta), B(onifico), T(contante), A(ltro)' }),
});

export const TIPO_VEICOLO = z.enum(['A', 'M'], {
  errorMap: () => ({ message: 'Tipo veicolo: A(uto) o M(otoveicolo)' }),
});

export const TIPO_DOCUMENTO = z.enum(['CI', 'PA', 'PT', 'PE', 'CIE'], {
  errorMap: () => ({
    message: 'Tipo doc: CI/CIE (carta id), PA (passaporto), PT (patente), PE (permesso)',
  }),
});

// ═══════════════════════════════════════════════════════════════════
// MAIN RECORD SCHEMA
// ═══════════════════════════════════════════════════════════════════

export const cargosRecordSchema = z
  .object({
    // ── 0–10: Contratto e operatore ──
    /* 0  */ CONTRATTO_ID: str(50, 'ID contratto'),
    /* 1  */ CONTRATTO_DATA: cargosDateTime,
    /* 2  */ CONTRATTO_TIPOP: TIPO_PAGAMENTO,
    /* 3  */ CONTRATTO_CHECKOUT_DATA: cargosDateTime,
    /* 4  */ CONTRATTO_CHECKOUT_LUOGO_COD: tableCode,
    /* 5  */ CONTRATTO_CHECKOUT_INDIRIZZO: str(150, 'Indirizzo ritiro'),
    /* 6  */ CONTRATTO_CHECKIN_DATA: cargosDateTime,
    /* 7  */ CONTRATTO_CHECKIN_LUOGO_COD: tableCode,
    /* 8  */ CONTRATTO_CHECKIN_INDIRIZZO: str(150, 'Indirizzo consegna'),
    /* 9  */ OPERATORE_ID: str(50, 'ID operatore'),
    /* 10 */ AGENZIA_ID: str(30, 'ID agenzia'),

    // ── 11–14: Agenzia ──
    /* 11 */ AGENZIA_NOME: str(70, 'Denominazione agenzia'),
    /* 12 */ AGENZIA_LUOGO_COD: tableCode,
    /* 13 */ AGENZIA_INDIRIZZO: str(150, 'Indirizzo agenzia'),
    /* 14 */ AGENZIA_RECAPITO_TEL: str(20, 'Telefono agenzia'),

    // ── 15–21: Veicolo ──
    /* 15 */ VEICOLO_TIPO: TIPO_VEICOLO,
    /* 16 */ VEICOLO_MARCA: str(50, 'Marca veicolo'),
    /* 17 */ VEICOLO_MODELLO: str(100, 'Modello veicolo'),
    /* 18 */ VEICOLO_TARGA: str(15, 'Targa').transform((v) => v.toUpperCase().replace(/\s+/g, '')),
    /* 19 */ VEICOLO_COLORE: strOpt(50),
    /* 20 */ VEICOLO_GPS: flagInt,
    /* 21 */ VEICOLO_BLOCCOM: flagInt,

    // ── 22–34: Conducente / Contraente ──
    /* 22 */ CONDUCENTE_CONTRAENTE_COGNOME: str(50, 'Cognome'),
    /* 23 */ CONDUCENTE_CONTRAENTE_NOME: str(30, 'Nome'),
    /* 24 */ CONDUCENTE_CONTRAENTE_NASCITA_DATA: cargosDate,
    /* 25 */ CONDUCENTE_CONTRAENTE_NASCITA_LUOGO_COD: tableCode,
    /* 26 */ CONDUCENTE_CONTRAENTE_CITTADINANZA_COD: tableCode,
    /* 27 */ CONDUCENTE_CONTRAENTE_RESIDENZA_LUOGO_COD: tableCode.optional(),
    /* 28 */ CONDUCENTE_CONTRAENTE_RESIDENZA_INDIRIZZO: strOpt(150),
    /* 29 */ CONDUCENTE_CONTRAENTE_DOCIDE_TIPO_COD: TIPO_DOCUMENTO,
    /* 30 */ CONDUCENTE_CONTRAENTE_DOCIDE_NUMERO: str(20, 'Numero documento'),
    /* 31 */ CONDUCENTE_CONTRAENTE_DOCIDE_LUOGORIL_COD: tableCode,
    /* 32 */ CONDUCENTE_CONTRAENTE_PATENTE_NUMERO: str(20, 'Numero patente'),
    /* 33 */ CONDUCENTE_CONTRAENTE_PATENTE_LUOGORIL_COD: tableCode,
    /* 34 */ CONDUCENTE_CONTRAENTE_RECAPITO: strOpt(20),

    // ── 35–45: Secondo conducente (block, all-or-nothing) ──
    /* 35 */ CONDUCENTE2_COGNOME: strOpt(50),
    /* 36 */ CONDUCENTE2_NOME: strOpt(30),
    /* 37 */ CONDUCENTE2_NASCITA_DATA: cargosDate.optional().or(z.literal('').transform(() => undefined)),
    /* 38 */ CONDUCENTE2_NASCITA_LUOGO_COD: tableCode.optional(),
    /* 39 */ CONDUCENTE2_CITTADINANZA_COD: tableCode.optional(),
    /* 40 */ CONDUCENTE2_DOCIDE_TIPO_COD: TIPO_DOCUMENTO.optional(),
    /* 41 */ CONDUCENTE2_DOCIDE_NUMERO: strOpt(20),
    /* 42 */ CONDUCENTE2_DOCIDE_LUOGORIL_COD: tableCode.optional(),
    /* 43 */ CONDUCENTE2_PATENTE_NUMERO: strOpt(20),
    /* 44 */ CONDUCENTE2_PATENTE_LUOGORIL_COD: tableCode.optional(),
    /* 45 */ CONDUCENTE2_RECAPITO: strOpt(20),
  })
  // ─── Cross-field rules from the official spec ───
  .refine(
    (d) => {
      // (*) "Indirizzo Residenza obbligatorio se presente Luogo di Residenza"
      if (d.CONDUCENTE_CONTRAENTE_RESIDENZA_LUOGO_COD != null) {
        return !!d.CONDUCENTE_CONTRAENTE_RESIDENZA_INDIRIZZO;
      }
      return true;
    },
    {
      path: ['CONDUCENTE_CONTRAENTE_RESIDENZA_INDIRIZZO'],
      message:
        "Indirizzo residenza obbligatorio quando è specificato il luogo di residenza (tracciato CARGOS, nota *)",
    },
  )
  .refine(
    (d) => {
      // (**) "Secondo conducente: considerato solo se TUTTI valorizzati"
      const c2Fields = [
        d.CONDUCENTE2_COGNOME,
        d.CONDUCENTE2_NOME,
        d.CONDUCENTE2_NASCITA_DATA,
        d.CONDUCENTE2_NASCITA_LUOGO_COD,
        d.CONDUCENTE2_CITTADINANZA_COD,
        d.CONDUCENTE2_DOCIDE_TIPO_COD,
        d.CONDUCENTE2_DOCIDE_NUMERO,
        d.CONDUCENTE2_DOCIDE_LUOGORIL_COD,
        d.CONDUCENTE2_PATENTE_NUMERO,
        d.CONDUCENTE2_PATENTE_LUOGORIL_COD,
      ];
      const someSet = c2Fields.some((v) => v != null && v !== '');
      const allSet = c2Fields.every((v) => v != null && v !== '');
      // If any c2 field is set, all required c2 fields must be set
      return !someSet || allSet;
    },
    {
      path: ['CONDUCENTE2_COGNOME'],
      message:
        'Secondo conducente: se compilato, tutti i campi obbligatori devono essere presenti, altrimenti il blocco viene scartato dal CED',
    },
  )
  .refine((d) => {
    // Checkout must precede checkin
    const parse = (s) => {
      const [date, time] = s.split(' ');
      const [dd, mm, yyyy] = date.split('/');
      const [hh, mi] = time.split(':');
      return new Date(+yyyy, +mm - 1, +dd, +hh, +mi).getTime();
    };
    return parse(d.CONTRATTO_CHECKOUT_DATA) < parse(d.CONTRATTO_CHECKIN_DATA);
  }, {
    path: ['CONTRATTO_CHECKIN_DATA'],
    message: 'La data di consegna deve essere successiva alla data di ritiro',
  });

/** @typedef {z.infer<typeof cargosRecordSchema>} CargosRecord */

// ═══════════════════════════════════════════════════════════════════
// BATCH SCHEMA
// Per spec: max 100 record per blocco, totale ≤ ~150KB
// ═══════════════════════════════════════════════════════════════════

export const cargosBatchSchema = z
  .array(cargosRecordSchema)
  .min(1, 'Almeno un record richiesto')
  .max(100, 'Massimo 100 record per invio (vincolo CARGOS)');

// ═══════════════════════════════════════════════════════════════════
// FRIENDLY ERRORS
// Converts Zod errors into a flat, operator-readable list
// ═══════════════════════════════════════════════════════════════════

export function formatErrors(zodError) {
  return zodError.errors.map((e) => ({
    field: e.path.join('.'),
    message: e.message,
  }));
}

// ═══════════════════════════════════════════════════════════════════
// PARTIAL SCHEMA
// For draft contracts saved as work-in-progress (no CARGOS validation yet)
// ═══════════════════════════════════════════════════════════════════

export const cargosDraftSchema = cargosRecordSchema.innerType?.()
  export const cargosRecordUpdateSchema = cargosRecordSchema.partial();
  : z.object({}).passthrough();
