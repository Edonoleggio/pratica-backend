import { z } from 'zod';

// Schema base per i record CARGOS
export const cargosRecordSchema = z.object({
  customerName: z.string().min(1, "Nome obbligatorio"),
  documentNumber: z.string().min(1, "Documento obbligatorio"),
  vehiclePlate: z.string().min(1, "Targa obbligatoria"),
  timestamp: z.string().optional()
});

// Schema per gli aggiornamenti (rende tutti i campi opzionali)
export const cargosRecordUpdateSchema = cargosRecordSchema.partial();

// Schema per la risposta della Polizia
export const cargosResponseSchema = z.object({
  success: z.boolean(),
  message: z.string(),
  protocollo: z.string().optional()
});
