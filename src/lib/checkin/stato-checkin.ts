/**
 * src/lib/checkin/stato-checkin.ts
 *
 * Quando una pratica di check-in si puo' dichiarare chiusa.
 *
 * E' la funzione che scrive CHECKIN OK sul foglio, ed e' l'unica cosa che
 * l'Ingegnere guardera' davvero. Se dice OK quando manca qualcosa, quel
 * qualcosa non lo cerchera' piu' nessuno: e' esattamente il modo in cui la
 * memoria persistente e' rimasta rotta tre mesi dichiarandosi `ok` ogni notte.
 *
 * Percio' qui la regola e' severa e, quando dice di no, dice anche COSA manca.
 */

import { validaCodiceFiscale } from './valida-codice-fiscale'

export type Stato = 'DA COMPILARE' | 'PARZIALE' | 'CHECKIN OK'

export interface OspiteDaControllare {
  cognome: string
  nome: string
  dataNascita: string
  comuneNascita: string
  statoNascita: string
  cittadinanza: string
  tipoDocumento: string
  numeroDocumento: string
  codiceFiscale: string
}

export interface PraticaDaControllare {
  /** Quanti ospiti dichiara la prenotazione. */
  ospitiAttesi: number
  ospiti: OspiteDaControllare[]
  indirizzo: string
  cap: string
  citta: string
  nazione: string
}

export interface EsitoStato {
  stato: Stato
  /** Cosa manca perche' diventi CHECKIN OK. Vuoto solo quando e' OK. */
  mancanze: string[]
}

const vuoto = (s: string) => !String(s ?? '').trim()

/** Il codice fiscale si pretende dagli italiani, non dagli stranieri. */
function italiano(o: OspiteDaControllare): boolean {
  const c = String(o.cittadinanza || '').trim().toUpperCase()
  if (c && c !== 'ITALIA' && c !== 'ITALIANA') return false
  return Boolean(c) || Boolean(String(o.comuneNascita || '').trim())
}

function schedaVuota(o: OspiteDaControllare): boolean {
  return vuoto(o.cognome) && vuoto(o.nome) && vuoto(o.dataNascita)
}

export function calcolaStato(p: PraticaDaControllare): EsitoStato {
  const mancanze: string[] = []

  const compilate = (p.ospiti ?? []).filter((o) => !schedaVuota(o))

  // Il controllo che nessuno farebbe a mano: se la prenotazione dice 4 e le
  // schede sono 2, due persone dormono in casa senza essere comunicate alla
  // Questura, e il foglio non mostra nulla di strano.
  if (p.ospitiAttesi > 0 && compilate.length < p.ospitiAttesi) {
    const mancano = p.ospitiAttesi - compilate.length
    mancanze.push(
      `Mancano ${mancano} sched${mancano === 1 ? 'a' : 'e'} ospite su ${p.ospitiAttesi}.`,
    )
  }

  compilate.forEach((o, i) => {
    const eti = `Ospite ${i + 1}`
    if (vuoto(o.cognome)) mancanze.push(`${eti}: cognome.`)
    if (vuoto(o.nome)) mancanze.push(`${eti}: nome.`)
    if (vuoto(o.dataNascita)) mancanze.push(`${eti}: data di nascita.`)
    if (vuoto(o.comuneNascita) && vuoto(o.statoNascita)) mancanze.push(`${eti}: luogo di nascita.`)
    if (vuoto(o.cittadinanza)) mancanze.push(`${eti}: cittadinanza.`)
    if (vuoto(o.tipoDocumento)) mancanze.push(`${eti}: tipo di documento.`)
    if (vuoto(o.numeroDocumento)) mancanze.push(`${eti}: numero del documento.`)

    const cf = String(o.codiceFiscale || '').trim()
    if (italiano(o)) {
      if (!cf) mancanze.push(`${eti}: codice fiscale.`)
      else if (!validaCodiceFiscale(cf).valido) mancanze.push(`${eti}: codice fiscale non valido.`)
    } else if (cf && !validaCodiceFiscale(cf).valido) {
      mancanze.push(`${eti}: codice fiscale non valido.`)
    }
  })

  // Senza indirizzo la fattura elettronica non si genera: l'elemento Sede del
  // CessionarioCommittente e' obbligatorio nello schema FatturaPA.
  if (vuoto(p.indirizzo)) mancanze.push('Indirizzo di residenza per la fattura.')
  if (vuoto(p.citta)) mancanze.push('Comune di residenza per la fattura.')
  if (vuoto(p.cap) && String(p.nazione || 'IT').toUpperCase() === 'IT') {
    mancanze.push('CAP di residenza per la fattura.')
  }

  if (compilate.length === 0) return { stato: 'DA COMPILARE', mancanze }
  return mancanze.length === 0
    ? { stato: 'CHECKIN OK', mancanze: [] }
    : { stato: 'PARZIALE', mancanze }
}
