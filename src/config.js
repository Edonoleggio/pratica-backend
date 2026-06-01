// Centralized config — read once at boot, fail fast on missing required values.
import 'dotenv/config';

function required(name, fallback) {
  const v = process.env[name] ?? fallback;
  if (v === undefined || v === '') {
    throw new Error(`Missing required env var: ${name}`);
  }
  return v;
}

export const config = {
  port: parseInt(process.env.PORT || '3000', 10),
  env: process.env.NODE_ENV || 'development',
  logLevel: process.env.LOG_LEVEL || 'info',
  encryptionKey: required('ENCRYPTION_KEY'),
  allowedOrigins: (process.env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean),
  dbPath: process.env.DB_PATH || './data/pratica.db',
  cargos: {
    baseUrl: process.env.CARGOS_BASE_URL || 'https://cargos.poliziadistato.it/CARGOS_API',
    username: process.env.CARGOS_USERNAME || '',
    password: process.env.CARGOS_PASSWORD || '',
    otpSecret: process.env.CARGOS_OTP_SECRET || '',
  },
  agency: {
    id: process.env.AGENZIA_ID || '',
    nome: process.env.AGENZIA_NOME || '',
    luogoCod: parseInt(process.env.AGENZIA_LUOGO_COD || '0', 10),
    indirizzo: process.env.AGENZIA_INDIRIZZO || '',
    tel: process.env.AGENZIA_RECAPITO_TEL || '',
  },
  defaultOperatorId: process.env.OPERATORE_ID_DEFAULT || 'unknown',
  questuraPec: process.env.QUESTURA_PEC || '',
  // Segreto per proteggere il KV store di sync (GET/PUT /api/store/:key).
  // Se non impostato il check è disabilitato (retrocompatibilità). In produzione
  // può coincidere con BACKUP_SECRET — stessa variabile, stessa protezione.
  storeSecret: process.env.STORE_SECRET || process.env.BACKUP_SECRET || '',
  // RentMe: l'UUID azienda resta solo qui (env), non più nel codice del sito.
  rentme: {
    userId: process.env.RENTME_USER_ID || '',
    apiBase: process.env.RENTME_API_BASE || 'https://rentmealtervista.duckdns.org/api/rest',
  },
  // Google Drive: OAuth lato server (refresh token) per backup automatici senza popup.
  google: {
    clientId: process.env.GOOGLE_CLIENT_ID || '',
    clientSecret: process.env.GOOGLE_CLIENT_SECRET || '',
    redirectUri: process.env.GOOGLE_REDIRECT_URI || '',
    // Refresh token DURABILE (opzionale): se impostato, tiene Drive collegato anche
    // dopo i deploy (il free tier di Render azzera il disco/DB). Si ricava una volta
    // sola dopo il primo collegamento OAuth.
    refreshToken: process.env.GOOGLE_REFRESH_TOKEN || '',
    // Dove rimandare l'utente dopo il collegamento (il sito). Default: frontend Render.
    appUrl: process.env.APP_URL || 'https://pratica-frontend.onrender.com',
  },
  // Voli aeroporto Lampedusa — aggregatore multi-fonte (vedi flights/index.js).
  // Ogni fonte è attiva solo se la relativa chiave è presente.
  flights: {
    airportIcao: process.env.LAMPEDUSA_ICAO || 'LICD',
    airportIata: process.env.LAMPEDUSA_IATA || 'LMP',
    // FlightRadar24 API (separata dall'abbonamento da app): https://fr24api.flightradar24.com
    fr24Token: process.env.FR24_API_TOKEN || '',
    fr24BaseUrl: process.env.FR24_BASE_URL || 'https://fr24api.flightradar24.com',
    // AeroDataBox via RapidAPI
    aeroDataBoxKey: process.env.AERODATABOX_KEY || '',
    // AviationStack — stato REALE (atterrato/in volo/ritardo). Free tier con quota
    // molto bassa → cache interna lunga (default 60 min) per non esaurirla.
    aviationStackKey: process.env.AVIATIONSTACK_KEY || '',
    aviationStackCacheMin: parseInt(process.env.AVIATIONSTACK_CACHE_MIN || '60', 10),
    // OpenSky Network (OAuth2 client credentials; opzionale, fallback)
    openSky: {
      clientId: process.env.OPENSKY_CLIENT_ID || '',
      clientSecret: process.env.OPENSKY_CLIENT_SECRET || '',
    },
  },
  // Navi (traghetti/aliscafi) per Lampedusa — tracking AIS via VesselAPI.
  // Lista MMSI configurabile: default = traghetti Siremar Sansovino + Cossyra.
  marine: {
    vesselApiKey: process.env.VESSELAPI_KEY || '',
    vesselApiBase: process.env.VESSELAPI_BASE || 'https://api.vesselapi.com/v1',
    vesselsMmsi: (process.env.LAMPEDUSA_VESSELS_MMSI || '247387300,247010100')
      .split(',').map((s) => s.trim()).filter(Boolean),
    portLat: parseFloat(process.env.LAMPEDUSA_PORT_LAT || '35.4992'),
    portLon: parseFloat(process.env.LAMPEDUSA_PORT_LON || '12.6065'),
  },
};
