import { NextRequest, NextResponse } from 'next/server'
import Anthropic from '@anthropic-ai/sdk'
import crypto from 'crypto'
import { saveMessageWithEmbedding } from '@/lib/memory'
import { supabase } from '@/lib/supabase'
import { parseDocumentBlocks } from '@/lib/parseDocumentBlocks'
import { TELEGRAM_SYSTEM_PROMPT } from '@/lib/prompts'

const client = new Anthropic()

function chatIdToUuid(chatId: number): string {
  const hash = crypto.createHash('md5').update(`telegram_${chatId}`).digest('hex')
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}`
}

const TELEGRAM_API = 'https://api.telegram.org/bot'

function isAuthorized(chatId: number): boolean {
  const allowedIds = (process.env.TELEGRAM_ALLOWED_IDS || '').split(',').map(Number)
  return allowedIds.includes(chatId)
}

async function sendTelegramMessage(chatId: number, text: string) {
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
      body: JSON.stringify({ chat_id: chatId, text: chunk }),
    })
  }
}

async function sendTyping(chatId: number) {
  const token = process.env.TELEGRAM_BOT_TOKEN
  if (!token) return
  await fetch(`${TELEGRAM_API}${token}/sendChatAction`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, action: 'typing' }),
  }).catch(() => {})
}

async function downloadTelegramFile(fileId: string): Promise<{ buffer: ArrayBuffer; fileName: string; mimeType: string } | null> {
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
    // Documenti
    pdf: 'application/pdf',
    doc: 'application/msword',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    odt: 'application/vnd.oasis.opendocument.text',
    rtf: 'application/rtf',
    // Spreadsheet
    xls: 'application/vnd.ms-excel',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ods: 'application/vnd.oasis.opendocument.spreadsheet',
    csv: 'text/csv',
    // Presentazioni
    ppt: 'application/vnd.ms-powerpoint',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    odp: 'application/vnd.oasis.opendocument.presentation',
    // Immagini
    jpg: 'image/jpeg', jpeg: 'image/jpeg',
    png: 'image/png', gif: 'image/gif', webp: 'image/webp',
    bmp: 'image/bmp', svg: 'image/svg+xml',
    tiff: 'image/tiff', tif: 'image/tiff',
    heic: 'image/heic', heif: 'image/heif',
    ico: 'image/x-icon',
    // CAD / Tecnici
    dwg: 'application/acad', dxf: 'application/dxf',
    // Testo / Dati
    txt: 'text/plain', md: 'text/markdown',
    json: 'application/json', xml: 'application/xml',
    html: 'text/html', htm: 'text/html',
    // Archivi
    zip: 'application/zip', rar: 'application/x-rar-compressed',
    '7z': 'application/x-7z-compressed',
  }
  const res = await fetch(`https://api.telegram.org/file/bot${token}/${filePath}`)
  if (!res.ok) return null
  return { buffer: await res.arrayBuffer(), fileName, mimeType: mimeMap[ext] || 'application/octet-stream' }
}

