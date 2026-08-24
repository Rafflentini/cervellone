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
  /** Quanti ospiti prevedeva la PRENOTAZIONE. */
  ospitiAttesi: number
  /**
   * Quanti se ne presentano DAVVERO, se qualcuno l'ha dichiarato.
   * Cambia solo con un gesto esplicito ("siamo di meno", "siamo uno in piu'"),
   * mai lasciando una scheda in bianco: un ospite che sparisce per distrazione
   * e' imposta non versata e una comunicazione alla Questura incompleta.
   */
  ospitiDichiarati?: number
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
  /**
   * Cose che NON impediscono di chiudere, ma che l'Ingegnere deve vedere.
   * La differenza fra prenotati e presentati sta qui: non si blocca nessuno,
   * ma non succede in silenzio.
   */
  segnalazioni: string[]
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
  const segnalazioni: string[] = []

  const compilate = (p.ospiti ?? []).filter((o) => !schedaVuota(o))

  // Il metro e' quanti se ne presentano davvero, se qualcuno l'ha dichiarato;
  // altrimenti quanti ne prevedeva la prenotazione.
  const metro = p.ospitiDichiarati && p.ospitiDichiarati > 0 ? p.ospitiDichiarati : p.ospitiAttesi

  // Il controllo che nessuno farebbe a mano: se se ne aspettano 4 e le schede
  // sono 2, due persone dormono in casa senza essere comunicate alla Questura,
  // e il foglio non mostra nulla di strano.
  if (metro > 0 && compilate.length < metro) {
    const mancano = metro - compilate.length
    // Questa frase la legge l'Ingegnere ogni giorno nella colonna del foglio:
    // il verbo si accorda, altrimenti sembra scritta da una macchina.
    mancanze.push(
      mancano === 1
        ? `Manca 1 scheda ospite su ${metro}.`
        : `Mancano ${mancano} schede ospite su ${metro}.`,
    )
  }

  // Chi si presenta puo' essere diverso da chi aveva prenotato: uno da forfait,
  // uno si aggiunge all'ultimo. Non si blocca nessuno — ma non deve succedere
  // in silenzio, perche' cambia l'imposta dovuta al Comune e l'elenco che va
  // alla Questura.
  if (p.ospitiAttesi > 0 && metro !== p.ospitiAttesi) {
    segnalazioni.push(
      metro < p.ospitiAttesi
        ? `Dichiarati ${metro} ospiti su ${p.ospitiAttesi} prenotati.`
        : `Dichiarati ${metro} ospiti, ${metro - p.ospitiAttesi} in piu' del prenotato.`,
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

  if (compilate.length === 0) return { stato: 'DA COMPILARE', mancanze, segnalazioni }
  return mancanze.length === 0
    ? { stato: 'CHECKIN OK', mancanze: [], segnalazioni }
    : { stato: 'PARZIALE', mancanze, segnalazioni }
}
