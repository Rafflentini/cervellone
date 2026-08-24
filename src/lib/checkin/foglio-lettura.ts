/**
 * src/lib/checkin/foglio-lettura.ts
 *
 * Legge dal foglio cio' che il form e il calcolo devono sapere: le unita', i
 * parametri dell'imposta, le tabelle dei codici.
 *
 * Il punto di tutto questo e' che quei valori NON stanno nel codice. Quando il
 * Comune cambia una tariffa o l'Ingegnere rinomina un appartamento, si modifica
 * una cella — non si rilascia una versione. Percio' qui non ci sono costanti
 * che duplichino il Config: ci sono solo i ripieghi per quando una cella e'
 * vuota, e ognuno e' dichiarato.
 */

import { getSheets } from '../drive'
import { REGOLE_MARATEA, type RegoleImposta } from './imposta-soggiorno'
import { SCHEDA_CONFIG, SCHEDA_TABELLE, FOGLIO_CHECKIN_ID } from './foglio-schema'

export type Config = Record<string, string>

export async function leggiConfig(spreadsheetId: string = FOGLIO_CHECKIN_ID): Promise<Config> {
  const sheets = await getSheets()
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `'${SCHEDA_CONFIG}'!A:B`,
  })
  const righe = res.data.values ?? []
  const cfg: Config = {}
  for (const r of righe.slice(1)) {
    const chiave = String(r?.[0] ?? '').trim()
    if (chiave) cfg[chiave] = String(r?.[1] ?? '').trim()
  }
  return cfg
}

/** Numero dal Config, o il ripiego se la cella e' vuota o illeggibile. */
function num(cfg: Config, chiave: string, ripiego: number): number {
  const v = Number(String(cfg[chiave] ?? '').replace(',', '.'))
  return Number.isFinite(v) && String(cfg[chiave] ?? '').trim() !== '' ? v : ripiego
}

function testo(cfg: Config, chiave: string, ripiego: string): string {
  const v = String(cfg[chiave] ?? '').trim()
  return v || ripiego
}

/**
 * I ripieghi sono i valori di REGOLE_MARATEA, cioe' quelli scritti nel Config
 * alla creazione. Servono solo se qualcuno svuota una cella: meglio calcolare
 * con la regola nota che con zero, perche' zero vuol dire "nessuna imposta" e
 * sarebbe un ammanco silenzioso verso il Comune.
 */
export function regoleDaConfig(cfg: Config): RegoleImposta {
  return {
    tariffa: num(cfg, 'tassa_importo', REGOLE_MARATEA.tariffa),
    maxPernottamenti: num(cfg, 'tassa_max_notti', REGOLE_MARATEA.maxPernottamenti),
    esenzioneEtaMax: num(cfg, 'esenzione_eta_max', REGOLE_MARATEA.esenzioneEtaMax),
    stagioneDal: testo(cfg, 'tassa_stagione_dal', REGOLE_MARATEA.stagioneDal),
    stagioneAl: testo(cfg, 'tassa_stagione_al', REGOLE_MARATEA.stagioneAl),
    inVigoreDal: testo(cfg, 'tassa_in_vigore_dal', REGOLE_MARATEA.inVigoreDal),
  }
}

export function unitaDaConfig(cfg: Config): string[] {
  return String(cfg.unita ?? '')
    .split('|')
    .map((u) => u.trim())
    .filter(Boolean)
}

export interface VoceTabella {
  denominazione: string
  provincia: string
  catastale: string
  alloggiati: string
  tipo: string
}

export async function leggiTabelle(spreadsheetId: string = FOGLIO_CHECKIN_ID): Promise<VoceTabella[]> {
  const sheets = await getSheets()
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `'${SCHEDA_TABELLE}'!A:E`,
  })
  return (res.data.values ?? []).slice(1)
    .filter((r) => String(r?.[0] ?? '').trim())
    .map((r) => ({
      denominazione: String(r[0] ?? '').trim(),
      provincia: String(r[1] ?? '').trim(),
      catastale: String(r[2] ?? '').trim().toUpperCase(),
      alloggiati: String(r[3] ?? '').trim(),
      tipo: String(r[4] ?? '').trim().toUpperCase(),
    }))
}

/** Confronto insensibile ad accenti, spazi e maiuscole. */
export function chiaveLuogo(s: string): string {
  return String(s || '')
    .toUpperCase()
    .replace(/[ÀÁÂÃÄÅ]/g, 'A').replace(/[ÈÉÊË]/g, 'E').replace(/[ÌÍÎÏ]/g, 'I')
    .replace(/[ÒÓÔÕÖ]/g, 'O').replace(/[ÙÚÛÜ]/g, 'U')
    .replace(/[^A-Z0-9]/g, '')
}

/** Cercatore di codici catastali costruito una volta sulle righe gia' lette. */
export function cercatoreCatastale(voci: VoceTabella[]): (luogo: string) => string {
  const indice = new Map<string, string>()
  for (const v of voci) if (v.catastale) indice.set(chiaveLuogo(v.denominazione), v.catastale)
  return (luogo: string) => indice.get(chiaveLuogo(luogo)) ?? ''
}