async function transcribeAudio(fileId: string): Promise<string> {
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function buildContentBlocks(fileData: { buffer: ArrayBuffer; fileName: string; mimeType: string }): Promise<any[]> {
  const { buffer, fileName, mimeType } = fileData
  const base64 = Buffer.from(buffer).toString('base64')
  if (mimeType === 'application/pdf') {
    return [{ type: 'document', source: { type: 'base64', media_type: mimeType, data: base64 } }]
  }
  if (mimeType.startsWith('image/')) {
    return [{ type: 'image', source: { type: 'base64', media_type: mimeType, data: base64 } }]
  }
  if (mimeType.includes('word') || mimeType === 'application/msword') {
    try {
      const mammoth = await import('mammoth')
      const result = await mammoth.extractRawText({ arrayBuffer: buffer })
      if (result.value && result.value.length > 50) {
        return [{ type: 'text', text: `[File Word: ${fileName}]\n\n${result.value}` }]
      }
    } catch { /* ignore */ }
  }
  // ODS (spreadsheet OpenDocument) — estrai testo dal XML interno
  if (fileName.endsWith('.ods')) {
    try {
      const JSZip = (await import('jszip')).default
      const zip = await JSZip.loadAsync(Buffer.from(buffer))
      const xml = await zip.file('content.xml')?.async('string')
      if (xml) {
        // Estrai testo dalle celle
        const rows: string[] = []
        const rowRe = /<table:table-row[^>]*>([\s\S]*?)<\/table:table-row>/g
        let rm
        while ((rm = rowRe.exec(xml)) !== null) {
          const cells: string[] = []
          const cellRe = /<table:table-cell([^>]*)>([\s\S]*?)<\/table:table-cell>/g
          let cm
          while ((cm = cellRe.exec(rm[1])) !== null) {
            const txt = (cm[2] || '').replace(/<[^>]+>/g, '').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&amp;/g,'&').replace(/&apos;/g,"'").trim()
            if (txt) cells.push(txt)
          }
          if (cells.length >= 2) rows.push(cells.join(' | '))
        }
        const text = rows.slice(0, 5000).join('\n') // Max 5000 righe
        if (text.length > 50) {
          return [{ type: 'text', text: `[File ODS: ${fileName}]\n\n${text.slice(0, 100000)}` }]
        }
      }
    } catch { /* ignore */ }
  }
  // CSV/TXT — manda come testo
  if (fileName.endsWith('.csv') || fileName.endsWith('.txt')) {
    const text = Buffer.from(buffer).toString('utf-8')
    if (text.length > 50) {
      return [{ type: 'text', text: `[File ${fileName}]\n\n${text.slice(0, 100000)}` }]
    }
  }
  // Excel — prova con testo grezzo (limitato)
  if (fileName.endsWith('.xlsx') || fileName.endsWith('.xls')) {
    try {
      const JSZip = (await import('jszip')).default
      const zip = await JSZip.loadAsync(Buffer.from(buffer))
      const shared = await zip.file('xl/sharedStrings.xml')?.async('string')
      if (shared) {
        const texts: string[] = []
        const re = /<t[^>]*>([\s\S]*?)<\/t>/g
        let m
        while ((m = re.exec(shared)) !== null) texts.push(m[1].trim())
        if (texts.length > 0) {
          return [{ type: 'text', text: `[File Excel: ${fileName}]\n\n${texts.join(' | ').slice(0, 100000)}` }]
        }
      }
    } catch { /* ignore */ }
  }
  // Fallback: qualsiasi altro file — prova a leggerlo come testo
  try {
    const text = Buffer.from(buffer).toString('utf-8')
    // Se contiene caratteri leggibili, mandalo come testo
    const printable = text.replace(/[^\x20-\x7E\r\n\t\xC0-\xFF]/g, '')
    if (printable.length > text.length * 0.5 && text.length > 50) {
      return [{ type: 'text', text: `[File: ${fileName}]\n\n${text.slice(0, 100000)}` }]
    }
  } catch { /* ignore */ }
  // File binario non leggibile ��� informa Claude
  return [{ type: 'text', text: `[File binario: ${fileName}, ${(buffer.byteLength / 1024).toFixed(0)} KB, tipo: ${mimeType}] — File non leggibile come testo. Comunicare all'utente che il formato richiede strumenti specifici.` }]
}

export const maxDuration = 300

