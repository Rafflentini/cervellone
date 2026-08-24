/**
 * src/lib/checkin/registrazione.ts
 *
 * Trasforma quello che una persona ha scritto nel form in due gruppi di righe
 * pronte per il foglio: una per il soggiorno, una per ogni ospite.
 *
 * E' il punto piu' delicato di tutto il sottosistema. Da qui in poi quei dati
 * diventano una fattura e una comunicazione alla Questura, e nessuno li guarda
 * piu'. Percio':
 *
 *  - le righe si costruiscono per NOME di colonna e si proiettano sullo schema.
 *    Costruirle come lista ordinata a mano vorrebbe dire che, aggiungendo una
 *    colonna, tutti i valori scivolano di una posizione — e il risultato
 *    sarebbe un foglio pieno di dati plausibili ma spostati;
 *  - il rifiuto elenca TUTTO cio' che manca, non il primo problema che incontra:
 *    chi sta al portone con l'ospite davanti deve poter rimediare in una volta;
 *  - niente finisce nel foglio senza essere ripulito. Chi compila puo' essere
 *    un estraneo.
 */

import { COL_SOGGIORNI, COL_OSPITI } from './foglio-schema'
import { calcolaImpostaSoggiorno, type RegoleImposta, type OspiteImposta } from './imposta-soggiorno'
import { validaCodiceFiscale } from './valida-codice-fiscale'

export interface OspitePayload {
  tipoAlloggiato: string
  cognome: string
  nome: string
  sesso: string
  dataNascita: string
  comuneNascita: string
  provNascita: string
  statoNascita: string
  cittadinanza: string
  tipoDocumento: string
  numeroDocumento: string
  luogoRilascio: string
  codiceFiscale: string
  esente: boolean
  motivoEsenzione: string
}

export interface PayloadCheckin {
  unita: string
  portale: string
  codPrenotazione: string
  checkin: string
  checkout: string
  importoLordo: string
  intestatario: string
  codiceFiscale: string
  piva: string
  sdi: string
  indirizzo: string
  cap: string
  citta: string
  provincia: string
  nazione: string
  email: string
  telefono: string
  note: string
  ospiti: OspitePayload[]
}

export interface ContestoRegistrazione {
  ora: Date
  cercaCatastale: (luogo: string) => string
  regole: RegoleImposta
}

export interface EsitoRegistrazione {
  ok: boolean
  id: string
  rigaSoggiorno: string[]
  righeOspiti: string[][]
  /** Cosa impedisce di proseguire. */
  errori: string[]
  /** Cosa va guardato ma non impedisce di proseguire. */
  avvisi: string[]
}

/**
 * Ripulisce un valore prima che tocchi il foglio.
 *
 * Il caso serio non e' l'estetica: un valore che comincia per `=`, `+`, `-` o
 * `@` viene interpretato da Google come FORMULA. E' iniezione in un foglio di
 * calcolo, e qui a scrivere puo' essere un ospite qualunque. Si antepone un
 * apostrofo, che Google tratta come "questo e' testo" e non mostra.
 */
function pulisci(v: unknown): string {
  const s = String(v ?? '').replace(/[\r\n\t]+/g, ' ').trim()
  return /^[=+\-@]/.test(s) ? `'${s}` : s
}

/** '450,00' e '450.00' sono entrambi validi per chi scrive. NaN non lo e'. */
function numero(v: string): number | null {
  const s = String(v ?? '').trim().replace(/\s/g, '').replace(',', '.')
  if (!s) return null
  const n = Number(s)
  return Number.isFinite(n) ? n : null
}

function due(n: number): string {
  return String(n).padStart(2, '0')
}

/** SOG-aaaammgg-hhmmss: leggibile a occhio e ordinabile per testo. */
function nuovoId(ora: Date): string {
  return (
    'SOG-' +
    ora.getUTCFullYear() + due(ora.getUTCMonth() + 1) + due(ora.getUTCDate()) +
    '-' +
    due(ora.getUTCHours()) + due(ora.getUTCMinutes()) + due(ora.getUTCSeconds())
  )
}

const MS_GIORNO = 86_400_000

function notti(checkin: string, checkout: string): number {
  const a = Date.parse(checkin), b = Date.parse(checkout)
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0
  return Math.max(0, Math.round((b - a) / MS_GIORNO))
}

/**
 * Il codice fiscale italiano si pretende da chi e' italiano.
 *
 * Un ospite straniero quel codice non ce l'ha: pretenderlo vorrebbe dire
 * impedirgli il check-in. Ma se ne dichiara uno, quello deve essere valido —
 * altrimenti finisce in fattura e torna indietro come scarto.
 */
function serveCodiceFiscale(o: OspitePayload): boolean {
  const cittadinanza = String(o.cittadinanza || '').trim().toUpperCase()
  const comune = String(o.comuneNascita || '').trim()
  if (cittadinanza && cittadinanza !== 'ITALIA' && cittadinanza !== 'ITALIANA') return false
  return Boolean(cittadinanza) || Boolean(comune)
}

/** Costruisce una riga proiettando una mappa nome-colonna -> valore. */
function proietta(colonne: readonly string[], valori: Record<string, string>): string[] {
  return colonne.map((c) => valori[c] ?? '')
}

