// ═══════════════════════════════════════════════════════════════════
// ORARI traghetti/aliscafi Lampedusa — base "sempre presente", indipendente
// dall'AIS. Mostra arrivi/partenze previsti da tabella oraria.
//
// Gli orari sono CONFIGURABILI via env MARINE_TIMETABLE_JSON (JSON con lo
// stesso schema di DEFAULT_SERVICES). I default qui sono INDICATIVI (estate
// 2026, da confermare con Alessandra / sito armatore) e marcati indicative:true
// → il frontend mostra "orario indicativo".
//
// Schema servizio:
//   { id, vessel, operator, kind, fromName, toName, mmsi?,
//     days: 'daily' | [0..6] (0=domenica),
//     depart: 'HH:MM', arrive: 'HH:MM', arriveNextDay?: bool, indicative?: bool }
// ═══════════════════════════════════════════════════════════════════

const DEFAULT_SERVICES = [
  // Traghetto Siremar SANSOVINO — corsa NOTTURNA (orari confermati da Alessandra;
  // arrivo stimato sulla traversata ~9h30, Porto Empedocle⇄Lampedusa).
  {
    id: 'siremar-sansovino-arr', vessel: 'Sansovino', operator: 'Siremar', kind: 'traghetto',
    fromName: 'Porto Empedocle', toName: 'Lampedusa', mmsi: '247387300',
    days: 'daily', depart: '23:00', arrive: '08:30', arriveNextDay: true, indicative: false,
  },
  {
    id: 'siremar-sansovino-dep', vessel: 'Sansovino', operator: 'Siremar', kind: 'traghetto',
    fromName: 'Lampedusa', toName: 'Porto Empedocle', mmsi: '247387300',
    days: 'daily', depart: '11:00', arrive: '20:30', indicative: false,
  },
  // Traghetto Siremar COSSYRA — corsa DIURNA (orari confermati da Alessandra).
  {
    id: 'siremar-cossyra-arr', vessel: 'Cossyra', operator: 'Siremar', kind: 'traghetto',
    fromName: 'Porto Empedocle', toName: 'Lampedusa', mmsi: '247010100',
    days: 'daily', depart: '09:30', arrive: '19:00', indicative: false,
  },
  {
    id: 'siremar-cossyra-dep', vessel: 'Cossyra', operator: 'Siremar', kind: 'traghetto',
    fromName: 'Lampedusa', toName: 'Porto Empedocle', mmsi: '247010100',
    days: 'daily', depart: '20:00', arrive: '05:30', indicative: false,
  },
  // Aliscafi Liberty Lines — ORARI UFFICIALI "Isole Pelagie dal 1° giugno 2026"
  // Fonte: libertylines.it/wp-content/uploads/2026/04/Orari_Pelagie_1Giugno_rev23.04_compressed.pdf
  // (percorrenze dal PDF: LMP-Linosa 1h · Linosa-PE 3h · LMP-PE 4h15).
  // Giorni: celle bianche = tutti i giorni; celle arancio = Lun-Mer-Ven-Sab-Dom → [0,1,3,5,6].
  // NB: l'abbinamento NAVE⇄corsa non è nel PDF: Gianluca M/Adriana M restano dall'AIS
  // (nomi verificati live l'11/6) — il nome serve solo a etichettare il mezzo via MMSI.
  // Navetta Lampedusa ⇄ Linosa (tutti i giorni)
  {
    id: 'll-lmp-linosa-am', vessel: 'Gianluca M', operator: 'Liberty Lines', kind: 'aliscafo',
    fromName: 'Lampedusa', toName: 'Linosa', mmsi: '247090600',
    days: 'daily', depart: '09:15', arrive: '10:15', indicative: false,
  },
  {
    id: 'll-linosa-lmp-am', vessel: 'Gianluca M', operator: 'Liberty Lines', kind: 'aliscafo',
    fromName: 'Linosa', toName: 'Lampedusa', mmsi: '247090600',
    days: 'daily', depart: '10:30', arrive: '11:30', indicative: false,
  },
  {
    id: 'll-lmp-linosa-pm', vessel: 'Gianluca M', operator: 'Liberty Lines', kind: 'aliscafo',
    fromName: 'Lampedusa', toName: 'Linosa', mmsi: '247090600',
    days: 'daily', depart: '17:15', arrive: '18:15', indicative: false,
  },
  {
    id: 'll-linosa-lmp-pm', vessel: 'Gianluca M', operator: 'Liberty Lines', kind: 'aliscafo',
    fromName: 'Linosa', toName: 'Lampedusa', mmsi: '247090600',
    days: 'daily', depart: '18:30', arrive: '19:30', indicative: false,
  },
  // Corsa Porto Empedocle ⇄ Linosa ⇄ Lampedusa (Lun-Mer-Ven-Sab-Dom)
  {
    id: 'll-lmp-pe', vessel: 'Adriana M', operator: 'Liberty Lines', kind: 'aliscafo',
    fromName: 'Lampedusa', toName: 'Porto Empedocle (via Linosa)', mmsi: '247413000',
    days: [0, 1, 3, 5, 6], depart: '07:30', arrive: '11:45', indicative: false,
  },
  {
    id: 'll-pe-lmp', vessel: 'Adriana M', operator: 'Liberty Lines', kind: 'aliscafo',
    fromName: 'Porto Empedocle (via Linosa)', toName: 'Lampedusa', mmsi: '247413000',
    days: [0, 1, 3, 5, 6], depart: '14:30', arrive: '18:45', indicative: false,
  },
];

