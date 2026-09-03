/**
 * lib/trascrizione.ts — I vocali Telegram diventano testo.
 *
 * Stava in `telegram-helpers.ts` in 25 righe che facevano quattro cose male.
 * Sessione reale del 3 settembre 2026: "La Colla Domenico" trascritto "Mr.
 * Laboda Luminico", "poteri di firma" trascritto "poteri di film", e cinque
 * messaggi ridotti a "..." — passati al modello come se fossero richieste.
 *
 * Le quattro correzioni sono qui sotto, ognuna col suo perche'.
 */

import { supabase } from './supabase'

const TELEGRAM_API = 'https://api.telegram.org/bot'
const OPENAI_TRANSCRIPTIONS = 'https://api.openai.com/v1/audio/transcriptions'

/**
 * Il modello di trascrizione. `gpt-4o-transcribe` e' nettamente piu' accurato di
 * `whisper-1`, soprattutto sui nomi propri — che e' esattamente dove sbagliava.
 * Se l'endpoint lo rifiuta (nome cambiato, non abilitato sull'account) si
 * ripiega su whisper-1: meglio la trascrizione di prima che nessuna
 * trascrizione. Vedi `MODELLO_RIPIEGO`.
 */
const MODELLO_PRINCIPALE = 'gpt-4o-transcribe'
const MODELLO_RIPIEGO = 'whisper-1'

/** Oltre questa soglia l'API rifiuta il file. Meglio dirlo che ricevere un 413 muto. */
const MAX_BYTES = 25 * 1024 * 1024

/** Il prompt di bias viene troncato oltre ~224 token: le parole in fondo si perdono. */
const MAX_CARATTERI_VOCABOLARIO = 224 * 4

const TIMEOUT_MS = 60_000

/**
 * Parole del mestiere che un trascrittore generalista sbaglia sistematicamente.
 * Non sono opinabili: sono i termini che compaiono ogni giorno nei vocali di un
 * ufficio tecnico edile.
 */
export const LESSICO_TECNICO: readonly string[] = [
  'ponteggio', 'CILA', 'SCIA', 'DURC', 'POS', 'PSC', 'DVR',
  'computo metrico', 'prezziario', 'committente', 'SAL', 'stato avanzamento lavori',
  'capitolato', 'cantiere', 'preventivo', 'fattura', 'ritenuta',
  'catasto', 'particella', 'subalterno', 'visura', 'accatastamento',
  'sopralluogo', 'collaudo', 'direzione lavori', 'sicurezza',
]

/**
 * Il vocabolario da suggerire al trascrittore.
 *
 * L'API accetta un `prompt` che INCLINA il riconoscimento verso parole attese:
 * e' il meccanismo previsto per i nomi propri, ed e' esattamente cio' che
 * mancava. Cervellone i nomi veri li conosce gia' — clienti, cantieri,
 * fornitori sono in `cervellone_entita_menzionate`, popolata dall'estrazione
 * memoria — quindi l'orecchio impara da solo, senza che nessuno compili liste.
 *
 * Best-effort: se il DB non risponde restano le parole del mestiere. Un
 * vocabolario mancante peggiora l'accuratezza, non deve impedire la
 * trascrizione.
 */
export async function costruisciVocabolario(): Promise<string> {
  let nomi: string[] = []
  try {
    const { data } = await supabase
      .from('cervellone_entita_menzionate')
      .select('name')
      .order('name')
      .limit(150)
    nomi = (data ?? [])
      .map((r: { name?: unknown }) => String(r?.name ?? '').trim())
      .filter(Boolean)
  } catch {
    // DB irraggiungibile: si va avanti col solo lessico tecnico.
  }

  // I nomi propri PRIMA: se il troncamento dell'API morde, deve mangiare le
  // parole comuni, non i nomi — che sono il motivo per cui il prompt esiste.
  const parole = [...nomi, ...LESSICO_TECNICO]
  let vocabolario = ''
  for (const p of parole) {
    const prossimo = vocabolario ? `${vocabolario}, ${p}` : p
    if (prossimo.length > MAX_CARATTERI_VOCABOLARIO) break
    vocabolario = prossimo
  }
  return vocabolario
}

