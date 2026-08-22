/**
 * src/lib/societa.ts — le società per cui Cervellone tiene la contabilità.
 *
 * Registro in CODICE, non in database, per due motivi: cambia raramente ed è
 * revisionabile in una pull request; e i segreti non devono finire in una
 * tabella. Qui si dichiara QUALE variabile d'ambiente contiene il token,
 * mai il token.
 */

import { RESTRUKTURA } from '../v19/prompts/identita'

export type CodiceSocieta = 'restruktura' | 'larealestate'

export interface Societa {
  codice: CodiceSocieta
  denominazione: string
  piva: string
  /** Nome della variabile d'ambiente col token FIC. MAI il valore. */
  ficTokenEnv: string
  /** Nome della variabile d'ambiente con l'id azienda FIC. MAI il valore. */
  ficCompanyIdEnv: string
  googleAccount: string
  aliquotaIvaDefault: number
}

const REGISTRO: Record<CodiceSocieta, Societa> = {
  restruktura: {
    codice: 'restruktura',
    // Riusa la costante gia' esistente in src/v19/prompts/identita.ts:
    // due fonti per la stessa partita IVA prima o poi divergono.
    denominazione: RESTRUKTURA.ragioneSociale,
    piva: RESTRUKTURA.partitaIva,
    ficTokenEnv: 'FIC_ACCESS_TOKEN',
    ficCompanyIdEnv: 'FIC_COMPANY_ID',
    googleAccount: RESTRUKTURA.email,
    aliquotaIvaDefault: 22,
  },
  larealestate: {
    codice: 'larealestate',
    denominazione: 'LA REAL ESTATE SRLS',
    piva: '02232730768',
    ficTokenEnv: 'FIC_ACCESS_TOKEN_LAREALESTATE',
    ficCompanyIdEnv: 'FIC_COMPANY_ID_LAREALESTATE',
    googleAccount: 'larealestate.amministrazione@gmail.com',
    aliquotaIvaDefault: 10,
  },
}

/** Alias riconosciuti nel testo dell'utente. Minuscoli, senza punteggiatura. */
const ALIAS: Array<[RegExp, CodiceSocieta]> = [
  [/\breal\s*estate\b|\blarealestate\b/, 'larealestate'],
  [/\brestruktura\b/, 'restruktura'],
]

export function getSocieta(codice: CodiceSocieta): Societa {
  return REGISTRO[codice]
}

export function listaSocieta(): Societa[] {
  return Object.values(REGISTRO)
}

/**
 * Riconosce la società nominata in un testo. Ritorna null se il testo non la
 * nomina: NON deve indovinare, perché una deduzione sbagliata produce un
 * documento fiscale sbagliato senza avvisare nessuno.
 */
export function risolviSocieta(testo: string): CodiceSocieta | null {
  const t = (testo || '').toLowerCase()
  const trovati = ALIAS.filter(([re]) => re.test(t)).map(([, c]) => c)
  const unici = Array.from(new Set(trovati))
  return unici.length === 1 ? unici[0] : null
}
