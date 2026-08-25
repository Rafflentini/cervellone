/**
 * src/lib/checkin/conservazione.ts
 *
 * Chi ha finito di servire e va cancellato.
 *
 * Sta in un file suo, separato dal codice che parla con Drive, per una ragione
 * precisa: la decisione di distruggere dei dati personali dev'essere una
 * funzione pura che si puo' leggere, provare e discutere senza rete di mezzo.
 * Se stesse dentro il lavoro notturno, l'unico modo di verificarla sarebbe
 * eseguirlo — cioe' cancellare davvero qualcosa.
 */

export interface PraticaConDocumenti {
  id: string
  /** 'aaaa-mm-gg' */
  checkout: string
  /** Identificativi Drive delle foto di quella pratica. */
  fileIds: string[]
}

const MS_GIORNO = 86_400_000

/**
 * Le pratiche le cui foto hanno superato il periodo di conservazione.
 *
 * Due prudenze deliberate:
 *
 *  - **senza data di check-out non si cancella niente.** Non si puo' dire se
 *    sia scaduta, e nel dubbio non si distrugge: restera' da guardare a mano,
 *    che e' il male minore;
 *  - il confronto e' **sul giorno**, non sull'ora. Il lavoro gira di notte, e
 *    un confronto sull'istante cancellerebbe qualcosa un giorno prima o dopo a
 *    seconda dell'ora di esecuzione.
 */
export function scadutiDaCancellare(
  pratiche: PraticaConDocumenti[],
  oggi: Date,
  giorniConservazione: number,
): PraticaConDocumenti[] {
  // Un valore assurdo nel Config non deve ne' bloccare tutto ne' cancellare
  // tutto: si riporta dentro un intervallo sensato.
  const giorni = Math.min(Math.max(Math.floor(giorniConservazione), 0), 3650)

  const oggiGiorno = Date.UTC(oggi.getUTCFullYear(), oggi.getUTCMonth(), oggi.getUTCDate())

  return pratiche.filter((p) => {
    if (!p.fileIds?.some((f) => f?.trim())) return false

    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(p.checkout || '').trim())
    if (!m) return false

    const co = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
    return oggiGiorno > co + giorni * MS_GIORNO
  })
}
