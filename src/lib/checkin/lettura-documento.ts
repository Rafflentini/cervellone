/**
 * src/lib/checkin/lettura-documento.ts
 *
 * Legge i dati dalla foto di un documento d'identita' e li PROPONE.
 *
 * ── La regola che governa tutto questo file ──────────────────────────────────
 * Quello che esce di qui e' un SUGGERIMENTO, mai un dato. Finisce in campi che
 * restano modificabili a mano, accanto a un avviso che dice da dove viene, e
 * non sovrascrive mai niente che una persona abbia gia' scritto.
 *
 * Non e' prudenza generica. Questi campi vanno alla Questura entro 24 ore e in
 * una fattura: un numero di documento letto male non e' un fastidio, e' una
 * comunicazione sbagliata all'autorita' di pubblica sicurezza. Una lettura
 * automatica che si prende l'ultima parola sarebbe peggio del lavoro a mano,
 * perche' l'errore diventa invisibile — nessuno ricontrolla un campo che
 * risulta gia' compilato.
 *
 * Per lo stesso motivo qui dentro NON si indovina mai: cio' che non si legge
 * con chiarezza torna vuoto. Un campo vuoto lo si nota; un campo pieno e
 * sbagliato no.
 */

import Anthropic from '@anthropic-ai/sdk'
import { normalizzaCf, strutturaValida } from './valida-codice-fiscale'

/** Un modello con la vista, e quello economico: e' una lettura, non un ragionamento. */
const MODELLO = 'claude-sonnet-4-6'

/** I tipi di documento che il modulo conosce. Vedi `TIPI_DOCUMENTO` nel form. */
const TIPI = ['IDENT', 'PASOR', 'PATEN'] as const

export interface DatiLetti {
  cognome: string
  nome: string
  sesso: '' | 'M' | 'F'
  dataNascita: string
  comuneNascita: string
  provNascita: string
  statoNascita: string
  cittadinanza: string
  tipoDocumento: '' | (typeof TIPI)[number]
  numeroDocumento: string
  luogoRilascio: string
  codiceFiscale: string
}

export interface EsitoLettura {
  ok: boolean
  dati: DatiLetti
  /** Quello che il modello non e' riuscito a leggere, o che ha letto male. */
  avvisi: string[]
  errore?: string
}

const VUOTO: DatiLetti = {
  cognome: '', nome: '', sesso: '', dataNascita: '', comuneNascita: '', provNascita: '',
  statoNascita: '', cittadinanza: '', tipoDocumento: '', numeroDocumento: '',
  luogoRilascio: '', codiceFiscale: '',
}

const ISTRUZIONI = `Sei davanti alla fotografia di un documento d'identita'.

Trascrivi SOLO cio' che leggi con certezza. Questo e' l'unico compito: non
interpretare, non completare, non dedurre. I dati vanno all'autorita' di
pubblica sicurezza, e un campo inventato e' peggio di un campo vuoto perche'
nessuno ricontrolla cio' che risulta gia' compilato.

Regole:
- se un campo non e' leggibile o non c'e', lascialo stringa vuota;
- NON dedurre il sesso dal nome: solo se il documento lo dichiara;
- NON dedurre la cittadinanza dallo stato che ha emesso il documento;
- NON ricostruire il codice fiscale dagli altri dati: solo se e' scritto;
- le date in forma AAAA-MM-GG;
- cognome, nome e luoghi in MAIUSCOLO;
- il numero del documento come stampato, senza spazi;
- tipoDocumento: "IDENT" carta d'identita', "PASOR" passaporto, "PATEN"
  patente. Qualunque altra cosa: stringa vuota.

Rispondi SOLO con questo oggetto JSON, senza altro testo:
{"cognome":"","nome":"","sesso":"","dataNascita":"","comuneNascita":"","provNascita":"","statoNascita":"","cittadinanza":"","tipoDocumento":"","numeroDocumento":"","luogoRilascio":"","codiceFiscale":"","illeggibile":[]}

In "illeggibile" metti i nomi dei campi che vedi sul documento ma non riesci a
trascrivere con sicurezza (foto sfocata, riflesso, taglio).`

const MAIUSCOLO = (v: unknown) =>
  String(v ?? '').trim().toUpperCase().replace(/\s+/g, ' ')

/**
 * Le date come capitano sui documenti: 12.04.1985, 12/04/1985, 12-04-1985.
 * Fuori da quelle forme non si indovina: torna vuoto.
 */
export function dataIso(v: unknown): string {
  const t = String(v ?? '').trim()
  if (!t) return ''
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return valida(t) ? t : ''
  const m = /^(\d{1,2})[./-](\d{1,2})[./-](\d{4})$/.exec(t)
  if (!m) return ''
  const iso = `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`
  return valida(iso) ? iso : ''
}

/** Una data che esiste davvero: il 31 febbraio no. */
function valida(iso: string): boolean {
  const [a, m, g] = iso.split('-').map(Number)
  const d = new Date(Date.UTC(a, m - 1, g))
  return d.getUTCFullYear() === a && d.getUTCMonth() === m - 1 && d.getUTCDate() === g
}

function sesso(v: unknown): '' | 'M' | 'F' {
  const t = String(v ?? '').trim().toUpperCase()
  if (t === 'M' || t.startsWith('MASCH') || t === 'MALE') return 'M'
  if (t === 'F' || t.startsWith('FEMM') || t === 'FEMALE') return 'F'
  return ''
}