/**
 * Frasi che il trascrittore INVENTA sul silenzio.
 *
 * Non e' un difetto nostro ed e' documentato: Whisper e' stato addestrato in
 * larga parte su sottotitoli, e quando non sente parlato produce le didascalie
 * di coda dei video — crediti dei traduttori, ringraziamenti, inviti a
 * iscriversi. Sono frasi intere, grammaticali, con parole vere: nessun
 * controllo di lunghezza o di punteggiatura le prende.
 *
 * Casi raccolti dai vocali veri dell'Ingegnere (3 settembre 2026):
 * - "Sottotitoli creati dalla comunità Amara.org"
 * - "Grazie per l'attenzione" — a cui il bot rispose "Grazie a Lei, Ingegnere",
 *   cioe' rispose educatamente a una frase mai pronunciata.
 *
 * Il confronto e' sull'INTERA trascrizione, non su una sottostringa: se
 * l'Ingegnere chiude davvero un discorso lungo con "grazie per l'attenzione",
 * quel messaggio non va buttato.
 */
const ALLUCINAZIONI_NOTE: readonly RegExp[] = [
  /^sottotitoli\b.*$/,
  /^traduzione e sottotitoli a cura di\b.*$/,
  // "il video" e "questo video" sono due varianti dello stesso artefatto: la
  // prima versione elencava solo la prima, e la seconda e' passata (3 set 2026).
  // Da qui la coda generica.
  /^grazie per aver (guardato|visto|seguito)\b.*$/,
  /^grazie per l['’]attenzione[.!]?$/,
  /^grazie a tutti( per l['’]attenzione)?[.!]?$/,
  /^iscriviti al canale\b.*$/,
  /^ci vediamo (nel prossimo video|alla prossima)\b.*$/,
  /^alla prossima[.!]?$/,
  /^buona visione[.!]?$/,
  /\bamara\.org\b/,
  /^subtitles? by\b.*$/,
  /^thanks? (for watching|you)\b.*$/,
]

/** True se la trascrizione e' una delle frasi che il modello inventa sul silenzio. */
export function allucinazioneDaSilenzio(testo: string): boolean {
  const pulito = (testo ?? '').trim().toLowerCase().replace(/\s+/g, ' ')
  if (!pulito) return false
  return ALLUCINAZIONI_NOTE.some((r) => r.test(pulito))
}

/**
 * Una trascrizione che non contiene una richiesta.
 *
 * Copre tre casi: il vuoto e la sola punteggiatura ("..."), le frasi inventate
 * sul silenzio (sopra), e i versi ("eh", "mm"). Fino al 3 set 2026 tutto questo
 * veniva consegnato al modello come se fosse una richiesta dell'utente, e il bot
 * rispondeva "il messaggio e' arrivato spezzato, non capisco a quale cosa si
 * riferisca" — confuso da qualcosa che l'utente non aveva mai detto.
 *
 * La soglia sui versi e' volutamente stretta: il rischio grosso non e' lasciar
 * passare un "eh", e' mangiare un "sì" o un "no", che sono le risposte con cui
 * si conferma o si annulla.
 */
export function trascrizioneDegenere(testo: string): boolean {
  const pulito = (testo ?? '').trim()
  if (!pulito) return true
  // Solo punteggiatura, puntini di sospensione, spazi.
  if (!/[\p{L}\p{N}]/u.test(pulito)) return true
  // Frasi intere inventate sul silenzio: nessun controllo di forma le prende.
  if (allucinazioneDaSilenzio(pulito)) return true

  const lettere = pulito.replace(/[^\p{L}\p{N}]/gu, '').toLowerCase()
  // Un solo carattere: non e' una richiesta.
  if (lettere.length <= 1) return true
  // Solo i versi veri e propri. La prima versione scartava tutto cio' che stava
  // sotto le tre lettere, e mangiava "sì" e "no" — cioe' le due risposte piu'
  // importanti che esistono, quelle con cui si conferma o si annulla. L'ha
  // trovato il test, non la rilettura.
  return /^(e+h+|a+h+|o+h+|u+h+|m+|mh+|hm+|e+m+|u+m+|boh)$/.test(lettere)
}

export interface EsitoTrascrizione {
  /** Il testo trascritto. Vuoto se non si e' ottenuto nulla di utile. */
  testo: string
  /** Messaggio da mostrare all'utente quando `testo` e' vuoto. */
  problema?: string
}

async function scaricaAudioTelegram(fileId: string, token: string): Promise<ArrayBuffer | null> {
  const fileRes = await fetch(`${TELEGRAM_API}${token}/getFile`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ file_id: fileId }),
  })
  const fileData = await fileRes.json()
  const filePath = fileData?.result?.file_path
  if (!filePath) {
    console.warn('[trascrizione] getFile senza file_path:', JSON.stringify(fileData).slice(0, 200))
    return null
  }
  const audioRes = await fetch(`https://api.telegram.org/file/bot${token}/${filePath}`)
  if (!audioRes.ok) {
    console.warn(`[trascrizione] download audio fallito: HTTP ${audioRes.status}`)
    return null
  }
  return await audioRes.arrayBuffer()
}

