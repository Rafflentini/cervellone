/**
 * lib/telegram-helpers.ts — Funzioni helper per Telegram
 * Estratte dalla route per riuso in altri moduli.
 */

const TELEGRAM_API = 'https://api.telegram.org/bot'

export async function sendTelegramMessage(chatId: number, text: string) {
  const token = process.env.TELEGRAM_BOT_TOKEN
  if (!token) return
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
  for (const chunk of chunks) {
    await fetch(`${TELEGRAM_API}${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: chunk, parse_mode: 'Markdown' }),
    }).catch(async () => {
      // Fallback senza parse_mode se Markdown fallisce (caratteri speciali)
      await fetch(`${TELEGRAM_API}${token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text: chunk }),
      }).catch(() => {})
    })
  }
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

export async function editTelegramMessage(chatId: number, messageId: number, text: string) {
  const token = process.env.TELEGRAM_BOT_TOKEN
  if (!token) return
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
        parse_mode: 'Markdown',
      }),
    })
    const body = await res.json().catch(() => ({}))
    if (body?.ok) return
    // "message is not modified" è benigno (testo identico al precedente edit) —
    // controlla PRIMA del fallback Markdown per evitare log warning quando il
    // primo tentativo già fallisce per contenuto identico.
    const desc = body?.description || `HTTP ${res.status}`
    if (typeof desc === 'string' && /not modified/i.test(desc)) return
    // Markdown fallito? Ritenta senza parse_mode.
    if (typeof desc === 'string' && /can't parse|markdown/i.test(desc)) {
      const res2 = await fetch(`${TELEGRAM_API}${token}/editMessageText`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, message_id: messageId, text: payload }),
      })
      const body2 = await res2.json().catch(() => ({}))
      if (body2?.ok) return
      const desc2 = body2?.description || `HTTP ${res2.status}`
      // FIX Bug 6: anche il fallback può ricevere "not modified" se nel frattempo
      // un altro edit (con Markdown OK) ha scritto lo stesso testo. Benigno.
      if (typeof desc2 === 'string' && /not modified/i.test(desc2)) return
      console.warn(`[TG edit] msg=${messageId} chars=${payload.length} fallback FAIL: ${desc2}`)
      return
    }
    console.warn(`[TG edit] msg=${messageId} chars=${payload.length} FAIL: ${desc}`)
  } catch (err) {
    console.warn(`[TG edit] msg=${messageId} chars=${payload.length} NETWORK ERROR:`, err instanceof Error ? err.message : err)
  }
}

export async function sendTelegramMessageWithId(chatId: number, text: string): Promise<number | null> {
  const token = process.env.TELEGRAM_BOT_TOKEN
  if (!token) return null
  try {
    const res = await fetch(`${TELEGRAM_API}${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown' }),
    })
    const data = await res.json()
    return data?.result?.message_id || null
  } catch {
    return null
  }
}

/**
 * Helper unificato per heartbeat su task lunghi durable.
 * Aggiorna il placeholder iniziale via editMessageText.
 * Stessa logica di editTelegramMessage ma con nome semantico per il dispatch.
 */
export async function sendHeartbeatToTelegram(
  chatId: number,
  messageId: number,
  text: string,
): Promise<void> {
  await editTelegramMessage(chatId, messageId, text)
}

export async function transcribeAudio(fileId: string): Promise<string> {
  const token = process.env.TELEGRAM_BOT_TOKEN
  if (!token) return ''
  const fileRes = await fetch(`${TELEGRAM_API}${token}/getFile`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ file_id: fileId }),
  })
  const fileData = await fileRes.json()
  const filePath = fileData.result?.file_path
  if (!filePath) return ''
  const audioRes = await fetch(`https://api.telegram.org/file/bot${token}/${filePath}`)
  const audioBuffer = await audioRes.arrayBuffer()
  const formData = new FormData()
  formData.append('file', new Blob([audioBuffer], { type: 'audio/ogg' }), 'voice.ogg')
  formData.append('model', 'whisper-1')
  formData.append('language', 'it')
  const whisperRes = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}` },
    body: formData,
  })
  if (!whisperRes.ok) return ''
  const data = await whisperRes.json()
  return data.text || ''
}
