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
  // Aliscafo Liberty Lines — Linosa ⇄ Lampedusa (Gianluca M)
  {
    id: 'll-linosa-lmp', vessel: 'Gianluca M', operator: 'Liberty Lines', kind: 'aliscafo',
    fromName: 'Linosa', toName: 'Lampedusa', mmsi: '247090600',
    days: 'daily', depart: '08:30', arrive: '09:30', indicative: true,
  },
  {
    id: 'll-lmp-linosa', vessel: 'Gianluca M', operator: 'Liberty Lines', kind: 'aliscafo',
    fromName: 'Lampedusa', toName: 'Linosa', mmsi: '247090600',
    days: 'daily', depart: '16:30', arrive: '17:30', indicative: true,
  },
  // Aliscafo Liberty Lines — Porto Empedocle ⇄ Linosa ⇄ Lampedusa (Adriana M, stagionale)
  {
    id: 'll-pe-lmp', vessel: 'Adriana M', operator: 'Liberty Lines', kind: 'aliscafo',
    fromName: 'Porto Empedocle', toName: 'Lampedusa', mmsi: '247413000',
    days: 'daily', depart: '14:00', arrive: '18:30', indicative: true,
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

export const _internal = { DEFAULT_SERVICES, romeWallToUtcIso };