async function chiediTrascrizione(
  audio: ArrayBuffer,
  modello: string,
  vocabolario: string,
  mime = 'audio/ogg',
  nomeFile = 'voice.ogg',
): Promise<{ testo?: string; status?: number; errore?: string }> {
  const formData = new FormData()
  formData.append('file', new Blob([audio], { type: mime }), nomeFile)
  formData.append('model', modello)
  formData.append('language', 'it')
  if (vocabolario) formData.append('prompt', vocabolario)

  const res = await fetch(OPENAI_TRANSCRIPTIONS, {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    body: formData,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  if (!res.ok) {
    const corpo = await res.text().catch(() => '')
    return { status: res.status, errore: corpo.slice(0, 300) }
  }
  const data = await res.json()
  return { testo: String(data?.text ?? '') }
}

/** Traduce un errore dell'API in una frase che dica all'utente cosa fare. */
function messaggioPerStatus(status: number | undefined): string {
  if (status === 401 || status === 403) return 'Non riesco ad accedere al servizio di trascrizione. Ho avvisato: mi scriva il messaggio, per ora.'
  if (status === 413) return 'Il vocale è troppo lungo per essere trascritto. Lo spezzi in due, per favore.'
  if (status === 429) return 'Servizio di trascrizione momentaneamente occupato. Riprovi fra qualche secondo.'
  return 'Non sono riuscito a trascrivere il vocale. Riprovi, oppure me lo scriva.'
}

/**
 * Trascrive un vocale Telegram.
 *
 * Ritorna sempre un esito parlante: se `testo` e' vuoto, `problema` dice
 * all'utente cosa e' successo e cosa fare. Prima qui c'era `return ''` su ogni
 * errore, e l'utente leggeva la stessa frase generica sia che la chiave fosse
 * scaduta, sia che il file fosse troppo grande, sia che avesse solo respirato
 * nel microfono.
 */
export async function transcribeAudio(fileId: string, durataSec?: number): Promise<EsitoTrascrizione> {
  const token = process.env.TELEGRAM_BOT_TOKEN
  if (!token) return { testo: '', problema: messaggioPerStatus(undefined) }

  // Un vocale sotto il secondo non contiene una richiesta, e su un audio quasi
  // vuoto il trascrittore INVENTA (vedi ALLUCINAZIONI_NOTE). Fermarsi qui evita
  // sia la spesa sia il messaggio fantasma, e soprattutto dice all'Ingegnere la
  // cosa utile: che il vocale e' partito a vuoto, non che il bot non ha capito.
  if (typeof durataSec === 'number' && durataSec > 0 && durataSec < 1) {
    console.warn(`[trascrizione] vocale di ${durataSec}s: troppo corto, non lo mando a trascrivere`)
    return { testo: '', problema: `Il vocale è durato meno di un secondo — probabilmente è partito a vuoto. Lo rifaccia pure.` }
  }

  let audio: ArrayBuffer | null
  try {
    audio = await scaricaAudioTelegram(fileId, token)
  } catch (err) {
    console.warn('[trascrizione] download fallito:', err instanceof Error ? err.message : err)
    return { testo: '', problema: messaggioPerStatus(undefined) }
  }
  if (!audio) return { testo: '', problema: messaggioPerStatus(undefined) }
  return trascriviBuffer(audio, { durataSec, mime: 'audio/ogg', nomeFile: 'voice.ogg', canale: 'telegram' })
}

/**
 * Il cuore della trascrizione, indipendente da dove arriva l'audio.
 *
 * Esiste perche' i due canali devono avere lo STESSO orecchio: stesso modello,
 * stesso vocabolario coi nomi veri, stesso filtro sulle allucinazioni. Fino al
 * 3 set 2026 il web trascriveva nel browser con `SpeechRecognition` e Telegram
 * sul server con Whisper — due motori diversi, quindi ogni correzione valeva
 * per meta' prodotto. Vedi [[feedback_due_canali_equipollenti]].
 */
export async function trascriviBuffer(
  audio: ArrayBuffer,
  opts: { durataSec?: number; mime?: string; nomeFile?: string; canale?: string } = {},
): Promise<EsitoTrascrizione> {
  const { durataSec, mime = 'audio/ogg', nomeFile = 'voice.ogg', canale = '?' } = opts

  console.log(`[trascrizione:${canale}] audio ricevuto: ${audio.byteLength} byte, durata ${durataSec ?? '?'}s`)
  if (audio.byteLength === 0) {
    return { testo: '', problema: 'Non è arrivato nessun audio. Riprovi a registrare.' }
  }
  if (audio.byteLength > MAX_BYTES) {
    return { testo: '', problema: messaggioPerStatus(413) }
  }

  const vocabolario = await costruisciVocabolario()

  let esito: { testo?: string; status?: number; errore?: string }
  try {
    esito = await chiediTrascrizione(audio, MODELLO_PRINCIPALE, vocabolario, mime, nomeFile)
    // Ripiego sul modello vecchio SOLO se il nuovo e' stato rifiutato per come
    // e' fatta la richiesta (modello sconosciuto o non abilitato): 4xx che non
    // siano quota/auth. Un 429 o un 401 si ripresenterebbero identici.
    if (esito.status && esito.status >= 400 && esito.status < 500 && esito.status !== 401 && esito.status !== 403 && esito.status !== 429) {
      console.warn(`[trascrizione:${canale}] ${MODELLO_PRINCIPALE} rifiutato (HTTP ${esito.status}), ripiego su ${MODELLO_RIPIEGO}: ${esito.errore}`)
      esito = await chiediTrascrizione(audio, MODELLO_RIPIEGO, vocabolario, mime, nomeFile)
    }
  } catch (err) {
    console.warn(`[trascrizione:${canale}] chiamata fallita:`, err instanceof Error ? err.message : err)
    return { testo: '', problema: messaggioPerStatus(undefined) }
  }

  if (esito.testo === undefined) {
    console.warn(`[trascrizione:${canale}] HTTP ${esito.status}: ${esito.errore}`)
    return { testo: '', problema: messaggioPerStatus(esito.status) }
  }

  if (trascrizioneDegenere(esito.testo)) {
    console.warn(`[trascrizione:${canale}] degenere, scartata: "${esito.testo.slice(0, 40)}"`)
    return { testo: '', problema: 'Non ho sentito nulla di comprensibile nel vocale — forse è partito a vuoto. Lo ripeta pure.' }
  }

  return { testo: esito.testo.trim() }
}
