/**
 * src/lib/checkin/merge-pratica.ts
 *
 * Fonde quello che arriva dal form con quello che c'e' gia' sul foglio,
 * decidendo campo per campo CHI ha il diritto di cambiarlo.
 *
 * E' la difesa vera, e sta qui e non nell'interfaccia. Un campo mostrato in
 * sola lettura nel browser si rimanda comunque a mano: chiunque abbia il link
 * puo' aprire gli strumenti per sviluppatori e inviare quello che vuole. Se il
 * blocco vive solo nella pagina, non e' un blocco — e' un suggerimento.
 *
 * Il campo che conta piu' di tutti e' **l'importo**. Se un ospite lo
 * "corregge", quella cifra finisce in fattura al posto di quella incassata, e
 * nessuno se ne accorge finche' non arriva il commercialista.
 */

import { COL_SOGGIORNI, COL_OSPITI } from './foglio-schema'

/** Chi sta scrivendo. */
export type Livello =
  /** Ingegnere o chi consegna le chiavi: puo' tutto. */
  | { tipo: 'gestore' }
  /** L'ospite intestatario: tutto tranne i campi della prenotazione. */
  | { tipo: 'prenotazione' }
  /** Un ospite qualsiasi: SOLO la propria scheda. */
  | { tipo: 'ospite'; progressivo: number }

/**
 * Campi che appartengono alla prenotazione, cioe' all'Ingegnere.
 *
 * Non e' un elenco di comodita': ognuno di questi, cambiato da un ospite,
 * produce un documento fiscale sbagliato o una comunicazione sbagliata alla
 * Questura.
 */
export const CAMPI_DELLA_PRENOTAZIONE: readonly string[] = [
  'ID Soggiorno',
  'Data registrazione',
  'Unità',
  'Portale',
  'Cod. prenotazione',
  'Check-in',
  'Check-out',
  'Notti',
  'N. ospiti',
  'Importo lordo €',
]

/**
 * Campi che nessuno tocca dal form: li scrive il sistema.
 * Ci finiscono anche gli esiti della fatturazione: se il form potesse
 * riscriverli, un salvataggio tardivo cancellerebbe il numero di una fattura
 * gia' emessa.
 */
export const CAMPI_DEL_SISTEMA: readonly string[] = [
  'Imposta soggiorno €',
  'Inviato Alloggiati',
  'Fattura emessa',
  'N. fattura',
  'Data fattura',
  'ID documento FIC',
  'Stato check-in',
  'Da completare',
]

function indice(colonne: readonly string[], nome: string): number {
  return colonne.indexOf(nome)
}

/** Riga -> mappa nome colonna:valore. */
export function aMappa(colonne: readonly string[], riga: string[]): Record<string, string> {
  const m: Record<string, string> = {}
  colonne.forEach((c, i) => { m[c] = riga[i] ?? '' })
  return m
}

/** Mappa -> riga allineata allo schema. */
export function aRiga(colonne: readonly string[], m: Record<string, string>): string[] {
  return colonne.map((c) => m[c] ?? '')
}

export interface EsitoMerge {
  riga: string[]
  /** Campi che il mittente ha provato a cambiare senza averne diritto. */
  rifiutati: string[]
}

/**
 * Fonde la riga del soggiorno.
 *
 * I campi non consentiti non fanno fallire il salvataggio: vengono ignorati e
 * segnalati. Fallire vorrebbe dire bloccare un ospite in buona fede il cui
 * browser ha rimandato un campo invariato; ignorare in silenzio vorrebbe dire
 * non accorgersi mai di un tentativo vero.
 */
export function fondiSoggiorno(
  esistente: string[],
  inArrivo: Record<string, string>,
  livello: Livello,
): EsitoMerge {
  const attuale = aMappa(COL_SOGGIORNI, esistente)
  const nuova: Record<string, string> = { ...attuale }
  const rifiutati: string[] = []

  const bloccati = new Set<string>(CAMPI_DEL_SISTEMA)
  if (livello.tipo !== 'gestore') {
    for (const c of CAMPI_DELLA_PRENOTAZIONE) bloccati.add(c)
  }
  // Un ospite non intestatario non tocca NIENTE del soggiorno: ne' i dati della
  // prenotazione ne' quelli della fattura. Solo la propria scheda.
  const soloLaSuaScheda = livello.tipo === 'ospite'

  for (const [campo, valore] of Object.entries(inArrivo)) {
    if (indice(COL_SOGGIORNI, campo) < 0) continue // colonna che non esiste

    if (soloLaSuaScheda || bloccati.has(campo)) {
      // Rimandare invariato un campo bloccato e' normale: lo fa il browser.
      // Si segnala solo il tentativo di CAMBIARLO.
      if (String(valore ?? '') !== String(attuale[campo] ?? '')) rifiutati.push(campo)
      continue
    }
    nuova[campo] = String(valore ?? '')
  }

  return { riga: aRiga(COL_SOGGIORNI, nuova), rifiutati }
}

/**
 * Fonde le schede degli ospiti.
 *
 * Ogni scheda si aggiorna per (ID Soggiorno, Progressivo): non si cancella e
 * non si riscrive il blocco intero. Due ospiti possono compilare nello stesso
 * momento da telefoni diversi — riscrivere il blocco significherebbe che
 * l'ultimo dei due cancella il lavoro del primo.
 */
export function fondiOspiti(
  esistenti: string[][],
  inArrivo: Array<Record<string, string>>,
  livello: Livello,
  idSoggiorno: string,
): { righe: string[][]; rifiutati: string[] } {
  const rifiutati: string[] = []
  const perProgressivo = new Map<string, string[]>()
  for (const r of esistenti) {
    const m = aMappa(COL_OSPITI, r)
    perProgressivo.set(String(m['Progressivo'] ?? ''), r)
  }

  for (const scheda of inArrivo) {
    const prog = String(scheda['Progressivo'] ?? '').trim()
    if (!prog) continue

    if (livello.tipo === 'ospite' && Number(prog) !== livello.progressivo) {
      rifiutati.push(`Ospite ${prog}`)
      continue
    }

    const attuale = perProgressivo.get(prog)
    const base = attuale ? aMappa(COL_OSPITI, attuale) : {}
    const nuova: Record<string, string> = { ...base, ...scheda }
    // L'appartenenza non si sposta: un ospite non si trasferisce a un'altra
    // prenotazione riscrivendo un campo.
    nuova['ID Soggiorno'] = idSoggiorno
    nuova['Progressivo'] = prog
    perProgressivo.set(prog, aRiga(COL_OSPITI, nuova))
  }

  const righe = Array.from(perProgressivo.entries())
    .sort((a, b) => Number(a[0]) - Number(b[0]))
    .map(([, r]) => r)

  return { righe, rifiutati }
}
