import { NextRequest, NextResponse } from 'next/server'
import Anthropic from '@anthropic-ai/sdk'
import crypto from 'crypto'
import { saveMessageWithEmbedding } from '@/lib/memory'
import { supabase } from '@/lib/supabase'
import { parseDocumentBlocks } from '@/lib/parseDocumentBlocks'

const client = new Anthropic()

// UUID deterministico da chat ID Telegram
function chatIdToUuid(chatId: number): string {
  const hash = crypto.createHash('md5').update(`telegram_${chatId}`).digest('hex')
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}`
}

const TELEGRAM_API = 'https://api.telegram.org/bot'

// System prompt CORTO — lascia Claude essere Claude
const SYSTEM_PROMPT = `Sei il Cervellone, assistente AI dell'Ing. Raffaele Lentini — Restruktura SRL, Villa d'Agri (PZ).
Restruktura: ingegneria strutturale, impresa edile, PonteggioSicuro.it (noleggio ponteggi).

Quando generi documenti strutturati (preventivi, computi, relazioni, tabelle), usa il blocco ~~~document con HTML professionale completo.
Intestazione: RESTRUKTURA S.r.l. — P.IVA 02087420762. Design di alta qualità, pronto per la stampa.
Quando fai un preventivo, genera SEMPRE anche un computo metrico con prezziario ufficiale di confronto.

Stai comunicando via Telegram. Rispondi conciso, usa *grassetto* e _corsivo_.
Dai del Lei all'Ingegnere. Rispondi in italiano. Non menzionare mai il tuo funzionamento interno.`

// Telegram autorizzati
function isAuthorized(chatId: number): boolean {
  const allowedIds = (process.env.TELEGRAM_ALLOWED_IDS || '').split(',').map(Number)
  return allowedIds.includes(chatId)
}

// Manda messaggio Telegram (con split per messaggi lunghi)
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
  })
}

// Scarica file da Telegram
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
    pdf: 'application/pdf',
    jpg: 'image/jpeg', jpeg: 'image/jpeg',
    png: 'image/png', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp',
    doc: 'application/msword',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  }

  const res = await fetch(`https://api.telegram.org/file/bot${token}/${filePath}`)
  if (!res.ok) return null
  return { buffer: await res.arrayBuffer(), fileName, mimeType: mimeMap[ext] || 'application/octet-stream' }
}

// Trascrivi audio con Whisper
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

// Costruisce content blocks per Claude — PDF come document, foto come image, Word come testo
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function buildContentBlocks(fileData: { buffer: ArrayBuffer; fileName: string; mimeType: string }): Promise<any[]> {
  const { buffer, fileName, mimeType } = fileData
  const base64 = Buffer.from(buffer).toString('base64')

  if (mimeType === 'application/pdf') {
    // PDF → manda direttamente a Claude come document block (come fa claude.ai)
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
    return []
  }
  return []
}

