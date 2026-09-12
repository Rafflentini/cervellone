/**
 * lib/telegram-helpers.ts — Funzioni helper per Telegram
 * Estratte dalla route per riuso in altri moduli.
 */

import { contieneComandoConCodice } from './comandi-uuid'

const TELEGRAM_API = 'https://api.telegram.org/bot'

/**
 * ⭐ Il `parse_mode` giusto per QUESTO testo.
 *
 * Un messaggio che porta un nostro comando va spedito in testo SEMPLICE. Motivo
 * misurato: ogni comando porta un `_`, e due comandi nello stesso messaggio —
 * «Per inviare: /invia_… · Per annullare: /annulla_…» — danno una COPPIA di
 * underscore, che nel Markdown classico delimita il corsivo. Telegram li mangia
 * e all'Ingegnere arriva `/inviaXXXX`: un comando che non esiste. Lui lavora dal
 * telefono, e quel comando era il modo per confermare una mail.
 *
 * ⚠️ Il ripiego che sta sotto in `sendTelegramMessageChecked` NON copre questo
 * caso, e resta dov'è perché serve ad altro: scatta quando Telegram RIGETTA il
 * Markdown, mentre qui il Markdown è valido — lo rende, e basta. Nessun errore,
 * nessun ritentativo, solo il comando mutilato.
 *
 * Telegram rende cliccabile `/comando` anche nel testo semplice, quindi il
 * prezzo è il grassetto **dei soli messaggi che portano un comando**. Prezzo
 * basso contro un comando che non si può usare.
 *
 * PERCHE' DECIDE IL CONTENUTO E NON IL CHIAMANTE: i comandi nascono dentro i
 * moduli (`sal-tools`, `regole-proposte`, `drive-policy-actions`, il cron della
 * sentinella) e viaggiano come stringhe attraverso 107 punti d'invio. Una scelta
 * da fare a mano in 107 posti è una scelta che verrà dimenticata in 106 — è
 * esattamente così che in questo repo sono nate le divergenze fra i canali. La
 * via esplicita esiste comunque: `sendTelegramMessageComando`.
 */
function parseModePer(text: string): { parse_mode?: 'Markdown' } {
  return contieneComandoConCodice(text) ? {} : { parse_mode: 'Markdown' }
}

function splitTelegramText(text: string): string[] {
  const MAX_LEN = 4000
  const chunks: string[] = []
  if (text.length <= MAX_LEN) {
    chunks.push(text)
  } else {
    let remaining = text
    while (remaining.length > 0) {
      if (remaining.length <= MAX_LEN) { chunks.push(remaining); break }
      let cutAt = remaining.lastIndexOf('\n\n', MAX_LEN)
      if (cutAt < 500) cutAt = remaining.lastIndexOf('\n', MAX_LEN)
      if (cutAt < 500) cutAt = MAX_LEN
      chunks.push(remaining.slice(0, cutAt))
      remaining = remaining.slice(cutAt).trimStart()
    }
  }
  return chunks
}

/**
 * Una POST /sendMessage. Ritorna `true` SOLO se Telegram ha accettato.
 * Telegram risponde HTTP 200 con `{ok:false, description}` sugli errori
 * applicativi (Markdown malformato, rate limit): `res.ok` da solo non basta,
 * va letto il body. Un body illeggibile su HTTP 2xx si considera recapitato
 * (nessuna prova del contrario).
 */
