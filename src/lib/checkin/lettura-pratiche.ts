/**
 * Le prenotazioni lette dal foglio, nella forma che serve a CERVELLONE.
 *
 * La pagina di gestione sa gia' fare tutto questo, ma quello che sa la pagina
 * il bot non lo sa: fino al 5 settembre 2026 l'unico strumento del check-in era
 * `checkin_prepara_foglio`. Cervellone non poteva rispondere a "chi arriva
 * domani", "quanto ho incassato a settembre", "quanta imposta devo versare" —
 * cioe' alle uniche domande che l'Ingegnere fa davvero.
 *
 * E' lo stesso difetto delle fatture estere in un'altra veste: il valore
 * esisteva, ma viveva in un posto che il bot non guardava.
 * [[cervellone-bot-cieco-sulle-automazioni]]
 */
import {
  FOGLIO_CHECKIN_ID, SCHEDA_SOGGIORNI, COL_SOGGIORNI,
} from './foglio-schema'
import { leggiTutto } from './foglio-google'
import { aMappa } from './merge-pratica'
import { statoFatturaDi, numeroIt, type StatoFattura } from './archivio'

export type PraticaLetta = {
  id: string
  unita: string
  intestatario: string
  portale: string
  checkin: string
  checkout: string
  notti: number
  ospitiAttesi: number
  importo: number
  imposta: number
  statoCheckin: string
  checkinCompleto: boolean
  inviatoAlloggiati: boolean
  statoFattura: StatoFattura
}

/**
 * I nomi delle colonne del foglio, in UN SOLO posto.
 *
 * Non sono decorativi: `aMappa` indicizza per intestazione, quindi un accento o
 * una maiuscola sbagliati non danno errore — danno `undefined`, e la
 * prenotazione risulta senza importo e senza date. Il tool risponderebbe
 * "nessuna prenotazione" su un foglio pieno.
 *
 * Un audit del 5 set 2026 lo ha dimostrato: cambiando 'Unità' in 'Unita' i 371
 * test del check-in restavano TUTTI verdi. Da qui la costante unica e il test
 * che la confronta con lo schema vero (`COL_SOGGIORNI`).
 */
export const COL = {
  id: 'ID Soggiorno',
  unita: 'Unità',
  intestatario: 'Intestatario fattura',
  portale: 'Portale',
  checkin: 'Check-in',
  checkout: 'Check-out',
  notti: 'Notti',
  ospiti: 'N. ospiti',
  importo: 'Importo lordo €',
  imposta: 'Imposta soggiorno €',
  statoCheckin: 'Stato check-in',
  inviatoAlloggiati: 'Inviato Alloggiati',
} as const

export async function leggiPratiche(foglioId: string = FOGLIO_CHECKIN_ID): Promise<PraticaLetta[]> {
  const righe = await leggiTutto(foglioId, SCHEDA_SOGGIORNI)
  return righe.slice(1)
    .map((r) => aMappa(COL_SOGGIORNI, r))
    .filter((m) => String(m[COL.id] ?? '').trim())
    .map((m) => ({
      id: String(m[COL.id]).trim(),
      unita: m[COL.unita] ?? '',
      intestatario: m[COL.intestatario] ?? '',
      portale: m[COL.portale] ?? '',
      checkin: (m[COL.checkin] ?? '').trim(),
      checkout: (m[COL.checkout] ?? '').trim(),
      notti: numeroIt(m[COL.notti] ?? ''),
      ospitiAttesi: numeroIt(m[COL.ospiti] ?? ''),
      importo: numeroIt(m[COL.importo] ?? ''),
      imposta: numeroIt(m[COL.imposta] ?? ''),
      statoCheckin: m[COL.statoCheckin] || 'DA COMPILARE',
      checkinCompleto: String(m[COL.statoCheckin] ?? '').trim().toUpperCase() === 'CHECKIN OK',
      // "Inviato" e' il gesto umano sul Portale Alloggiati, NON l'aver
      // scaricato il file: art. 109 T.U.L.P.S., 24 ore, il ritardo non si
      // recupera.
      inviatoAlloggiati: String(m[COL.inviatoAlloggiati] ?? '').trim().toUpperCase() === 'SI',
      statoFattura: statoFatturaDi(m),
    }))
}

/**
 * Una data utilizzabile per i confronti: 'AAAA-MM-GG' e realmente esistente.
 *
 * I confronti fra date qui sono confronti fra STRINGHE, che funzionano solo in
 * forma ISO. Una cella vuota o scritta all'italiana ('10/09/2026') farebbe
 * finire la stessa prenotazione contemporaneamente fra chi e' in casa, fra i
 * check-in incompleti E fra le comunicazioni mancate alla Questura: un allarme
 * di legge fatto scattare da una cella compilata male. Un elenco che grida
 * sempre smette di essere letto.
 */
function dataValida(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false
  const d = new Date(`${s}T00:00:00Z`)
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s
}

export type Situazione = {
  oggi: string
  inArrivo: PraticaLetta[]
  inCasa: PraticaLetta[]
  checkinIncompleti: PraticaLetta[]
  alloggiatiDaInviare: PraticaLetta[]
  daFatturare: PraticaLetta[]
  daInviareInFattura: PraticaLetta[]
  /** Righe con date inutilizzabili: escluse dai conti e DICHIARATE. */
  dateNonValide: PraticaLetta[]
}

/**
 * La fotografia di oggi.
 *
 * `alloggiatiDaInviare` guarda SOLO i soggiorni gia' iniziati: prima
 * dell'arrivo non c'e' niente da comunicare, e metterli nell'elenco farebbe
 * sembrare urgente cio' che non lo e' — un elenco che grida sempre non lo
 * legge piu' nessuno.
 */
export function situazione(pratiche: PraticaLetta[], oggi: string, giorniAvanti = 7): Situazione {
  const limite = new Date(new Date(`${oggi}T00:00:00Z`).getTime() + giorniAvanti * 86_400_000)
    .toISOString().slice(0, 10)

  // Le righe con date inutilizzabili escono dai conti PRIMA di ogni filtro, ma
  // non spariscono: finiscono in `dateNonValide` e vanno riferite. Scartarle in
  // silenzio farebbe risultare a posto una prenotazione che nessuno ha
  // controllato.
  const dateNonValide = pratiche.filter((p) => !dataValida(p.checkin) || !dataValida(p.checkout))
  const buone = pratiche.filter((p) => dataValida(p.checkin) && dataValida(p.checkout))

  return {
    oggi,
    inArrivo: buone.filter((p) => p.checkin > oggi && p.checkin <= limite),
    inCasa: buone.filter((p) => p.checkin <= oggi && p.checkout >= oggi),
    checkinIncompleti: buone.filter((p) => !p.checkinCompleto && p.checkout >= oggi),
    // Solo i soggiorni GIA' iniziati: prima dell'arrivo non c'e' niente da
    // comunicare alla Questura.
    alloggiatiDaInviare: buone.filter((p) => !p.inviatoAlloggiati && p.checkin <= oggi),
    daFatturare: buone.filter((p) => p.statoFattura === 'DA FARE' && p.checkout < oggi),
    daInviareInFattura: buone.filter((p) => p.statoFattura === 'COMPILATA'),
    dateNonValide,
  }
}