function tipoDocumento(v: unknown): '' | (typeof TIPI)[number] {
  const t = String(v ?? '').trim().toUpperCase()
  return (TIPI as readonly string[]).includes(t) ? (t as (typeof TIPI)[number]) : ''
}

/**
 * Il codice fiscale si accetta solo se e' un codice fiscale.
 *
 * Un modello che legge una foto sfocata puo' restituire sedici caratteri che
 * somigliano a un codice: qui la struttura si controlla, e se non regge il
 * campo resta vuoto invece di far comparire nel modulo un codice plausibile e
 * falso.
 */
function codiceFiscale(v: unknown): string {
  const cf = normalizzaCf(String(v ?? ''))
  return cf && strutturaValida(cf) ? cf : ''
}

/**
 * Trasforma la risposta del modello in dati utilizzabili.
 *
 * Sta in una funzione sua, separata dalla chiamata, perche' e' qui che si
 * decide cosa entra nel modulo — e questo si prova senza rete.
 */
export function interpretaRisposta(testo: string): EsitoLettura {
  let grezzo: Record<string, unknown>
  try {
    // Il modello a volte incornicia il JSON: si prende dalla prima graffa
    // all'ultima invece di arrendersi.
    const dentro = testo.slice(testo.indexOf('{'), testo.lastIndexOf('}') + 1)
    grezzo = JSON.parse(dentro) as Record<string, unknown>
  } catch {
    return { ok: false, dati: { ...VUOTO }, avvisi: [], errore: 'Non sono riuscito a leggere la risposta.' }
  }

  const dati: DatiLetti = {
    cognome: MAIUSCOLO(grezzo.cognome),
    nome: MAIUSCOLO(grezzo.nome),
    sesso: sesso(grezzo.sesso),
    dataNascita: dataIso(grezzo.dataNascita),
    comuneNascita: MAIUSCOLO(grezzo.comuneNascita),
    provNascita: MAIUSCOLO(grezzo.provNascita).slice(0, 2),
    statoNascita: MAIUSCOLO(grezzo.statoNascita),
    cittadinanza: MAIUSCOLO(grezzo.cittadinanza),
    tipoDocumento: tipoDocumento(grezzo.tipoDocumento),
    numeroDocumento: MAIUSCOLO(grezzo.numeroDocumento).replace(/\s+/g, ''),
    luogoRilascio: MAIUSCOLO(grezzo.luogoRilascio),
    codiceFiscale: codiceFiscale(grezzo.codiceFiscale),
  }

  const avvisi: string[] = []
  const illeggibili = Array.isArray(grezzo.illeggibile) ? grezzo.illeggibile.map(String) : []
  if (illeggibili.length > 0) {
    avvisi.push(`Non sono riuscito a leggere: ${illeggibili.join(', ')}. Scrivili a mano.`)
  }
  // Un codice fiscale scartato va DETTO: altrimenti sembra che sul documento
  // non ci fosse, e nessuno lo cerca.
  if (grezzo.codiceFiscale && !dati.codiceFiscale) {
    avvisi.push('Il codice fiscale che ho letto non e valido: controllalo sul documento e scrivilo a mano.')
  }
  if (grezzo.dataNascita && !dati.dataNascita) {
    avvisi.push('La data di nascita che ho letto non e una data valida: scrivila a mano.')
  }

  const qualcosa = Object.values(dati).some((v) => v !== '')
  if (!qualcosa) {
    return {
      ok: false,
      dati,
      avvisi,
      errore: 'Da questa foto non sono riuscito a leggere niente. Riprova con piu luce, senza riflessi, col documento dritto e a fuoco.',
    }
  }

  return { ok: true, dati, avvisi }
}

/**
 * Legge la foto di un documento e restituisce i campi da PROPORRE.
 *
 * Non scrive niente da nessuna parte: chi la chiama decide cosa farne, e cio'
 * che ne fa e' mostrarli a una persona.
 */
export async function leggiDocumento(base64: string, mime: string): Promise<EsitoLettura> {
  if (!process.env.ANTHROPIC_API_KEY) {
    return { ok: false, dati: { ...VUOTO }, avvisi: [], errore: 'Lettura automatica non configurata.' }
  }
  const ammessi = ['image/jpeg', 'image/png', 'image/webp', 'image/gif']
  if (!ammessi.includes(mime)) {
    return {
      ok: false,
      dati: { ...VUOTO },
      avvisi: [],
      errore: 'Posso leggere solo le fotografie, non i PDF. Compila a mano.',
    }
  }

  const client = new Anthropic()
  const risposta = await client.messages.create({
    model: MODELLO,
    max_tokens: 700,
    // Zero: e' una trascrizione. Non c'e' niente da inventare, e la stessa
    // foto deve dare la stessa risposta.
    temperature: 0,
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: mime as 'image/jpeg', data: base64 } },
        { type: 'text', text: ISTRUZIONI },
      ],
    }],
  })

  const testo = risposta.content
    .filter((b): b is { type: 'text'; text: string; citations: [] } => b.type === 'text')
    .map((b) => b.text)
    .join('\n')

  return interpretaRisposta(testo)
}