async function postTelegramMessage(token: string, payload: Record<string, unknown>): Promise<boolean> {
  try {
    const res = await fetch(`${TELEGRAM_API}${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    if (res && res.ok === false) return false
    let body: unknown = null
    try { body = await res.json() } catch { /* non JSON: ci si fida dello status */ }
    return (body as { ok?: unknown } | null)?.ok !== false
  } catch {
    return false
  }
}

/**
 * Come `sendTelegramMessage`, ma RIPORTA se il messaggio è stato davvero
 * recapitato.
 *
 * Serve a chi latcha uno stato su "l'ho già detto all'utente" (vedi
 * `markGoogleTokenDead`): `sendTelegramMessage` non rigetta MAI — senza token
 * fa `return` muto e su 4xx/429 la fetch risolve comunque — quindi un
 * `try/catch` attorno ad essa è codice morto e brucerebbe il latch su un
 * messaggio mai arrivato.
 *
 * Ritorna `false` se manca il token o se anche un solo chunk non è passato.
 */
export async function sendTelegramMessageChecked(chatId: number, text: string): Promise<boolean> {
  const token = process.env.TELEGRAM_BOT_TOKEN
  if (!token) return false
  // Un messaggio che porta un comando parte in testo semplice: vedi
  // `parseModePer`. Quelli che non ne portano — la grande maggioranza — usano
  // il Markdown e il suo ripiego esattamente come prima.
  if (contieneComandoConCodice(text)) return sendTelegramMessageComando(chatId, text)
  let delivered = true
  for (const chunk of splitTelegramText(text)) {
    const ok = await postTelegramMessage(token, { chat_id: chatId, text: chunk, parse_mode: 'Markdown' })
    // Fallback senza parse_mode se Markdown fallisce (caratteri speciali)
    if (!ok && !(await postTelegramMessage(token, { chat_id: chatId, text: chunk }))) {
      delivered = false
    }
  }
  return delivered
}

/**
 * La gemella esplicita: manda SENZA `parse_mode`, e riporta se è arrivato.
 *
 * Qui non c'è ripiego perché non serve: il ripiego di
 * `sendTelegramMessageChecked` *è* l'invio senza `parse_mode`, cioè questo. Se
 * questo fallisce, è fallito l'invio, non la formattazione.
 *
 * Chiamarla direttamente quando si sa di avere un comando in mano è lecito e
 * documenta l'intenzione; chi non lo sa è coperto comunque, perché
 * `sendTelegramMessageChecked` ci arriva da sola sul contenuto.
 */
export async function sendTelegramMessageComando(chatId: number, text: string): Promise<boolean> {
  const token = process.env.TELEGRAM_BOT_TOKEN
  if (!token) return false
  let delivered = true
  for (const chunk of splitTelegramText(text)) {
    if (!(await postTelegramMessage(token, { chat_id: chatId, text: chunk }))) delivered = false
  }
  return delivered
}

/** Invio "fire and forget": non rigetta mai, l'esito viene ignorato. */
export async function sendTelegramMessage(chatId: number, text: string): Promise<void> {
  await sendTelegramMessageChecked(chatId, text)
}

export async function sendTyping(chatId: number) {
  const token = process.env.TELEGRAM_BOT_TOKEN
  if (!token) return
  await fetch(`${TELEGRAM_API}${token}/sendChatAction`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, action: 'typing' }),
  }).catch(() => {})
}

export async function downloadTelegramFile(fileId: string): Promise<{ buffer: ArrayBuffer; fileName: string; mimeType: string } | null> {
  const token = process.env.TELEGRAM_BOT_TOKEN
  if (!token) return null
  const fileRes = await fetch(`${TELEGRAM_API}${token}/getFile`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ file_id: fileId }),
  })
  const fileData = await fileRes.json()
  const filePath = fileData.result?.file_path
  if (!filePath) return null
  const fileName = filePath.split('/').pop() || 'file'
  const ext = fileName.split('.').pop()?.toLowerCase() || ''
  const mimeMap: Record<string, string> = {
    pdf: 'application/pdf', doc: 'application/msword',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    odt: 'application/vnd.oasis.opendocument.text', rtf: 'application/rtf',
    xls: 'application/vnd.ms-excel',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ods: 'application/vnd.oasis.opendocument.spreadsheet', csv: 'text/csv',
    ppt: 'application/vnd.ms-powerpoint',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif',
    webp: 'image/webp', bmp: 'image/bmp', svg: 'image/svg+xml',
    tiff: 'image/tiff', tif: 'image/tiff', heic: 'image/heic',
    dwg: 'application/acad', dxf: 'application/dxf',
    txt: 'text/plain', md: 'text/markdown', json: 'application/json',
    xml: 'application/xml', html: 'text/html',
    zip: 'application/zip',
    mp4: 'video/mp4', mov: 'video/quicktime', avi: 'video/x-msvideo',
    mkv: 'video/x-matroska', webm: 'video/webm', m4v: 'video/x-m4v',
  }
  const res = await fetch(`https://api.telegram.org/file/bot${token}/${filePath}`)
  if (!res.ok) return null
  return { buffer: await res.arrayBuffer(), fileName, mimeType: mimeMap[ext] || 'application/octet-stream' }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function buildContentBlocks(fileData: { buffer: ArrayBuffer; fileName: string; mimeType: string }): Promise<any[]> {
  const { processFile } = await import('./file-pipeline')
  const result = await processFile(fileData)
  console.log(`[BUILD-CONTENT-BLOCKS] file=${fileData.fileName} strategy=${result.strategy} fileId=${result.uploadedFileId ?? '-'}`)
  return result.blocks
}

/**
 * ⭐ Ritorna se la consegna e' riuscita. Prima non tornava niente, e chi
 * chiamava non poteva distinguere un edit andato a buon fine da uno fallito:
 * l'Ingegnere restava col «🧠 Sto elaborando…» o con la risposta a meta',
 * mentre in `messages` la risposta completa risultava consegnata. Al turno
 * dopo scriveva «allora?» e il bot rispondeva come se avesse gia' detto tutto.
 *
 * Sul web l'equivalente non esiste: li' un `invia()` che fallisce significa che
 * il browser se n'e' andato, e salvare comunque e' la scelta giusta. Su
 * Telegram il destinatario e' sempre li'.
 */
export async function editTelegramMessage(
  chatId: number,
  messageId: number,
  text: string,
): Promise<boolean> {
  const token = process.env.TELEGRAM_BOT_TOKEN
  if (!token) return false
  const payload = text.slice(0, 4000) || '...'
  // FIX Bug 5: NON ingoiare errori in silenzio.
  // Telegram torna HTTP 200 con {ok:false, description:"..."} per errori applicativi
  // (es. "message is not modified", "rate limit"). .catch() non li intercetta:
  // bisogna ispezionare body.ok. Loggare tutto per diagnosi.
  try {
    const res = await fetch(`${TELEGRAM_API}${token}/editMessageText`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        message_id: messageId,
        text: payload,
        // ⭐ Anche gli EDIT: la risposta in streaming del modello può contenere
        // l'anteprima di un tool coi comandi (`/sal_ok_…`, `/fic_ok_…`), e
        // arriverebbe all'Ingegnere con gli underscore mangiati.
        ...parseModePer(payload),
      }),
    })
    const body = await res.json().catch(() => ({}))
    if (body?.ok) return true
    // "message is not modified" è benigno (testo identico al precedente edit) —
    // controlla PRIMA del fallback Markdown per evitare log warning quando il
    // primo tentativo già fallisce per contenuto identico.
    const desc = body?.description || `HTTP ${res.status}`
    // "not modified" vuol dire che quel testo e' GIA' li': consegnato.
    if (typeof desc === 'string' && /not modified/i.test(desc)) return true
    // Markdown fallito? Ritenta senza parse_mode.
    if (typeof desc === 'string' && /can't parse|markdown/i.test(desc)) {
      const res2 = await fetch(`${TELEGRAM_API}${token}/editMessageText`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, message_id: messageId, text: payload }),
      })
      const body2 = await res2.json().catch(() => ({}))
      if (body2?.ok) return true
      const desc2 = body2?.description || `HTTP ${res2.status}`
      // FIX Bug 6: anche il fallback può ricevere "not modified" se nel frattempo
      // un altro edit (con Markdown OK) ha scritto lo stesso testo. Benigno.
      if (typeof desc2 === 'string' && /not modified/i.test(desc2)) return true
      console.warn(`[TG edit] msg=${messageId} chars=${payload.length} fallback FAIL: ${desc2}`)
      return false
    }
    console.warn(`[TG edit] msg=${messageId} chars=${payload.length} FAIL: ${desc}`)
    return false
  } catch (err) {
    console.warn(`[TG edit] msg=${messageId} chars=${payload.length} NETWORK ERROR:`, err instanceof Error ? err.message : err)
    return false
  }
}

