/**
 * src/lib/caselle.ts — le caselle di posta di Cervellone. Sono QUATTRO.
 *
 * ── Perche' esiste (14 settembre 2026) ──────────────────────────────────────
 * La segretaria deve poter leggere anche la posta de La Real Estate. La
 * credenziale OAuth c'era gia' (autorizzata e verificata alle 13:01); mancava
 * il codice che la usa: cinque punti aprivano un client Google con la societa'
 * CABLATA. Questo file ne chiude QUATTRO (drive.ts, calendar-tools.ts,
 * document-saver.ts, hallucination-validator.ts) — il quinto e' `gmail-tools.ts`,
 * dove `casella` e' un parametro obbligatorio delle funzioni di basso livello
 * (Task 2). I 16 tool `gmail_*` HANNO la scelta: in lettura guardano tutte le
 * caselle Google per difetto e dicono da quale viene ogni risultato (Task 3),
 * in scrittura la casella e' obbligatoria e non si deduce mai (Task 4) —
 * entrambe vivono in `politica-caselle.ts`, cablate in `tools/mail.ts`.
 *
 * Perche' un registro e non un parametro qua e la': ne esistevano gia' DUE a
 * meta' — `societa.ts` per le societa' e `AccountKey` ('info'|'raffaele') per
 * le caselle TopHost — e Gmail non stava in nessuno dei due. Aggiungere la
 * quarta casella senza unificarli avrebbe creato il TERZO posto dove la stessa
 * verita' e' scritta diversa: in questo repo e' la ferita che si riapre sempre.
 *
 * Registro in CODICE, come `societa.ts`: cambia raramente, si rivede in una
 * pull request, e **qui si dichiara COME SI CHIAMA la credenziale, mai il suo
 * valore**.
 */
import type { CodiceSocieta } from './societa'

export type ChiaveCasella = 'info' | 'raffaele' | 'drive' | 'larealestate'
export type TrasportoCasella = 'tophost' | 'google'

export interface Casella {
  chiave: ChiaveCasella
  indirizzo: string
  trasporto: TrasportoCasella
  societa: CodiceSocieta
  /**
   * Solo per il trasporto `google`: la chiave con cui cercare la riga in
   * `google_oauth_credentials`. MAI il token.
   */
  accountEmail?: string
}

const REGISTRO: Record<ChiaveCasella, Casella> = {
  // ⚠️ 'info' e 'raffaele' sono LE STESSE chiavi di `AccountKey`
  // (src/v19/tools/email/config.ts): il registro le assorbe, non le duplica.
  info: {
    chiave: 'info',
    indirizzo: 'info@restruktura.it',
    trasporto: 'tophost',
    societa: 'restruktura',
  },
  raffaele: {
    chiave: 'raffaele',
    indirizzo: 'raffaele.lentini@restruktura.it',
    trasporto: 'tophost',
    societa: 'restruktura',
  },
  drive: {
    chiave: 'drive',
    indirizzo: 'restruktura.drive@gmail.com',
    trasporto: 'google',
    societa: 'restruktura',
    accountEmail: 'restruktura.drive@gmail.com',
  },
  larealestate: {
    chiave: 'larealestate',
    indirizzo: 'larealestate.amministrazione@gmail.com',
    trasporto: 'google',
    societa: 'larealestate',
    accountEmail: 'larealestate.amministrazione@gmail.com',
  },
}

export function getCasella(c: ChiaveCasella): Casella {
  return REGISTRO[c]
}

export function listaCaselle(): Casella[] {
  return Object.values(REGISTRO)
}

export function caselleDiTrasporto(t: TrasportoCasella): Casella[] {
  return listaCaselle().filter((c) => c.trasporto === t)
}

/**
 * Alias riconosciuti nel testo dell'utente. Minuscoli, senza punteggiatura.
 *
 * ⚠️ Ogni alternativa deve ancorarsi all'indirizzo VERO, mai a un suffisso
 * largo come `@dominio` o `@`: un suffisso scatta anche sull'indirizzo di un
 * terzo (`marco.drive@gmail.com`, `mario.raffaele@x.com`), e qui un falso
 * positivo e' peggio di un mancato riconoscimento — fa credere che
 * l'Ingegnere abbia nominato una casella che non ha nominato.
 */
const ALIAS: Array<[RegExp, ChiaveCasella]> = [
  [/\binfo@|\binfo\b/, 'info'],
  [/\braffaele\.lentini\b/, 'raffaele'],
  [/\brestruktura\.drive\b/, 'drive'],
  [/\breal\s*estate\b|\blarealestate\b/, 'larealestate'],
]

/**
 * La casella nominata nel testo, o `null`.
 *
 * NON deve indovinare: due nominate valgono zero. Stessa regola di
 * `risolviSocieta` — una deduzione sbagliata qui manda una mail dall'indirizzo
 * di un'altra societa', e a un cliente.
 */
export function risolviCasella(testo: string): ChiaveCasella | null {
  const t = (testo || '').toLowerCase()
  const trovate = ALIAS.filter(([re]) => re.test(t)).map(([, c]) => c)
  const uniche = Array.from(new Set(trovate))
  return uniche.length === 1 ? uniche[0] : null
}

/**
 * File, calendario e documenti generati restano di Restruktura — È UNA SCELTA,
 * non un residuo.
 *
 * ⚠️ Fino al 14 settembre 2026 questi quattro punti avevano `'restruktura'`
 * scritto a mano dentro `drive.ts`, `calendar-tools.ts`, `document-saver.ts` e
 * `hallucination-validator.ts`. Sembrava una svista, e chiunque passasse di li'
 * era tentato di «sistemarla» — senza sapere che spostare quel valore manda i
 * documenti generati in un ALTRO Drive: un errore fisico e silenzioso, di cui
 * ci si accorge settimane dopo cercando un file.
 *
 * Quando servira' il Drive de La Real Estate sara' un lavoro suo, e passera' da
 * qui: un posto solo da cambiare, con scritto accanto cosa comporta.
 */
export const CASELLA_FILE_E_CALENDARIO: ChiaveCasella = 'drive'
