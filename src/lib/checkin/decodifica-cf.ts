/**
 * src/lib/checkin/decodifica-cf.ts
 *
 * Dal codice fiscale ai dati che contiene.
 *
 * Il codice fiscale NON e' un identificativo opaco: dentro ci sono la data di
 * nascita, il sesso e il luogo di nascita, in chiaro per chi sa leggerli.
 * Chiederli di nuovo a chi ha appena scritto il codice significa fargli
 * compilare quattro caselle che il sistema conosce gia' — e ogni casella in piu'
 * e' un'occasione di scriverle diverse dal codice.
 *
 * Non si decodificano cognome e nome: quelle tre lettere non sono invertibili
 * (da "RSS" non si torna a "Rossi").
 */

import { validaCodiceFiscale, normalizzaCf } from './valida-codice-fiscale'

const MESI = ['A', 'B', 'C', 'D', 'E', 'H', 'L', 'M', 'P', 'R', 'S', 'T'] as const

/** Le lettere che l'omocodia mette al posto delle cifre. */
const OMOCODIA: Record<string, string> = {
  L: '0', M: '1', N: '2', P: '3', Q: '4', R: '5', S: '6', T: '7', U: '8', V: '9',
}
const aCifra = (ch: string): string => OMOCODIA[ch] ?? ch

export interface DatiDalCf {
  /** 'M' | 'F' */
  sesso: string
  /** 'aaaa-mm-gg' */
  dataNascita: string
  /** Codice catastale del luogo di nascita: H501, Z112... */
  catastale: string
  /** Vero se il codice indica una nascita all'estero (codici Z). */
  estero: boolean
}

/**
 * @param annoCorrente serve a decidere il secolo: "80" e' il 1980, "24" il 2024.
 *        Passato come parametro e non letto dall'orologio, cosi' il risultato
 *        non cambia da solo col passare degli anni durante un test.
 */
export function decodificaCf(cf: string, annoCorrente: number): DatiDalCf | null {
  const n = normalizzaCf(cf)
  if (!validaCodiceFiscale(n).valido) return null

  const aa = Number(aCifra(n.charAt(6)) + aCifra(n.charAt(7)))
  const mese = MESI.indexOf(n.charAt(8) as (typeof MESI)[number]) + 1
  if (mese < 1) return null

  const giornoGrezzo = Number(aCifra(n.charAt(9)) + aCifra(n.charAt(10)))
  const femmina = giornoGrezzo > 40
  const giorno = femmina ? giornoGrezzo - 40 : giornoGrezzo
  if (giorno < 1 || giorno > 31) return null

  // Due cifre non dicono il secolo. Si sceglie il 2000 se la data che ne esce
  // e' gia' passata, altrimenti il 1900: un ospite nato nel futuro non esiste,
  // uno nato nel 1980 si'.
  const duemila = 2000 + aa
  const anno = duemila <= annoCorrente ? duemila : 1900 + aa

  const catastale = n.substring(11, 15)

  return {
    sesso: femmina ? 'F' : 'M',
    dataNascita: `${anno}-${String(mese).padStart(2, '0')}-${String(giorno).padStart(2, '0')}`,
    catastale,
    estero: catastale.startsWith('Z'),
  }
}
