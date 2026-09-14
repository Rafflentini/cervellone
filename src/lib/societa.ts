/**
 * src/lib/societa.ts — le società per cui Cervellone tiene la contabilità.
 *
 * Registro in CODICE, non in database, per due motivi: cambia raramente ed è
 * revisionabile in una pull request; e i segreti non devono finire in una
 * tabella. Qui si dichiara QUALE variabile d'ambiente contiene il token,
 * mai il token.
 *
 * ⚠️ NON aggiungere un campo per l'account Google: c'era (`googleAccount`),
 * tolto il 14 settembre 2026 (audit avversariale) perché senza un solo
 * chiamante era diventato una SECONDA copia degli stessi due indirizzi
 * dichiarati in `caselle.ts` — viva nel registro, morta nell'uso, la
 * situazione in cui questo repo ha già scritto la stessa verità in due posti
 * che poi divergono. La casella Google di una società si chiede a
 * `caselle.ts` (`caselleDiTrasporto`, `getCasella`), non a questo file.
 */

import { RESTRUKTURA } from '../v19/prompts/identita'

export type CodiceSocieta = 'restruktura' | 'larealestate'

export interface Societa {
  codice: CodiceSocieta
  denominazione: string
  piva: string
  /**
   * La sede da stampare sui documenti. Per Restruktura riusa ESATTAMENTE
   * `RESTRUKTURA.sedeLegale` (src/v19/prompts/identita.ts) — la stessa
   * costante gia' citata per denominazione/piva qui sotto: due fonti per lo
   * stesso dato prima o poi divergono, e infatti la sede di Restruktura si
   * trova scritta in due forme diverse altrove nel repo (v. Task 7 report).
   * Chi deve decidere la forma DEFINITIVA e' Raffaele, non questo commit.
   */
  sede: string
  /** Nome della variabile d'ambiente col token FIC. MAI il valore. */
  ficTokenEnv: string
  /** Nome della variabile d'ambiente con l'id azienda FIC. MAI il valore. */
  ficCompanyIdEnv: string
  aliquotaIvaDefault: number
  /**
   * Data di iscrizione al VIES (YYYY-MM-DD), oppure assente se non la
   * sappiamo.
   *
   * 🚨 Non e' un dato anagrafico qualsiasi: il reverse charge su un servizio
   * intracomunitario vale PERCHE' la societa' e' iscritta al VIES. Una fattura
   * estera ANTERIORE a questa data arriva con IVA italiana gia' esposta e NON
   * si integra affatto — si registra come un normale acquisto con IVA
   * detraibile. Un'autofattura costruita su di essa sarebbe un documento
   * illegittimo, quindi `compila_autofattura` la rifiuta.
   *
   * Assente = non lo sappiamo, e allora non si autofattura: qui il silenzio
   * non puo' valere «si'».
   */
  viesDal?: string
}

const REGISTRO: Record<CodiceSocieta, Societa> = {
  restruktura: {
    codice: 'restruktura',
    // Riusa la costante gia' esistente in src/v19/prompts/identita.ts:
    // due fonti per la stessa partita IVA prima o poi divergono.
    denominazione: RESTRUKTURA.ragioneSociale,
    piva: RESTRUKTURA.partitaIva,
    sede: RESTRUKTURA.sedeLegale,
    ficTokenEnv: 'FIC_ACCESS_TOKEN',
    ficCompanyIdEnv: 'FIC_COMPANY_ID',
    aliquotaIvaDefault: 22,
  },
  larealestate: {
    codice: 'larealestate',
    denominazione: 'LA REAL ESTATE SRLS',
    piva: '02232730768',
    sede: 'Via Civita 8, Maratea (PZ)',
    ficTokenEnv: 'FIC_ACCESS_TOKEN_LAREALESTATE',
    ficCompanyIdEnv: 'FIC_COMPANY_ID_LAREALESTATE',
    aliquotaIvaDefault: 10,
    // Detto dall'Ingegnere (fonte contabile) il 14 settembre 2026: da qui in
    // poi le commissioni Booking/Airbnb arrivano senza IVA e si integrano.
    // Prima di questa data riportano IVA italiana e NON si integrano.
    viesDal: '2026-07-22',
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
