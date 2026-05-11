# Pratica — Backend

Server proxy verso il portale **CARGOS** della Polizia di Stato per la comunicazione obbligatoria dei contratti di noleggio veicoli senza conducente (D.L. 113/2018 art. 17, D.M. 29/10/2021).

Pensato per girare in un container al banco dell'agenzia, su un piccolo VPS o su un Raspberry Pi 4. Una sola agenzia → SQLite e via. Multi-agenzia → swap del driver verso Postgres in `db/index.js`.

---

## Cosa fa

- **Valida** ogni pratica contro il tracciato CARGOS prima dell'invio (46 campi, regole cross-field comprese).
- **Invia** a `https://cargos.poliziadistato.it/CARGOS_API` con gestione token, retry esponenziale, idempotenza per `CONTRATTO_ID`.
- **Distingue** auto da motoveicoli: solo le auto vanno a CARGOS (gli scooter sono esclusi per legge).
- **Conserva** ricevute digitali per 7 anni come da norma, cifrate con AES-256-GCM.
- **Genera** il CSV nel formato accettato dalle Questure via PEC quando il portale è giù.
- **Audit log immutabile** di ogni azione: chi ha inviato cosa, quando, con quale esito.

---

## Endpoint

| Metodo | Path | Descrizione |
|---|---|---|
| `POST` | `/api/auth/login` | Scambia OTP operatore per sessione CARGOS |
| `GET` | `/api/health` | Liveness + raggiungibilità portale |
| `POST` | `/api/contracts/check` | Validazione dry-run (locale + opzionalmente CED via `?ced=true`) |
| `POST` | `/api/contracts?mode=sync\|async` | Crea + invia contratto |
| `GET` | `/api/contracts?status=…&since=…` | Lista pratiche |
| `GET` | `/api/contracts/:id` | Dettaglio (decifrato) |
| `POST` | `/api/contracts/:id/retry` | Reinvia un fallito |
| `GET` | `/api/contracts/:id/csv` | Esporta singola pratica come CSV CARGOS |
| `POST` | `/api/contracts/csv-batch` | CSV multi-pratica per fallback PEC |
| `GET` | `/api/tables/:id` | Tabelle di riferimento (luoghi, tipo doc) cached |

---

## Setup rapido

```bash
# 1. Genera la chiave di cifratura (UNA VOLTA SOLA, conservala in cassaforte)
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

# 2. Configura ambiente
cp .env.example .env
$EDITOR .env

# 3. Avvia in dev
npm install
npm run dev

# 4. Produzione (Docker)
docker build -t pratica-backend .
docker run -d \
  --name pratica \
  --restart unless-stopped \
  -p 3000:3000 \
  --env-file .env \
  -v pratica_data:/app/data \
  pratica-backend
```

---

## Credenziali CARGOS

