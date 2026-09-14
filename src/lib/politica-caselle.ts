/**
 * src/lib/politica-caselle.ts — la POLITICA con cui i tool guardano piu' caselle.
 *
 * Non e' in `src/lib/tools/mail.ts` apposta: il suo test importerebbe
 * `mail.ts`, che tira dentro `googleapis` e mezzo mondo — in questo repo un
 * import pesante dentro un test e' costato 1703 ms e un test caduto per
 * timeout (14 settembre 2026). Questo file resta leggero: lo importa solo
 * `./caselle`.
 */
import { caselleDiTrasporto, type ChiaveCasella } from './caselle'

export interface EsitoLettura<T> {
  risultati: Array<T & { casella: ChiaveCasella }>
  caselleFallite: Array<{ casella: ChiaveCasella; errore: string }>
}

/**
 * Legge su piu' caselle Google e tiene traccia di DUE cose: cosa ha trovato, e
 * dove NON e' riuscito a guardare.
 *
 * ⚠️ La seconda meta' non e' un lusso. Restituire solo i risultati trovati
 * significa che una casella con il token morto sparisce in silenzio, e chi
 * legge crede di aver visto tutto. In questa casa quel difetto e' gia' costato
 * quattro mesi di fatture estere a zero, sei rapporti di autodiagnosi mai
 * consegnati. Un elenco parziale che sembra completo e' il difetto di
 * famiglia — qui non si ripete.
 */
export async function leggiSuTutteLeGoogle<T>(
  caselle: ChiaveCasella[] | undefined,
  leggi: (c: ChiaveCasella) => Promise<T[]>,
): Promise<EsitoLettura<T>> {
  const scelte = caselle && caselle.length > 0
    ? caselle
    : caselleDiTrasporto('google').map((c) => c.chiave)

  const risultati: EsitoLettura<T>['risultati'] = []
  const caselleFallite: EsitoLettura<T>['caselleFallite'] = []

  for (const casella of scelte) {
    try {
      for (const r of await leggi(casella)) risultati.push({ ...r, casella })
    } catch (e) {
      caselleFallite.push({ casella, errore: e instanceof Error ? e.message : String(e) })
    }
  }

  return { risultati, caselleFallite }
}