export function registraCheckin(
  p: PayloadCheckin,
  ctx: ContestoRegistrazione,
): EsitoRegistrazione {
  const errori: string[] = []
  const avvisi: string[] = []

  if (!String(p.unita || '').trim()) errori.push('Indica l unita.')
  if (!String(p.checkin || '').trim()) errori.push('Indica la data di check-in.')
  if (!String(p.checkout || '').trim()) errori.push('Indica la data di check-out.')

  const lordo = numero(p.importoLordo)
  if (lordo === null) errori.push('Importo lordo mancante o non numerico.')

  const ospiti = Array.isArray(p.ospiti) ? p.ospiti : []
  if (ospiti.length === 0) errori.push('Aggiungi almeno un ospite.')

  ospiti.forEach((o, i) => {
    const eti = `Ospite ${i + 1}`
    if (!String(o.cognome || '').trim()) errori.push(`${eti}: manca il cognome.`)
    if (!String(o.nome || '').trim()) errori.push(`${eti}: manca il nome.`)
    if (!String(o.dataNascita || '').trim()) errori.push(`${eti}: manca la data di nascita.`)

    if (o.esente && !String(o.motivoEsenzione || '').trim()) {
      // Art. 3 c.4: il gestore deve conservare la dichiarazione di esenzione.
      errori.push(`${eti}: indica il motivo dell esenzione dall imposta di soggiorno.`)
    }

    const cf = String(o.codiceFiscale || '').trim()
    if (!cf) {
      if (serveCodiceFiscale(o)) errori.push(`${eti}: manca il codice fiscale.`)
      return
    }

    const v = validaCodiceFiscale(cf, { dataNascita: o.dataNascita, sesso: o.sesso })
    if (!v.valido) {
      errori.push(`${eti}: ${v.errore}.`)
      return
    }
    if (v.coerente === false) avvisi.push(`${eti}: ${v.avvisoCoerenza}.`)
  })

  const n = notti(p.checkin, p.checkout)

  // La fattura, se non si dice altro, e' intestata al PRIMO ospite. Nome e
  // codice fiscale sono gia' stati scritti nella sezione Ospiti: richiederli
  // una seconda volta significa chiedere due volte la stessa cosa a chi ha
  // l'ospite davanti — e due copie dello stesso dato prima o poi divergono.
  const primo = ospiti[0]
  const intestatario =
    pulisci(p.intestatario) ||
    (primo ? `${pulisci(primo.cognome)} ${pulisci(primo.nome)}`.trim().toUpperCase() : '')
  const cfIntestatario =
    pulisci(p.codiceFiscale).toUpperCase() ||
    (pulisci(p.intestatario) ? '' : pulisci(primo?.codiceFiscale ?? '').toUpperCase())

  const nazione = (pulisci(p.nazione) || 'IT').toUpperCase()

  // Codice destinatario: 0000000 e' il valore previsto per chi non ha un canale
  // telematico (privati italiani), XXXXXXX per i soggetti esteri. Lasciarlo
  // vuoto produrrebbe un XML rifiutato dallo SdI.
  const sdi = pulisci(p.sdi) || (nazione === 'IT' ? '0000000' : 'XXXXXXX')

  const imposta = calcolaImpostaSoggiorno({
    checkin: p.checkin,
    checkout: p.checkout,
    regole: ctx.regole,
    ospiti: ospiti.map<OspiteImposta>((o) => ({
      dataNascita: o.dataNascita,
      esente: Boolean(o.esente),
      motivoEsenzione: o.motivoEsenzione,
    })),
  })
  avvisi.push(...imposta.anomalie)

  const id = nuovoId(ctx.ora)

  const rigaSoggiorno = proietta(COL_SOGGIORNI, {
    'ID Soggiorno': id,
    'Data registrazione': ctx.ora.toISOString(),
    'Unità': pulisci(p.unita),
    'Portale': pulisci(p.portale),
    'Cod. prenotazione': pulisci(p.codPrenotazione),
    'Check-in': pulisci(p.checkin),
    'Check-out': pulisci(p.checkout),
    'Notti': String(n),
    'N. ospiti': String(ospiti.length),
    'Importo lordo €': lordo === null ? '' : String(lordo),
    'Intestatario fattura': intestatario,
    'Codice fiscale': cfIntestatario,
    'P.IVA': pulisci(p.piva),
    'Codice SDI / PEC': sdi,
    'Indirizzo': pulisci(p.indirizzo),
    'CAP': pulisci(p.cap),
    'Città': pulisci(p.citta),
    'Provincia': pulisci(p.provincia).toUpperCase(),
    'Nazione': nazione,
    'Email': pulisci(p.email),
    'Telefono': pulisci(p.telefono),
    'Imposta soggiorno €': String(imposta.importo),
    'Inviato Alloggiati': 'NO',
    'Fattura emessa': 'NO',
    'Note': pulisci(p.note),
  })

  const righeOspiti = ospiti.map((o, i) =>
    proietta(COL_OSPITI, {
      'ID Soggiorno': id,
      'Progressivo': String(i + 1),
      'Tipo alloggiato': pulisci(o.tipoAlloggiato),
      'Cognome': pulisci(o.cognome).toUpperCase(),
      'Nome': pulisci(o.nome).toUpperCase(),
      'Sesso': pulisci(o.sesso).toUpperCase(),
      'Data nascita': pulisci(o.dataNascita),
      'Comune nascita': pulisci(o.comuneNascita).toUpperCase(),
      'Prov. nascita': pulisci(o.provNascita).toUpperCase(),
      'Stato nascita': pulisci(o.statoNascita).toUpperCase(),
      'Cittadinanza': pulisci(o.cittadinanza).toUpperCase(),
      'Tipo documento': pulisci(o.tipoDocumento),
      'Numero documento': pulisci(o.numeroDocumento).toUpperCase(),
      'Luogo rilascio': pulisci(o.luogoRilascio).toUpperCase(),
      'Codice fiscale': pulisci(o.codiceFiscale).toUpperCase(),
      'Esente imposta': o.esente ? 'SI' : 'NO',
      'Motivo esenzione': pulisci(o.motivoEsenzione),
    }),
  )

  return { ok: errori.length === 0, id, rigaSoggiorno, righeOspiti, errori, avvisi }
}