Le credenziali si richiedono alla **Questura competente sulla sede legale** della società di noleggio (non quella dove si svolge l'attività, se diversa). Documentazione necessaria:

- modulo di adesione firmato dal legale rappresentante
- copia documento d'identità del legale rappresentante  
- SCIA presentata al Comune della sede legale
- tutto via PEC, in un unico PDF

Tempo di rilascio: 30 giorni dalla pratica completa. L'autenticazione è a 2 fattori: username + password modificabile + OTP per sessione.

> Le credenziali sono **personali e non cedibili**. Quelle per l'azienda vanno usate dal legale rappresentante o da incaricati formalmente designati. Mai condividerle in chat, log, screenshot.

---

## Architettura: perché alcune scelte

**SQLite, non Postgres.** Una singola agenzia processa al massimo 500 pratiche/giorno. SQLite gestisce questo carico senza alzare un dito, sta in un singolo file (backup = `cp`), non richiede servizi accessori. L'unico motivo per passare a Postgres è multi-tenancy o flotte con centinaia di filiali.

**PII cifrata at rest.** I contratti contengono numero documento, indirizzo, cittadinanza. GDPR Art. 32 richiede misure tecniche adeguate. AES-256-GCM con chiave fuori dal database significa che il file `.db` da solo è inutile a un attaccante. Costo: la chiave non si può perdere — meglio conservarla anche in un password manager aziendale.

**Worker async per gli invii.** Il banco non può aspettare 30 secondi per un timeout di rete. La pratica viene salvata localmente in `pending`, l'operatore va avanti col cliente successivo, il worker invia in background con retry crescente (0s → 30s → 2m → 10m → 30m). Dopo 5 tentativi falliti si arrende e marca l'errore — l'operatore decide se reinviare o usare il CSV/PEC.

**Idempotenza per `CONTRATTO_ID`.** Se per un blip di rete il client ritrasmette, il backend riconosce l'ID già processato e restituisce la ricevuta esistente invece di creare un duplicato sul portale. Senza questo, un click doppio = doppio record alla Polizia.

**Auto vs moto separati alla sorgente.** Il backend rifiuta di inviare a CARGOS un record con `VEICOLO_TIPO=M`. Sembra paranoia ma è doppia difesa: anche se il frontend si confonde, il backend non manda dati che non dovrebbero partire. Riduce gli "scivoloni normativi" a zero.

**Cache delle tabelle di riferimento (TTL 7 giorni).** Comuni, stati esteri, tipi documento — non cambiano spesso. Cache locale evita di ciucciare il portale ad ogni nuovo contratto e rende l'app utilizzabile anche in caso di rallentamento del CED.

---

## Cosa deve fare il frontend

```js
// Esempio: invio sincrono di una pratica auto
const res = await fetch('/api/contracts?mode=sync', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'X-Operator-Id': 'elena.rossi',
  },
  body: JSON.stringify({
    CONTRATTO_ID: 'PR-2026-0423',
    CONTRATTO_DATA: '08/05/2026 16:42',
    CONTRATTO_TIPOP: 'C',
    // ...resto del tracciato
  }),
});

const { ok, status, receipt, errors } = await res.json();
```

Per validazione live al banco senza creare la pratica, usare `POST /api/contracts/check`. È gratis (solo locale) a meno di passare `?ced=true` per il check sul CED.

---

## In caso di disservizio del portale

1. L'operatore vede lo stato CARGOS rosso nella UI (proviene da `/api/health`).
2. Le pratiche restano in stato `error` o `pending` (il worker continua a riprovare).
3. Per essere sicuri di rispettare il "congruo anticipo" prescritto dalla norma, l'operatore può esportare le pratiche del giorno via `POST /api/contracts/csv-batch` e inviarle alla Questura via PEC.
4. La risposta contiene: nome file conforme, oggetto PEC suggerito, indirizzo PEC della Questura, contenuto CSV in base64.
5. Quando il portale torna su, il worker drena la coda automaticamente. Le pratiche già notificate via PEC vanno marcate manualmente come `sent` per evitare il doppio invio.

> **Nota**: la maggioranza delle Questure (Brescia, Massa Carrara, Milano…) accetta esplicitamente questa modalità con oggetto del tipo `CONTRATTI DI NOLEGGIO gg/mm/aaaa NOMESOCIETA`. Verificare con la propria.

---

## Conservazione e privacy

| Dato | Durata | Base normativa |
|---|---|---|
| Pratiche e ricevute digitali | 7 anni | Conservazione documentale civilistica/fiscale |
| Audit log | 7 anni | D.M. 29/10/2021 §4.3 |
| Token CARGOS | fino a scadenza naturale | sicurezza operativa |
| Tabelle di riferimento | TTL 7 giorni | cache di servizio |

Per cancellazioni GDPR (diritto all'oblio): la richiesta dell'interessato va valutata caso per caso — i dati delle pratiche già notificate alla Polizia non sono cancellabili dal lato pubblico (il CED li conserva secondo le proprie regole), ma la copia operativa locale può esserlo decorsi i termini di conservazione civilistica.

---

## Roadmap

- [ ] Webhook in uscita (notifica al CRM aziendale alla conferma invio)
- [ ] SSE / WebSocket per stato pratiche in tempo reale (sostituisce il polling)
- [ ] Integrazione SMTP per spedizione PEC automatizzata (richiede gestore PEC con API: Aruba, Namirial)
- [ ] OCR documenti server-side (per chi non vuole/può fare la scansione client)
- [ ] Multi-agenzia (Postgres + tabella `agencies`)
- [ ] Rotazione chiave di cifratura

---

## Licenza

MIT — adattabile, riusabile, da migliorare.