export async function POST(request: NextRequest) {
  let errorChatId: number | null = null
  let typingInterval: NodeJS.Timeout | null = null
  try {
    const body = await request.json()
    const message = body.message
    if (!message) return NextResponse.json({ ok: true })

    const chatId: number = message.chat.id
    errorChatId = chatId

    // Dedup
    const msgId = message.message_id
    if (msgId) {
      const { data: existing } = await supabase
        .from('telegram_dedup').select('message_id')
        .eq('chat_id', chatId).eq('message_id', msgId).limit(1)
      if (existing && existing.length > 0) return NextResponse.json({ ok: true })
      await supabase.from('telegram_dedup').insert({ chat_id: chatId, message_id: msgId })
    }

    let userText = message.text || message.caption || ''
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let fileBlocks: any[] = []
    let fileDescription = ''

    // Vocali
    if (!userText && (message.voice || message.audio)) {
      const fileId = message.voice?.file_id || message.audio?.file_id
      if (fileId) {
        await sendTyping(chatId)
        userText = await transcribeAudio(fileId)
        if (!userText) {
          await sendTelegramMessage(chatId, 'Non sono riuscito a trascrivere il vocale. Riprovi.')
          return NextResponse.json({ ok: true })
        }
      }
    }

    // Documenti
    if (message.document) {
      await sendTyping(chatId)
      const fileSize = message.document.file_size || 0
      if (fileSize > 20 * 1024 * 1024) {
        await sendTelegramMessage(chatId, '⚠️ File troppo pesante (max 20 MB). Lo carichi dalla chat web.')
        return NextResponse.json({ ok: true })
      }
      const ext = (message.document.file_name || '').split('.').pop()?.toLowerCase() || ''
      // Accetta QUALSIASI formato — Claude decide cosa farne
      // Solo file senza estensione vengono rifiutati
      if (!ext) {
        await sendTelegramMessage(chatId, '⚠️ File senza estensione. Rinomini il file e riprovi.')
        return NextResponse.json({ ok: true })
      }
      const fileData = await downloadTelegramFile(message.document.file_id)
      if (!fileData) {
        await sendTelegramMessage(chatId, '⚠️ Non riesco a scaricare il file. Riprovi.')
        return NextResponse.json({ ok: true })
      }
      fileBlocks = await buildContentBlocks(fileData)
      fileDescription = message.document.file_name || fileData.fileName
    }

    // Foto
    if (message.photo && message.photo.length > 0) {
      await sendTyping(chatId)
      const largest = message.photo[message.photo.length - 1]
      const fileData = await downloadTelegramFile(largest.file_id)
      if (fileData) {
        fileBlocks = await buildContentBlocks(fileData)
        fileDescription = fileData.fileName
      }
    }

    if (!userText && fileBlocks.length === 0) return NextResponse.json({ ok: true })
    if (!userText && fileBlocks.length > 0) userText = `Analizza questo file: ${fileDescription}`

    if (!isAuthorized(chatId)) {
      await sendTelegramMessage(chatId, '⛔ Non autorizzato.')
      return NextResponse.json({ ok: true })
    }

    // Comandi
    if (userText === '/start') {
      await sendTelegramMessage(chatId, '🧠 *Cervellone attivo.* Come posso aiutarLa?')
      return NextResponse.json({ ok: true })
    }
    if (userText === '/id') {
      await sendTelegramMessage(chatId, `Chat ID: ${chatId}`)
      return NextResponse.json({ ok: true })
    }
    if (userText === '/nuova') {
      await supabase.from('messages').delete().eq('conversation_id', chatIdToUuid(chatId))
      await sendTelegramMessage(chatId, 'Conversazione azzerata.')
      return NextResponse.json({ ok: true })
    }

    // Typing periodico — FIX: gestito con try/finally per evitare memory leak
    typingInterval = setInterval(() => sendTyping(chatId), 4000)
    await sendTyping(chatId)

    // Memoria RAG
    const { searchMemory } = await import('@/lib/memory')
    const memoryContext = await searchMemory(userText)

    // Conversazione
    const conversationId = chatIdToUuid(chatId)
    const { data: existingConv } = await supabase.from('conversations').select('id').eq('id', conversationId).single()
    if (!existingConv) {
      await supabase.from('conversations').insert({ id: conversationId, title: '💬 Telegram' })
    }

    // Storia
    const { data: recentMessages } = await supabase
      .from('messages').select('role, content')
      .eq('conversation_id', conversationId)
      .order('created_at', { ascending: true }).limit(20)

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const history: any[] = (recentMessages || [])
      .filter(m => m.role === 'user' || m.role === 'assistant')
      .map(m => ({ role: m.role, content: m.content }))

    if (fileBlocks.length > 0) {
      history.push({ role: 'user', content: [...fileBlocks, { type: 'text', text: userText }] })
    } else {
      history.push({ role: 'user', content: userText })
    }

    // FIX: salva messaggio con fallback se embedding fallisce
    try {
      await saveMessageWithEmbedding(conversationId, 'user', userText)
    } catch {
      await supabase.from('messages').insert({ conversation_id: conversationId, role: 'user', content: userText })
    }

    if (history.length > 0 && history[0].role !== 'user') history.shift()

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const hasFiles = fileBlocks.some((b: any) => b.type === 'image' || b.type === 'document')

    // Routing: Sonnet default, Opus per ragionamento complesso
    const needsOpus = /relazione tecnica|calcolo strutturale|analisi normativa|confronto complesso|perizia/i.test(userText) && !hasFiles
    const model = needsOpus ? 'claude-opus-4-6' : 'claude-sonnet-4-6'

    const tools = [{ type: 'web_search_20250305' as const, name: 'web_search', max_uses: 5 }]

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let currentMessages: any[] = history
    let fullResponse = ''
    let iterations = 0
    const MAX_ITERATIONS = 4
    let consecutiveToolOnly = 0 // FIX: freno per loop tool-only

    while (iterations < MAX_ITERATIONS) {
      iterations++

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const params: any = {
        model,
        max_tokens: 16000,
        system: TELEGRAM_SYSTEM_PROMPT + memoryContext,
        messages: currentMessages,
        tools,
      }

      const response = await client.messages.create(params)

      let hasText = false
      for (const block of response.content) {
        if (block.type === 'text') { fullResponse += block.text; hasText = true }
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const hasToolUse = response.content.some((b: any) => b.type === 'tool_use')
      if (!hasToolUse || response.stop_reason === 'end_turn') break

      // FIX: freno loop tool-only — se Claude fa solo tool use senza testo 2 volte, fermati
      if (hasToolUse && !hasText) {
        consecutiveToolOnly++
        if (consecutiveToolOnly >= 2) break
      } else {
        consecutiveToolOnly = 0
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const toolResults: any[] = []
      for (const block of response.content) {
        if (block.type === 'tool_use') {
          toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: 'OK' })
        }
      }
      currentMessages = [
        ...currentMessages,
        { role: 'assistant', content: response.content },
        { role: 'user', content: toolResults },
      ]
    }

    // FIX: pulisci interval SEMPRE prima di qualsiasi operazione post-Claude
    if (typingInterval) { clearInterval(typingInterval); typingInterval = null }

    // Salva risposta con fallback
    if (fullResponse) {
      try {
        await saveMessageWithEmbedding(conversationId, 'assistant', fullResponse)
      } catch {
        await supabase.from('messages').insert({ conversation_id: conversationId, role: 'assistant', content: fullResponse })
      }

      if (hasFiles && fullResponse.length > 200) {
        const knowledge = `[Analisi file "${fileDescription}" da Telegram]\n\nDomanda: ${userText}\n\nAnalisi:\n${fullResponse.slice(0, 10000)}`
        saveMessageWithEmbedding(conversationId, 'knowledge', knowledge).catch(() => {})
      }
    }

    // Manda risposta
    const responseBlocks = parseDocumentBlocks(fullResponse)
    let sentSomething = false

    for (const block of responseBlocks) {
      if (block.type === 'document') {
        const titleMatch = block.content.match(/<h1[^>]*>(.*?)<\/h1>/i) || block.content.match(/<title>(.*?)<\/title>/i)
        const title = titleMatch ? titleMatch[1].replace(/<[^>]+>/g, '').trim() : 'Documento'
        const totalMatch = block.content.match(/([\d.,]+\s*(?:\u20AC|EUR|€))/i)
        const totalInfo = totalMatch ? `\n💰 ${totalMatch[1].trim()}` : ''
        const rowCount = (block.content.match(/<tr/gi) || []).length
        const rowInfo = rowCount > 2 ? `\n📊 ${rowCount - 1} voci` : ''

        let docUrl = 'https://cervellone-5poc.vercel.app'
        const { data: savedDoc } = await supabase
          .from('documents')
          .insert({ name: title, content: block.content, conversation_id: conversationId, type: 'html', metadata: { source: 'telegram' } })
          .select('id').single()
        if (savedDoc?.id) docUrl = `https://cervellone-5poc.vercel.app/doc/${savedDoc.id}`

        await sendTelegramMessage(chatId, `────────────────────\n📄 *${title}*${totalInfo}${rowInfo}\n────────────────────\n\n👉 ${docUrl}`)
        sentSomething = true
      } else if (block.content.trim()) {
        await sendTelegramMessage(chatId, block.content)
        sentSomething = true
      }
    }

    if (!sentSomething) {
      await sendTelegramMessage(chatId, fullResponse || 'Non sono riuscito a elaborare una risposta.')
    }

    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error('TELEGRAM errore:', err)
    try {
      const msg = err instanceof Error ? err.message : String(err)
      let userMsg = `⚠️ ${msg.slice(0, 300)}`
      if (msg.includes('credit') || msg.includes('billing') || msg.includes('usage limit')) {
        userMsg = '⚠️ Crediti API esauriti o limite raggiunto. Controllare console.anthropic.com'
      } else if (msg.includes('too large') || msg.includes('payload')) {
        userMsg = '⚠️ File troppo pesante per essere analizzato.'
      }
      if (errorChatId) await sendTelegramMessage(errorChatId, userMsg)
    } catch { /* ignore */ }
    return NextResponse.json({ ok: true })
  } finally {
    // FIX CRITICO: pulisci SEMPRE il typing interval, anche se crash
    if (typingInterval) clearInterval(typingInterval)
  }
}

export async function GET() {
  return NextResponse.json({ status: 'Cervellone Telegram webhook attivo' })
}
