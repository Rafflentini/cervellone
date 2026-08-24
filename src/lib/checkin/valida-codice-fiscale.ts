/**
 * src/lib/checkin/valida-codice-fiscale.ts
 *
 * Verifica formale del codice fiscale inserito al check-in.
 *
 * Il CF lo scrive l'ospite dal proprio documento, oppure chi consegna le
 * chiavi. E' un dato copiato a mano: sedici caratteri senza significato
 * visibile, dove un errore non si nota rileggendo. Il carattere di controllo
 * esiste esattamente per questo, e va usato: senza, un CF storto arriva fino
 * allo SdI e torna indietro come scarto quando l'ospite e' gia' ripartito.
 *
 * Due livelli, tenuti distinti di proposito:
 *
 *  - **Formale** (bloccante): lunghezza, struttura, carattere di controllo.
 *    Qui un no e' un no: il codice non puo' esistere.
 *  - **Coerenza** con data di nascita e sesso (da segnalare, non da bloccare):
 *    il codice e' valido ma racconta un'altra persona. Uno dei due campi e'
 *    sbagliato, e va guardato da un umano — non deciso da noi.
 */

const DISPARI: Record<string, number> = {
  '0': 1, '1': 0, '2': 5, '3': 7, '4': 9, '5': 13, '6': 15, '7': 17, '8': 19, '9': 21,
  A: 1, B: 0, C: 5, D: 7, E: 9, F: 13, G: 15, H: 17, I: 19, J: 21,
  K: 2, L: 4, M: 18, N: 20, O: 11, P: 3, Q: 6, R: 8, S: 12, T: 14,
  U: 16, V: 10, W: 22, X: 25, Y: 24, Z: 23,
}

const MESI = ['A', 'B', 'C', 'D', 'E', 'H', 'L', 'M', 'P', 'R', 'S', 'T'] as const

/**
 * Sostituzioni dell'omocodia: quando due persone otterrebbero lo stesso codice,
 * l'Agenzia delle Entrate rimpiazza le cifre, da destra, con queste lettere.
 * Sono codici veri di persone vere: rifiutarli come "malformati" vorrebbe dire
 * impedire il check-in a chi ce l'ha.
 */
const OMOCODIA: Record<string, string> = {
  L: '0', M: '1', N: '2', P: '3', Q: '4', R: '5', S: '6', T: '7', U: '8', V: '9',
}

/** Cifra o lettera-omocodia nelle posizioni numeriche. */
const CIFRA = '[0-9LMNPQRSTUV]'
const FORMA = new RegExp(
  `^[A-Z]{6}${CIFRA}{2}[ABCDEHLMPRST]${CIFRA}{2}[A-Z]${CIFRA}{3}[A-Z]$`,
)

export function normalizzaCf(cf: string): string {
  return String(cf || '').toUpperCase().replace(/\s/g, '')
}

/** Solo la forma: lunghezza e alfabeto ammesso in ogni posizione. */
export function strutturaValida(cf: string): boolean {
  return FORMA.test(normalizzaCf(cf))
}

function carattereDiControllo(primi15: string): string {
  let somma = 0
  for (let i = 0; i < 15; i++) {
    const ch = primi15.charAt(i)
    if ((i + 1) % 2 === 1) somma += DISPARI[ch] ?? 0
    else somma += ch >= '0' && ch <= '9' ? Number(ch) : ch.charCodeAt(0) - 65
  }
  return String.fromCharCode(65 + (somma % 26))
}

/** Riporta a cifra un carattere che potrebbe essere una sostituzione omocodica. */
const aCifra = (ch: string): string => OMOCODIA[ch] ?? ch

export interface DatiPerCoerenza {
  /** 'aaaa-mm-gg' */
  dataNascita?: string
  /** 'M' | 'F' */
  sesso?: string
}

export interface EsitoValidazione {
  /** Formalmente valido: si puo' proseguire col check-in. */
  valido: boolean
  normalizzato: string
  errore: string
  /** Undefined se non sono stati forniti dati con cui confrontarlo. */
  coerente?: boolean
  avvisoCoerenza?: string
}

export function validaCodiceFiscale(cf: string, dati?: DatiPerCoerenza): EsitoValidazione {
  const n = normalizzaCf(cf)

  if (!n) return { valido: false, normalizzato: '', errore: 'Codice fiscale mancante' }

  if (n.length !== 16) {
    return {
      valido: false,
      normalizzato: n,
      errore: `Il codice fiscale deve avere 16 caratteri, questo ne ha ${n.length}`,
    }
  }

  if (!FORMA.test(n)) {
    return {
      valido: false,
      normalizzato: n,
      errore: 'Il codice fiscale non ha la forma prevista (lettere e cifre nelle posizioni sbagliate)',
    }
  }

  const atteso = carattereDiControllo(n.substring(0, 15))
  if (n.charAt(15) !== atteso) {
    return {
      valido: false,
      normalizzato: n,
      errore: "Il codice fiscale non supera il controllo: c'e' un carattere sbagliato",
    }
  }

  const esito: EsitoValidazione = { valido: true, normalizzato: n, errore: '' }

  if (!dati || (!dati.dataNascita && !dati.sesso)) return esito

  const scostamenti: string[] = []

  const anno = aCifra(n.charAt(6)) + aCifra(n.charAt(7))
  const meseLettera = n.charAt(8)
  const giornoNum = Number(aCifra(n.charAt(9)) + aCifra(n.charAt(10)))
  const femmina = giornoNum > 40
  const giorno = femmina ? giornoNum - 40 : giornoNum

  if (dati.dataNascita) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dati.dataNascita.trim())
    if (m) {
      const meseAtteso = MESI[Number(m[2]) - 1]
      const coincide =
        m[1].slice(-2) === anno && meseLettera === meseAtteso && Number(m[3]) === giorno
      if (!coincide) {
        scostamenti.push(
          `la data di nascita indicata (${m[3]}/${m[2]}/${m[1]}) non corrisponde a quella scritta nel codice`,
        )
      }
    }
  }

  if (dati.sesso) {
    const attesoF = String(dati.sesso).toUpperCase() === 'F'
    if (attesoF !== femmina) {
      scostamenti.push('il sesso indicato non corrisponde a quello scritto nel codice')
    }
  }

  esito.coerente = scostamenti.length === 0
  esito.avvisoCoerenza = scostamenti.join('; ')
  return esito
}
