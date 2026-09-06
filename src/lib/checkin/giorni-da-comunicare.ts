/**
 * src/lib/checkin/giorni-da-comunicare.ts
 *
 * Quali giorni d'arrivo risultano ancora non comunicati alla Questura.
 *
 * ── Perche' esiste (6 settembre 2026) ────────────────────────────────────────
 * La rotta `api/checkin/alloggiati` risponde su UNA data alla volta: e' la
 * domanda che ci si fa la mattina ("chi e' arrivato ieri?"). Ma a settembre
 * 2026 si registrano a mano tutti gli ingressi di agosto mai inseriti, e con
 * cinque appartamenti e affitti settimanali sono una ventina di date diverse.
 * Senza un elenco bisogna indovinarle una per una, e non c'e' modo di sapere
 * quali sono andate a vuoto.
 *
 * Sta qui e non dentro la rotta per un motivo preciso: la prima versione
 * viveva nella rotta, aveva una regex sbagliata (`^d{4}` invece di `^\d{4}`) e
 * rispondeva SEMPRE "nessun giorno in sospeso". Nessun test poteva vederlo,
 * perche' non c'era niente da chiamare. L'ha trovata la prova in produzione,
 * per fortuna prima che qualcuno ci contasse.
 */

export interface SoggiornoDaContare {
  id: string
  /** La data d'arrivo, attesa in forma 'aaaa-mm-gg'. */
  checkin: string
  /** Quante schede ospite ha questa prenotazione. */
  schede: number
  /** La spunta "Inviato Alloggiati" del foglio. */
  inviato: boolean
}

export interface GiornoDaFare {
  giorno: string
  /** Schede ospite totali di quel giorno. */
  schede: number
  /** Prenotazioni di quel giorno senza nemmeno una scheda. */
  senzaSchede: number
  /** Prenotazioni gia' segnate come comunicate. */
  inviate: number
  /** Prenotazioni totali di quel giorno. */
  totali: number
}

const ISO = /^\d{4}-\d{2}-\d{2}$/

/**
 * I giorni con almeno una prenotazione non ancora comunicata, in ordine di
 * data.
 *
 * Un giorno resta nell'elenco anche se NESSUNO ha compilato le schede: e'
 * proprio il caso degli arretrati, ed e' quello che spariva in silenzio
 * quando si contavano soltanto le righe ospite.
 *
 * Le date in una forma diversa da 'aaaa-mm-gg' non entrano: non si puo'
 * ordinare ne' interrogare la rotta con "15/08/2026". Non e' un problema
 * teorico — una cella toccata a mano su Google Sheets diventa proprio cosi'.
 */
export function giorniDaComunicare(soggiorni: SoggiornoDaContare[]): {
  giorni: GiornoDaFare[]
  /** Le prenotazioni scartate perche' la data non si legge: mai in silenzio. */
  dateNonValide: Array<{ id: string; checkin: string }>
} {
  const perGiorno = new Map<string, GiornoDaFare>()
  const dateNonValide: Array<{ id: string; checkin: string }> = []

  for (const s of soggiorni) {
    if (!s.id) continue
    if (!ISO.test(s.checkin)) {
      if (s.checkin) dateNonValide.push({ id: s.id, checkin: s.checkin })
      continue
    }
    const v = perGiorno.get(s.checkin)
      ?? { giorno: s.checkin, schede: 0, senzaSchede: 0, inviate: 0, totali: 0 }
    v.schede += s.schede
    v.totali += 1
    if (s.schede === 0) v.senzaSchede += 1
    if (s.inviato) v.inviate += 1
    perGiorno.set(s.checkin, v)
  }

  const giorni = [...perGiorno.values()]
    .filter((v) => v.inviate < v.totali)
    .sort((a, b) => a.giorno.localeCompare(b.giorno))

  return { giorni, dateNonValide }
}
