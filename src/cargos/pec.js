// ═══════════════════════════════════════════════════════════════════
// PEC automatica — invio CARGOS via PEC (SMTP Aruba)
//
// PREDISPOSTO MA SPENTO DI DEFAULT. L'invio reale avviene SOLO se
// `PEC_AUTO_ENABLED === 'true'` su Render (interruttore generale) E le
// credenziali sono impostate. Questo evita di inviare PEC alla Questura
// per sbaglio durante la fase di predisposizione/test.
//
// Attivazione (più avanti): su Render impostare
//   PEC_AUTO_ENABLED=true
//   PEC_USER=edonoleggio@pec.it
//   PEC_PASS=<password casella PEC>
//   (PEC_SMTP_HOST/PORT hanno già i default Aruba: smtps.pec.aruba.it:465)
// e QUESTURA_PEC è già impostata (destinatario).
//
// NB: `nodemailer` è importato in modo LAZY (dynamic import) solo quando si
// invia/verifica davvero → se la dipendenza mancasse non si rischia un crash
// al boot del backend (lezione hotfix otplib #12).
// ═══════════════════════════════════════════════════════════════════

import { config } from '../config.js';
import { logger } from '../logger.js';
import { buildCsv, buildFilename, buildPecSubject } from './csv.js';

// Interruttore generale: l'invio reale è possibile SOLO se true.
export function isPecAutoEnabled() {
  return config.pec.autoEnabled === true;
}

// Le credenziali e il destinatario sono tutti presenti?
export function isPecConfigured() {
  const p = config.pec;
  return Boolean(p.host && p.port && p.user && p.pass && config.questuraPec);
}

let _transporter = null;
async function getTransporter() {
  if (_transporter) return _transporter;
  const nodemailer = (await import('nodemailer')).default;
  _transporter = nodemailer.createTransport({
    host: config.pec.host,
    port: config.pec.port,
    secure: config.pec.port === 465, // 465 = SSL/TLS implicito (Aruba PEC)
    auth: { user: config.pec.user, pass: config.pec.pass },
  });
  return _transporter;
}

// Verifica connessione + credenziali SMTP SENZA inviare nulla.
// Utile in fase di predisposizione per confermare che la casella PEC risponde.
export async function verifyPec() {
  if (!isPecConfigured()) return { ok: false, error: 'pec_non_configurata' };
  try {
    const t = await getTransporter();
    await t.verify();
    return { ok: true };
  } catch (err) {
    logger.warn({ err: err.message }, 'pec.verify.failed');
    return { ok: false, error: err.message };
  }
}

/**
 * Invia uno o più record CARGOS alla Questura via PEC, come CSV in allegato
 * (stesso tracciato/oggetto del fallback manuale già esistente).
 *
 * ⚠️ NON controlla l'interruttore: è responsabilità del chiamante verificare
 *    isPecAutoEnabled() prima (doppia sicurezza anti-invio accidentale).
 *
 * @param {object|object[]} records  payload CARGOS (uno o più)
 * @returns {Promise<{ok, messageId, accepted, filename, subject}>}
 */
export async function sendCargosPec(records, { when = new Date() } = {}) {
  if (!isPecConfigured()) {
    throw new Error('PEC non configurata (PEC_SMTP_HOST/PORT, PEC_USER, PEC_PASS, QUESTURA_PEC)');
  }
  const arr = Array.isArray(records) ? records : [records];
  const csv = buildCsv(arr); // riusa il generatore CSV (UTF-8+BOM, tracciato CARGOS)
  const filename = buildFilename(config.agency.id, when);
  const subject = buildPecSubject(config.agency.nome, when);
  const t = await getTransporter();
  const info = await t.sendMail({
    from: config.pec.user,
    to: config.questuraPec,
    subject,
    text:
      `In allegato il file CARGOS con ${arr.length} contratto/i di noleggio, ` +
      `trasmesso ai sensi del D.M. 29/10/2021.\n\n${config.agency.nome}`,
    attachments: [{ filename, content: csv, contentType: 'text/csv; charset=utf-8' }],
  });
  logger.info(
    { messageId: info.messageId, count: arr.length, to: config.questuraPec },
    'pec.sent',
  );
  return { ok: true, messageId: info.messageId, accepted: info.accepted, filename, subject };
}