function loadServices() {
  const raw = process.env.MARINE_TIMETABLE_JSON;
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length) return parsed;
    } catch { /* JSON malformato → usa i default */ }
  }
  return DEFAULT_SERVICES;
}

// Offset minuti Europe/Rome per un istante (DST-aware) — come nel modulo voli.
function romeOffsetMinutes(date) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Europe/Rome', hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const p = {};
  dtf.formatToParts(date).forEach((x) => { p[x.type] = x.value; });
  const asUTC = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return (asUTC - date.getTime()) / 60000;
}
// Converte "YYYY-MM-DD" + "HH:MM" (ora locale Lampedusa) in ISO UTC.
function romeWallToUtcIso(dateISO, hhmm, addDays = 0) {
  const [h, mi] = hhmm.split(':').map(Number);
  const [Y, Mo, D] = dateISO.split('-').map(Number);
  const naive = Date.UTC(Y, Mo - 1, D + addDays, h, mi, 0);
  const off = romeOffsetMinutes(new Date(naive));
  return new Date(naive - off * 60000).toISOString();
}

function runsOn(service, jsDay) {
  if (service.days === 'daily' || !service.days) return true;
  if (Array.isArray(service.days)) return service.days.includes(jsDay);
  return true;
}

// Restituisce i servizi previsti per il giorno richiesto (arrivi+partenze),
// con orari assoluti ISO UTC, ordinati per orario rilevante.
export function getSchedule(dateISO) {
  const services = loadServices();
  const [Y, Mo, D] = dateISO.split('-').map(Number);
  const jsDay = new Date(Date.UTC(Y, Mo - 1, D)).getUTCDay();
  const out = [];
  for (const s of services) {
    if (!runsOn(s, jsDay)) continue;
    // Partenza che ARRIVA a Lampedusa oggi (per i notturni la partenza è ieri)
    const toLampedusa = (s.toName || '').toLowerCase().includes('lampedusa');
    const departISO = s.depart
      ? romeWallToUtcIso(dateISO, s.depart, (s.arriveNextDay && toLampedusa) ? -1 : 0)
      : null;
    const arriveISO = s.arrive
      ? romeWallToUtcIso(dateISO, s.arrive, 0)
      : null;
    out.push({
      id: s.id, vessel: s.vessel, operator: s.operator, kind: s.kind,
      fromName: s.fromName, toName: s.toName, mmsi: s.mmsi || null,
      direction: toLampedusa ? 'arrivo' : 'partenza',
      departISO, arriveISO, indicative: s.indicative !== false,
    });
  }
  // Ordina per l'orario rilevante (arrivo per gli arrivi, partenza per le partenze)
  out.sort((a, b) => {
    const ta = a.direction === 'arrivo' ? a.arriveISO : a.departISO;
    const tb = b.direction === 'arrivo' ? b.arriveISO : b.departISO;
    return new Date(ta || 0) - new Date(tb || 0);
  });
  return out;
}

// Mappa mmsi → { name, kind } dai servizi caricati (env o default): i NOMI delle
// navi sono noti dagli orari anche quando l'AIS non dà posizione (copertura
// terrestre scarsa a Lampedusa) — mai più "MMSI 247…" nudo in interfaccia.
export function getVesselNames() {
  const map = {};
  loadServices().forEach((s) => {
    if (s.mmsi && s.vessel && !map[String(s.mmsi)]) map[String(s.mmsi)] = { name: s.vessel, kind: s.kind || 'nave' };
  });
  return map;
}

export const _internal = { DEFAULT_SERVICES, romeWallToUtcIso };
