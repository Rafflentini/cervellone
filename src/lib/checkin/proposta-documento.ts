/**
 * src/lib/checkin/proposta-documento.ts
 *
 * Che cosa, di quello che si e' letto dalla foto, entra davvero nel modulo.
 *
 * ── Perche' non sta dentro la pagina ─────────────────────────────────────────
 * Perche' e' una regola, non un pezzo di interfaccia: decide quali campi di una
 * comunicazione all'autorita' di pubblica sicurezza vengono riscritti da una
 * lettura automatica. Dentro un componente non si puo' provare, e la prima
 * versione — che stava li' dentro — aveva un difetto che si e' visto solo
 * provandola in produzione su un documento vero. Vedi `PREDEFINITI`.
 */

/** Il nome leggibile di ogni campo, per dire a chi compila cosa e' cambiato. */
export type Etichette = Record<string, string>

export interface EsitoProposta {
  /** I campi da scrivere nel modulo, e con quale valore. */
  cambi: Record<string, string>
  /** I nomi leggibili di quelli riempiti. */
  riempiti: string[]
  /** Dove la foto dice una cosa e la persona ne aveva scritta un'altra. */
  conflitti: string[]
}

/**
 * Fonde quello che si e' letto con quello che c'e' gia' nel modulo.
 *
 * Due regole, in quest'ordine:
 *
 *  1. **Quello che una persona ha scritto vince sempre.** Non si sovrascrive
 *     mai: il disaccordo si mette per iscritto e decide lei. Un dato sostituito
 *     in silenzio da una lettura automatica e' l'errore peggiore, perche'
 *     nessuno ricontrolla un campo che risulta gia' compilato.
 *
 *  2. **Un valore PREDEFINITO non e' una cosa che una persona ha scritto.**
 *     Sesso «M», cittadinanza «ITALIA», documento «carta d'identita'» sono cio'
 *     che l'elenco a tendina mostra all'apertura, non una dichiarazione.
 *     Trattandoli come tale, la lettura non li correggeva mai: provata in
 *     produzione su un documento di MARIA ROSSI, la pagina diceva «sul
 *     documento leggo F, tu hai scritto M» e lasciava M. Ogni donna sarebbe
 *     andata alla Questura come maschio.
 */
export function applicaLettura(
  attuale: Record<string, string | undefined>,
  letti: Record<string, unknown>,
  predefiniti: Record<string, string>,
  etichette: Etichette,
): EsitoProposta {
  const cambi: Record<string, string> = {}
  const riempiti: string[] = []
  const conflitti: string[] = []

  for (const campo of Object.keys(etichette)) {
    const letto = String(letti[campo] ?? '').trim()
    if (!letto) continue

    const eti = etichette[campo]
    const gia = String(attuale[campo] ?? '').trim()
    const intoccato = campo in predefiniti && gia === predefiniti[campo]

    if (!gia || intoccato) {
      // Se il predefinito coincide gia' col letto non c'e' niente da dire:
      // annunciare "compilato sesso" quando era gia' giusto e' rumore.
      if (gia !== letto) {
        cambi[campo] = letto
        riempiti.push(eti)
      }
      continue
    }

    if (gia.toUpperCase() !== letto.toUpperCase()) {
      conflitti.push(`${eti}: sul documento leggo «${letto}», tu hai scritto «${gia}»`)
    }
  }

  return { cambi, riempiti, conflitti }
}