export async function sendTelegramMessageWithId(chatId: number, text: string): Promise<number | null> {
  const token = process.env.TELEGRAM_BOT_TOKEN
  if (!token) return null
  try {
    const res = await fetch(`${TELEGRAM_API}${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // ⭐ È PROPRIO QUESTA la funzione che manda la notifica della bozza mail
      // («Per inviare: /invia_… ❌ Per annullare: /annulla_…»): due comandi,
      // due underscore, e il Markdown li mangiava entrambi.
      body: JSON.stringify({ chat_id: chatId, text, ...parseModePer(text) }),
    })
    const data = await res.json()
    return data?.result?.message_id || null
  } catch {
    return null
  }
}


/**
 * La chat dell'Ingegnere: `ADMIN_CHAT_ID` se configurata, altrimenti il primo
 * id di `TELEGRAM_ALLOWED_IDS` (setup a utente singolo). Restituisce 0 se non
 * si riesce a determinarla — chi chiama DEVE dirlo, non tacere.
 *
 * Esiste come funzione unica perche' lo stesso ripiego era copiato in sei
 * punti, e dove NON era copiato ha fatto danni: il cron delle fatture estere
 * leggeva `TELEGRAM_RAFFAELE_CHAT_ID`, una variabile che su Vercel non esiste
 * (verificato il 5 set 2026). Il suo resoconto mensile era protetto da un
 * `if (RAFFAELE_CHAT_ID)`: per quattro mesi non e' partito NIENTE, e nessuno
 * poteva accorgersene perche' l'assenza di un messaggio non fa rumore.
 * Stessa trappola gia' vista nel circuit breaker il 5 maggio.
 * [[feedback_misura_non_e_dato]]
 */
export function chatAdmin(): number {
  const esplicita = parseInt(process.env.ADMIN_CHAT_ID || '0', 10)
  if (esplicita) return esplicita
  const primoAmmesso = (process.env.TELEGRAM_ALLOWED_IDS || '').split(',')[0]?.trim()
  return parseInt(primoAmmesso || '0', 10) || 0
}
