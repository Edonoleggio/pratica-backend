import { z } from 'zod';

// ═══════════════════════════════════════════════════════════════════
// Schema del record CARGOS
//
// I nomi dei campi seguono il tracciato ufficiale (UPPERCASE_SNAKE) — gli
// stessi usati da csv.js (FIELD_ORDER) e da client.js (sendRecords legge
// r.CONTRATTO_ID). Lo schema valida i campi obbligatori minimi e lascia
// passare il resto del tracciato con .passthrough(), così i 46 campi
// arrivano intatti a CSV e invio CARGOS senza essere strippati da zod.
//
// NOTA: le regole cross-field complete del tracciato (es. CONDUCENTE2_*
// obbligatorio se presente il secondo conducente, formati data DD/MM/YYYY,
// coerenza luogo/codice) vanno aggiunte qui quando il tracciato ufficiale
// della Questura è disponibile. Per ora si validano i campi essenziali.
// ═══════════════════════════════════════════════════════════════════

const nonEmpty = (msg) => z.string({ required_error: msg }).trim().min(1, msg);

export const cargosRecordSchema = z
  .object({
    CONTRATTO_ID: nonEmpty('CONTRATTO_ID obbligatorio'),
    VEICOLO_TIPO: nonEmpty('VEICOLO_TIPO obbligatorio (A=auto, M=motoveicolo)'),
    VEICOLO_TARGA: nonEmpty('Targa obbligatoria'),
    CONDUCENTE_CONTRAENTE_COGNOME: nonEmpty('Cognome conducente obbligatorio'),
    CONDUCENTE_CONTRAENTE_NOME: nonEmpty('Nome conducente obbligatorio'),
    CONDUCENTE_CONTRAENTE_DOCIDE_NUMERO: nonEmpty('Numero documento obbligatorio'),
  })
  // Preserva tutti gli altri campi del tracciato (CONTRATTO_*, AGENZIA_*,
  // VEICOLO_*, CONDUCENTE_CONTRAENTE_*, CONDUCENTE2_*) senza strip.
  .passthrough();

// Schema per gli aggiornamenti (rende opzionali anche i campi obbligatori)
export const cargosRecordUpdateSchema = cargosRecordSchema.partial().passthrough();

// Schema per la risposta della Polizia
export const cargosResponseSchema = z.object({
  success: z.boolean(),
  message: z.string(),
  protocollo: z.string().optional(),
});

// Funzione per formattare gli errori (necessaria per routes.js)
export const formatErrors = (zodError) => {
  return zodError.errors.map((err) => ({
    path: err.path.join('.'),
    message: err.message,
  }));
};