export async function POST(request: NextRequest) {
  let errorChatId: number | null = null
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

    // Testo e file
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

    // Documenti (PDF, Word)
    if (message.document) {
      await sendTyping(chatId)
      const fileSize = message.document.file_size || 0
      if (fileSize > 20 * 1024 * 1024) {
        await sendTelegramMessage(chatId, '⚠️ File troppo pesante (max 20 MB). Lo carichi dalla chat web.')
        return NextResponse.json({ ok: true })
      }
      const ext = (message.document.file_name || '').split('.').pop()?.toLowerCase() || ''
      if (!['pdf', 'jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'doc', 'docx'].includes(ext)) {
        await sendTelegramMessage(chatId, `⚠️ Formato .${ext} non supportato. Accettati: PDF, immagini, Word.`)
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

    // Niente testo né file → ignora
    if (!userText && fileBlocks.length === 0) return NextResponse.json({ ok: true })
    if (!userText && fileBlocks.length > 0) userText = `Analizza questo file: ${fileDescription}`

    // Auth
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

    await sendTyping(chatId)

    // Conversazione
    const conversationId = chatIdToUuid(chatId)
    const { data: existingConv } = await supabase.from('conversations').select('id').eq('id', conversationId).single()
    if (!existingConv) {
      await supabase.from('conversations').insert({ id: conversationId, title: '💬 Telegram' })
    }

    // Carica storia PRIMA di salvare il messaggio corrente
    const { data: recentMessages } = await supabase
      .from('messages').select('role, content')
      .eq('conversation_id', conversationId)
      .order('created_at', { ascending: true }).limit(20)

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const history: any[] = (recentMessages || [])
      .filter(m => m.role === 'user' || m.role === 'assistant')
      .map(m => ({ role: m.role, content: m.content }))

    // Aggiungi messaggio corrente CON file
    if (fileBlocks.length > 0) {
      history.push({ role: 'user', content: [...fileBlocks, { type: 'text', text: userText }] })
    } else {
      history.push({ role: 'user', content: userText })
    }

    // Salva messaggio utente in DB
    await supabase.from('messages').insert({ conversation_id: conversationId, role: 'user', content: userText })
    // Embedding in background (non blocca)
    saveMessageWithEmbedding(conversationId, 'user', userText).catch(() => {})

    // Assicura che inizi con user
    if (history.length > 0 && history[0].role !== 'user') history.shift()

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const hasFiles = fileBlocks.some((b: any) => b.type === 'image' || b.type === 'document')

    // UNA chiamata a Claude, max 2 iterazioni tool use
    const tools = [{ type: 'web_search_20250305' as const, name: 'web_search', max_uses: 5 }]

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let currentMessages: any[] = history
    let fullResponse = ''
    let iterations = 0
    const MAX_ITERATIONS = 2

    while (iterations < MAX_ITERATIONS) {
      iterations++
      await sendTyping(chatId)

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const params: any = {
        model: hasFiles ? 'claude-opus-4-6' : 'claude-sonnet-4-6',
        max_tokens: 16000,
        system: SYSTEM_PROMPT,
        messages: currentMessages,
        tools,
      }

      const response = await client.messages.create(params)

      for (const block of response.content) {
        if (block.type === 'text') fullResponse += block.text
      }

      // Se non c'è tool use o è end_turn → fine
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const hasToolUse = response.content.some((b: any) => b.type === 'tool_use')
      if (!hasToolUse || response.stop_reason === 'end_turn') break

      // Tool use → aggiungi risultati e richiama (max 1 volta in più)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const toolResults: any[] = []
      for (const block of response.content) {
        if (block.type === 'tool_use') {
          // web_search è gestito automaticamente da Anthropic, non serve executeTool
          toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: 'OK' })
        }
      }
      currentMessages = [
        ...currentMessages,
        { role: 'assistant', content: response.content },
        { role: 'user', content: toolResults },
      ]
    }

    // Salva risposta
    if (fullResponse) {
      await supabase.from('messages').insert({ conversation_id: conversationId, role: 'assistant', content: fullResponse })
      saveMessageWithEmbedding(conversationId, 'assistant', fullResponse).catch(() => {})

      if (hasFiles && fullResponse.length > 200) {
        const knowledge = `[Analisi file "${fileDescription}" da Telegram]\n\nDomanda: ${userText}\n\nAnalisi:\n${fullResponse.slice(0, 10000)}`
        saveMessageWithEmbedding(conversationId, 'knowledge', knowledge).catch(() => {})
      }
    }

    // Manda risposta su Telegram
    const responseBlocks = parseDocumentBlocks(fullResponse)
    let sentSomething = false

    for (const block of responseBlocks) {
      if (block.type === 'document') {
        const titleMatch = block.content.match(/<h1[^>]*>(.*?)<\/h1>/i)
          || block.content.match(/<title>(.*?)<\/title>/i)
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
      let userMsg = '⚠️ Errore temporaneo. Riprovi tra un momento.'
      if (msg.includes('credit') || msg.includes('billing') || msg.includes('429')) {
        userMsg = '⚠️ Crediti API esauriti o limite raggiunto.'
      } else if (msg.includes('too large') || msg.includes('payload')) {
        userMsg = '⚠️ File troppo pesante per essere analizzato. Provi con un file più piccolo o come foto.'
      }
      if (errorChatId) await sendTelegramMessage(errorChatId, userMsg)
    } catch { /* ignore */ }
    return NextResponse.json({ ok: true })
  }
}

export async function GET() {
  return NextResponse.json({ status: 'Cervellone Telegram webhook attivo' })
}
