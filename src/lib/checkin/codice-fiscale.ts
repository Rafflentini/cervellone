/**
 * src/lib/checkin/codice-fiscale.ts
 *
 * Calcolo del codice fiscale dai dati che il check-in raccoglie comunque per
 * Alloggiati Web. Tradotto da CodiceFiscale.gs (11/08/2026), che non aveva test.
 *
 * Un CF sbagliato e' peggio di un CF mancante: non da' errore, entra in fattura,
 * e torna indietro come scarto dallo SdI giorni dopo — quando l'ospite se n'e'
 * andato e la correzione costa una nota di credito. Per questo qui, quando un
 * dato manca, si dichiara: non si indovina.
 *
 * NB: il calcolo NON gestisce l'omocodia (la sostituzione di cifre con lettere
 * per due persone con lo stesso codice). E' l'Agenzia delle Entrate a
 * deciderla, e non e' derivabile dai dati anagrafici. Se un ospite dichiara un
 * CF diverso da quello calcolato, vince il suo: il form lo lascia sovrascrivere.
 */

/** Lettera del mese di nascita, gennaio -> dicembre. */
const MESI = ['A', 'B', 'C', 'D', 'E', 'H', 'L', 'M', 'P', 'R', 'S', 'T'] as const

/** Valori dei caratteri in posizione dispari (1-based) per il carattere di controllo. */
const DISPARI: Record<string, number> = {
  '0': 1, '1': 0, '2': 5, '3': 7, '4': 9, '5': 13, '6': 15, '7': 17, '8': 19, '9': 21,
  A: 1, B: 0, C: 5, D: 7, E: 9, F: 13, G: 15, H: 17, I: 19, J: 21,
  K: 2, L: 4, M: 18, N: 20, O: 11, P: 3, Q: 6, R: 8, S: 12, T: 14,
  U: 16, V: 10, W: 22, X: 25, Y: 24, Z: 23,
}

/** Maiuscolo, accenti sciolti, via tutto cio' che non e' una lettera. */
function normalizza(s: string): string {
  return String(s || '')
    .toUpperCase()
    .replace(/[ÀÁÂÃÄÅ]/g, 'A').replace(/[ÈÉÊË]/g, 'E').replace(/[ÌÍÎÏ]/g, 'I')
    .replace(/[ÒÓÔÕÖ]/g, 'O').replace(/[ÙÚÛÜ]/g, 'U').replace(/Ç/g, 'C').replace(/Ñ/g, 'N')
    .replace(/[^A-Z]/g, '')
}

const consonanti = (s: string) => normalizza(s).replace(/[AEIOU]/g, '')
const vocali = (s: string) => normalizza(s).replace(/[^AEIOU]/g, '')

/** Consonanti, poi vocali, poi X di riempimento. */
export function treLettereCognome(cognome: string): string {
  return (consonanti(cognome) + vocali(cognome) + 'XXX').substring(0, 3)
}

/**
 * Come il cognome, ma con quattro o piu' consonanti si prendono la prima, la
 * terza e la quarta — saltando la seconda. E' la regola che le implementazioni
 * frettolose ignorano, e produce CF sbagliati solo per certi nomi: quelli
 * lunghi, cioe' non quelli che si provano a mano.
 */
export function treLettereNome(nome: string): string {
  const c = consonanti(nome)
  if (c.length >= 4) return c.charAt(0) + c.charAt(2) + c.charAt(3)
  return (c + vocali(nome) + 'XXX').substring(0, 3)
}

function carattereDiControllo(parziale: string): string {
  let somma = 0
  for (let i = 0; i < 15; i++) {
    const ch = parziale.charAt(i)
    if ((i + 1) % 2 === 1) {
      somma += DISPARI[ch] ?? 0
    } else {
      somma += ch >= '0' && ch <= '9' ? Number(ch) : ch.charCodeAt(0) - 65
    }
  }
  return String.fromCharCode(65 + (somma % 26))
}

export interface DatiAnagrafici {
  cognome: string
  nome: string
  /** 'M' | 'F' */
  sesso: string
  /** 'aaaa-mm-gg' */
  dataNascita: string
  /** Denominazione del comune, per chi e' nato in Italia. */
  comuneNascita?: string
  /** Denominazione dello stato estero, per chi e' nato fuori. */
  statoNascita?: string
}

export interface EsitoCodiceFiscale {
  ok: boolean
  cf: string
  errore: string
}

/**
 * @param cercaCatastale denominazione -> codice catastale (o stringa vuota).
 *        Iniettata perche' nella realta' viene dalla scheda "Tabelle" del
 *        foglio, e questo calcolo deve poter essere provato senza rete.
 */
export function calcolaCodiceFiscale(
  dati: DatiAnagrafici,
  cercaCatastale: (luogo: string) => string,
): EsitoCodiceFiscale {
  const { cognome, nome, sesso, dataNascita } = dati

  if (!cognome?.trim() || !nome?.trim() || !sesso?.trim() || !dataNascita?.trim()) {
    return { ok: false, cf: '', errore: 'Dati anagrafici incompleti' }
  }

  const luogo = String(dati.comuneNascita || '').trim() || String(dati.statoNascita || '').trim()
  if (!luogo) return { ok: false, cf: '', errore: 'Luogo di nascita mancante' }

  const catastale = cercaCatastale(luogo)
  if (!catastale) {
    return {
      ok: false,
      cf: '',
      errore: `Codice catastale non trovato per "${luogo}" — aggiungilo nella scheda Tabelle`,
    }
  }

  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dataNascita.trim())
  if (!m) return { ok: false, cf: '', errore: 'Data di nascita non valida (attesa aaaa-mm-gg)' }

  const anno = m[1]
  const mese = Number(m[2])
  const giorno = Number(m[3])
  if (mese < 1 || mese > 12) return { ok: false, cf: '', errore: 'Mese di nascita non valido' }
  if (giorno < 1 || giorno > 31) return { ok: false, cf: '', errore: 'Giorno di nascita non valido' }

  const g = String(sesso).toUpperCase() === 'F' ? giorno + 40 : giorno

  const parziale =
    treLettereCognome(cognome) +
    treLettereNome(nome) +
    anno.slice(-2) +
    MESI[mese - 1] +
    String(g).padStart(2, '0') +
    catastale.toUpperCase()

  if (parziale.length !== 15) {
    return { ok: false, cf: '', errore: `Codice catastale "${catastale}" non ha la forma attesa` }
  }

  return { ok: true, cf: parziale + carattereDiControllo(parziale), errore: '' }
}
