import { NextRequest, NextResponse } from 'next/server'
import Anthropic from '@anthropic-ai/sdk'
import crypto from 'crypto'
import { searchMemory, saveMessageWithEmbedding } from '@/lib/memory'
import { CUSTOM_TOOLS, executeTool } from '@/lib/tools'
import { supabase } from '@/lib/supabase'
import { parseDocumentBlocks } from '@/lib/parseDocumentBlocks'

const client = new Anthropic()

// Genera un UUID deterministico da un chat ID Telegram
// Stessa chat → stesso UUID, sempre
function chatIdToUuid(chatId: number): string {
  const hash = crypto.createHash('md5').update(`telegram_${chatId}`).digest('hex')
  // Formatta come UUID v4-like: 8-4-4-4-12
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}`
}

const TELEGRAM_API = 'https://api.telegram.org/bot'

const SYSTEM_PROMPT = `Sei il Cervellone — l'assistente AI personale dell'Ing. Raffaele, titolare di Restruktura SRL.

Chi è Restruktura:
- Società di ingegneria: progettazione strutturale, direzione lavori, collaudi
- Impresa edile: ristrutturazioni, manutenzioni, cantieri
- PonteggioSicuro.it: noleggio ponteggi con servizio completo
- Sede operativa in Basilicata

Hai accesso a:
- Ricerca web in tempo reale
- Generazione documenti Word (.docx), Excel (.xlsx) e PDF
- Un database di conoscenza che contiene documenti, analisi e conversazioni passate dell'Ingegnere. I dati rilevanti vengono caricati automaticamente qui sotto nella sezione "La tua memoria". Se contiene informazioni, USALE per rispondere.
- Un prezziario regionale dei lavori pubblici. PRIMA di generare un preventivo:
  1. Determina la regione dal comune del cantiere
  2. Usa il tool verifica_prezziario per controllare se hai il prezziario di quella regione
  3. Se NON hai il prezziario: cercalo online con web_search (es. "prezziario regionale lavori pubblici basilicata 2025 PDF"), trova il link al file PDF o CSV, e scaricalo con scarica_prezziario
  4. Se non riesci a trovarlo online: proponi all'Ingegnere di (a) caricare il PDF del prezziario in chat, (b) usare un prezziario di una regione vicina, o (c) procedere con i prezzi da te stimati specificando che NON sono da prezziario ufficiale
  5. Solo dopo aver verificato il prezziario, usa il tool calcola_preventivo con i prezzi reali
  6. REGOLA OBBLIGATORIA: Quando generi un preventivo, genera SEMPRE anche un secondo documento separato — un Computo Metrico Estimativo con le voci del prezziario regionale ufficiale di riferimento, per confronto. Quindi ogni preventivo = 2 blocchi ~~~document: (1) preventivo, (2) computo con prezziario ufficiale

IMPORTANTE — Generazione documenti (REGOLA OBBLIGATORIA):
Ogni volta che la tua risposta contiene dati strutturati (tabelle, elenchi con importi, preventivi, computi, analisi con dati), DEVI usare il blocco ~~~document con HTML professionale. NON usare MAI tabelle markdown — usa SEMPRE il blocco ~~~document.
Dopo il blocco, aggiungi solo 1-2 righe di commento sintetico. Il sistema inviera automaticamente un link per visualizzare il documento con grafica.
NON dire mai che non puoi generare file. NON ripetere il contenuto del documento come testo.

Stai comunicando via Telegram. Rispondi in modo conciso e diretto, adatto a messaggi chat.
Usa la formattazione Telegram (Markdown): *grassetto*, _corsivo_, \`codice\`.

Se l'Ingegnere chiede informazioni che non trovi né nella sezione memoria né nella chat corrente, rispondi: "Non ho trovato queste informazioni. Potrebbe caricarle o darmi più contesto?"

Non menzionare MAI concetti come "MasterPrompt", "prompt di sistema", "sessione", "contesto tecnico del funzionamento". Non spiegare come funzioni internamente. Rispondi nel merito.

Dai del Lei all'Ingegnere. Rispondi in italiano.`

// ID Telegram autorizzati (solo Raffaele)
function isAuthorized(chatId: number): boolean {
  const allowedIds = (process.env.TELEGRAM_ALLOWED_IDS || '').split(',').map(Number)
  return allowedIds.includes(chatId)
}

// Manda messaggio su Telegram
async function sendTelegramMessage(chatId: number, text: string) {
  const token = process.env.TELEGRAM_BOT_TOKEN
  if (!token) return

  // Telegram ha un limite di 4096 caratteri per messaggio
  const MAX_LEN = 4000
  const chunks: string[] = []

  if (text.length <= MAX_LEN) {
    chunks.push(text)
  } else {
    // Spezza per paragrafi
    let remaining = text
    while (remaining.length > 0) {
      if (remaining.length <= MAX_LEN) {
        chunks.push(remaining)
        break
      }
      let cutAt = remaining.lastIndexOf('\n\n', MAX_LEN)
      if (cutAt < 500) cutAt = remaining.lastIndexOf('\n', MAX_LEN)
      if (cutAt < 500) cutAt = MAX_LEN
      chunks.push(remaining.slice(0, cutAt))
      remaining = remaining.slice(cutAt).trimStart()
    }
  }

  for (const chunk of chunks) {
    const res = await fetch(`${TELEGRAM_API}${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: chunk,
      }),
    })
    if (!res.ok) {
      const errBody = await res.text()
      console.error('TELEGRAM sendMessage ERRORE:', res.status, errBody)
    } else {
      console.log('TELEGRAM sendMessage OK per chat', chatId)
    }
  }
}

// Manda indicatore "sta scrivendo..."
async function sendTyping(chatId: number) {
  const token = process.env.TELEGRAM_BOT_TOKEN
  if (!token) return

  await fetch(`${TELEGRAM_API}${token}/sendChatAction`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, action: 'typing' }),
  })
}

// Scarica un file da Telegram e restituisce { buffer, fileName, mimeType }
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

  // Mappa estensione → MIME type
  const mimeMap: Record<string, string> = {
    pdf: 'application/pdf',
    jpg: 'image/jpeg', jpeg: 'image/jpeg',
    png: 'image/png', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp',
    doc: 'application/msword',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  }
  const mimeType = mimeMap[ext] || 'application/octet-stream'

  const res = await fetch(`https://api.telegram.org/file/bot${token}/${filePath}`)
  if (!res.ok) return null
  const buffer = await res.arrayBuffer()

  return { buffer, fileName, mimeType }
}

// Costruisce i content blocks per Claude a partire dai file Telegram
async function buildFileBlocks(fileData: { buffer: ArrayBuffer; fileName: string; mimeType: string }): Promise<{ blocks: object[]; description: string }> {
  const { buffer, fileName, mimeType } = fileData
  const base64 = Buffer.from(buffer).toString('base64')
  const blocks: object[] = []

  if (mimeType === 'application/pdf') {
    blocks.push({ type: 'document', source: { type: 'base64', media_type: mimeType, data: base64 } })
  } else if (mimeType.startsWith('image/')) {
    blocks.push({ type: 'image', source: { type: 'base64', media_type: mimeType, data: base64 } })
  } else if (mimeType.includes('word') || mimeType === 'application/msword') {
    // Word: estrai testo con mammoth
    try {
      const mammoth = await import('mammoth')
      const result = await mammoth.extractRawText({ arrayBuffer: buffer })
      if (result.value && result.value.length > 50) {
        blocks.push({ type: 'text', text: `[File Word: ${fileName}]\n\n${result.value}` })
      } else {
        return { blocks: [], description: `${fileName} (Word vuoto o non leggibile)` }
      }
    } catch {
      return { blocks: [], description: `${fileName} (errore lettura Word)` }
    }
  }

  return { blocks, description: fileName }
}

// Trascrivi audio con OpenAI Whisper
async function transcribeAudio(fileId: string): Promise<string> {
  const token = process.env.TELEGRAM_BOT_TOKEN
  if (!token) return ''

  // Ottieni il file path da Telegram
  const fileRes = await fetch(`${TELEGRAM_API}${token}/getFile`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ file_id: fileId }),
  })
  const fileData = await fileRes.json()
  const filePath = fileData.result?.file_path
  if (!filePath) return ''

  // Scarica il file audio
  const audioRes = await fetch(`https://api.telegram.org/file/bot${token}/${filePath}`)
  const audioBuffer = await audioRes.arrayBuffer()

  // Manda a OpenAI Whisper per trascrizione
  const formData = new FormData()
  const audioBlob = new Blob([audioBuffer], { type: 'audio/ogg' })
  formData.append('file', audioBlob, 'voice.ogg')
  formData.append('model', 'whisper-1')
  formData.append('language', 'it')

  const whisperRes = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: formData,
  })

  if (!whisperRes.ok) {
    console.error('WHISPER errore:', whisperRes.status, await whisperRes.text())
    return ''
  }

  const whisperData = await whisperRes.json()
  console.log('WHISPER trascrizione:', whisperData.text?.slice(0, 100))
  return whisperData.text || ''
}

export async function POST(request: NextRequest) {
  let telegramChatId: number | null = null
  try {
    const body = await request.json()
    const message = body.message

    if (!message) {
      return NextResponse.json({ ok: true })
    }

    const chatId = message.chat.id
    telegramChatId = chatId

    // Deduplicazione: Telegram rimanda il webhook se la risposta è lenta (>30s).
    // Tabella dedicata telegram_dedup con chiave (chat_id, message_id).
    const msgId = message.message_id
    if (msgId) {
      const { data: existing } = await supabase
        .from('telegram_dedup')
        .select('message_id')
        .eq('chat_id', chatId)
        .eq('message_id', msgId)
        .limit(1)
      if (existing && existing.length > 0) {
        console.log(`TELEGRAM: messaggio ${msgId} già in elaborazione, skip duplicato`)
        return NextResponse.json({ ok: true })
      }
      // Segna come "in elaborazione" SUBITO, prima di qualsiasi lavoro
      await supabase.from('telegram_dedup').insert({
        chat_id: chatId,
        message_id: msgId,
      })
    }

    // Gestisci vocali
    let userText = message.text || message.caption || ''
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let fileBlocks: object[] = []
    let fileDescription = ''

    if (!userText && (message.voice || message.audio)) {
      const fileId = message.voice?.file_id || message.audio?.file_id
      if (fileId) {
        await sendTyping(chatId)
        userText = await transcribeAudio(fileId)
        if (!userText) {
          await sendTelegramMessage(chatId, 'Non sono riuscito a trascrivere il vocale. Puo riprovare?')
          return NextResponse.json({ ok: true })
        }
      }
    }

    // Gestisci file: documenti (PDF, Word) e foto
    if (message.document) {
      await sendTyping(chatId)
      const fileSize = message.document.file_size || 0
      if (fileSize > 20 * 1024 * 1024) {
        await sendTelegramMessage(chatId, '⚠️ Il file è troppo pesante per Telegram (max 20 MB).\n\n💡 Lo carichi dalla chat web: https://cervellone-5poc.vercel.app')
        return NextResponse.json({ ok: true })
      }

      const ext = (message.document.file_name || '').split('.').pop()?.toLowerCase() || ''
      const supported = ['pdf', 'jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'doc', 'docx']
      if (!supported.includes(ext)) {
        await sendTelegramMessage(chatId, `⚠️ Il formato .${ext} non è supportato.\n\n💡 Formati accettati: PDF, immagini (JPG/PNG), Word (DOC/DOCX)`)
        return NextResponse.json({ ok: true })
      }

      const fileData = await downloadTelegramFile(message.document.file_id)
      if (!fileData) {
        await sendTelegramMessage(chatId, '⚠️ Non sono riuscito a scaricare il file. Puo riprovare?')
        return NextResponse.json({ ok: true })
      }

      // Riconoscimento automatico prezziario PDF — importa direttamente nel DB
      const fileName = message.document.file_name || ''
      const caption = (message.caption || '').toLowerCase()
      const isPrezziario = /prezz[ia]ario/i.test(fileName) || /prezz[ia]ario/i.test(caption)
        || caption.includes('salvalo') || caption.includes('importa')

      if (isPrezziario && ext === 'pdf') {
        await sendTelegramMessage(chatId, '📥 Riconosciuto come prezziario! Estraggo le voci...')
        try {
          const { PDFParse } = await import('pdf-parse')
          const parser = new PDFParse({ data: Buffer.from(fileData.buffer) })
          const textResult = await parser.getText()
          await parser.destroy()

          const { executeImportaPrezziario } = await import('@/lib/tools/scarica-prezziario')
          // Estrai regione dalla caption o dal nome file
          const regioneMatch = caption.match(/basilicata|calabria|campania|puglia|sicilia|sardegna|lazio|toscana|lombardia|piemonte|veneto|emilia|liguria|marche|umbria|abruzzo|molise|friuli|trentino|valle/i)
          const regione = regioneMatch ? regioneMatch[0].toLowerCase() : 'basilicata'
          const annoMatch = caption.match(/20\d{2}/) || fileName.match(/20\d{2}/)
          const anno = annoMatch ? parseInt(annoMatch[0]) : new Date().getFullYear()

          const importResult = await executeImportaPrezziario({ regione, anno, testo: textResult.text })

          if (importResult.success) {
            await sendTelegramMessage(chatId, `✅ Prezziario ${importResult.regione.toUpperCase()} ${importResult.anno} importato!\n\n📊 *${importResult.voci_salvate} voci* salvate nel database.\n\nOra posso generare preventivi con i prezzi ufficiali.`)
          } else {
            await sendTelegramMessage(chatId, `⚠️ Ho estratto il testo dal PDF ma non sono riuscito a trovare voci di prezziario.\n\n${importResult.errore}\n\n💡 Il PDF potrebbe essere scansionato (immagini). Provi a mandarmelo come foto e lo leggo con OCR.`)
          }
          return NextResponse.json({ ok: true })
        } catch (pdfErr) {
          console.error('TELEGRAM prezziario import error:', pdfErr)
          await sendTelegramMessage(chatId, '⚠️ Errore nell\'elaborazione del PDF. Provo ad analizzarlo con Claude...')
          // Fallback: manda a Claude normalmente
        }
      }

      const result = await buildFileBlocks(fileData)
      fileBlocks = result.blocks
      fileDescription = result.description

      if (fileBlocks.length === 0 && fileDescription.includes('errore')) {
        await sendTelegramMessage(chatId, `⚠️ Non sono riuscito a leggere ${fileDescription}.\n\n💡 Provi a convertirlo in PDF e rimandarlo.`)
        return NextResponse.json({ ok: true })
      }
    }

    // Foto — Telegram manda un array di risoluzioni, prendiamo la più grande
    if (message.photo && message.photo.length > 0) {
      await sendTyping(chatId)
      const largestPhoto = message.photo[message.photo.length - 1]
      const fileData = await downloadTelegramFile(largestPhoto.file_id)
      if (fileData) {
        const result = await buildFileBlocks(fileData)
        fileBlocks = result.blocks
        fileDescription = result.description
      }
    }

    // Se non c'è né testo né file, ignora
    if (!userText && fileBlocks.length === 0) {
      return NextResponse.json({ ok: true })
    }

    // Default text se c'è solo un file senza caption
    if (!userText && fileBlocks.length > 0) {
      userText = `Analizza questo file: ${fileDescription}`
    }

    // Verifica autorizzazione
    if (!isAuthorized(chatId)) {
      await sendTelegramMessage(chatId, '⛔ Non sei autorizzato ad usare questo bot.')
      return NextResponse.json({ ok: true })
    }

    // Comando /start
    if (userText === '/start') {
      await sendTelegramMessage(chatId, '🧠 *Cervellone attivo.*\nSono il Suo assistente AI personale. Come posso aiutarLa?')
      return NextResponse.json({ ok: true })
    }

    // Comando /id — per scoprire il proprio chat ID
    if (userText === '/id') {
      await sendTelegramMessage(chatId, `Il Suo chat ID è: ${chatId}`)
      return NextResponse.json({ ok: true })
    }

    // Comando /nuova — reset conversazione
    if (userText === '/nuova') {
      const convId = chatIdToUuid(chatId)
      await supabase.from('messages').delete().eq('conversation_id', convId)
      await sendTelegramMessage(chatId, 'Conversazione azzerata. Come posso aiutarLa?')
      return NextResponse.json({ ok: true })
    }

    // Manda "sta scrivendo..."
    await sendTyping(chatId)

    // Cerca nella memoria
    const memoryContext = await searchMemory(userText)
    const fullSystemPrompt = SYSTEM_PROMPT + memoryContext

    // Conversazione Telegram — trova o crea (UUID deterministico da chat ID)
    const conversationId = chatIdToUuid(chatId)

    // Crea conversazione se non esiste
    const { data: existingConv } = await supabase
      .from('conversations')
      .select('id')
      .eq('id', conversationId)
      .single()

    if (!existingConv) {
      const { error: convError } = await supabase.from('conversations').insert({
        id: conversationId,
        title: '💬 Telegram',
      })
      if (convError) console.error('TELEGRAM: errore creazione conversazione:', convError.message)
    }

    // Carica ultimi 20 messaggi della conversazione per contesto PRIMA di salvare il nuovo
    const { data: recentMessages } = await supabase
      .from('messages')
      .select('role, content')
      .eq('conversation_id', conversationId)
      .order('created_at', { ascending: true })
      .limit(20)

    // Costruisci la storia per Claude
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const history: any[] = (recentMessages || [])
      .filter(m => m.role === 'user' || m.role === 'assistant')
      .map(m => ({ role: m.role, content: m.content }))

    // Aggiungi il messaggio corrente CON i file blocks (se presenti)
    if (fileBlocks.length > 0) {
      history.push({ role: 'user', content: [...fileBlocks, { type: 'text', text: userText }] })
    } else {
      history.push({ role: 'user', content: userText })
    }

    // Salva messaggio utente nella tabella messages (DOPO aver costruito la storia)
    const { error: msgError } = await supabase.from('messages').insert({
      conversation_id: conversationId,
      role: 'user',
      content: userText,
    })
    if (msgError) console.error('TELEGRAM: errore salvataggio messaggio utente:', msgError.message)

    // Salva embedding in background
    saveMessageWithEmbedding(conversationId, 'user', userText).catch(() => {})

    const hasFiles = fileBlocks.length > 0

    // Assicura che inizi con user
    if (history.length > 0 && history[0].role !== 'user') {
      history.shift()
    }

    // Chiama Claude
    const tools = [
      {
        type: 'web_search_20250305' as const,
        name: 'web_search',
        max_uses: 5,
      },
      ...CUSTOM_TOOLS,
    ]

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let currentMessages: any[] = history
    let fullResponse = ''
    let maxIterations = 6  // Ridotto da 10 — ogni iterazione è ~30-60s

    while (maxIterations > 0) {
      maxIterations--

      // Rinnova typing ogni iterazione
      await sendTyping(chatId)

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const callParams: any = {
        model: hasFiles ? 'claude-opus-4-6' : 'claude-sonnet-4-6',
        max_tokens: 12000,  // Ridotto da 16000 per velocizzare
        system: fullSystemPrompt,
        messages: currentMessages,
        tools,
      }
      // Thinking incompatibile con file allegati (stessa logica della chat web)
      if (!hasFiles) {
        callParams.thinking = { type: 'enabled', budget_tokens: 3000 }
      }

      const response = await client.messages.create(callParams)

      // Estrai testo dalla risposta
      let iterationText = ''
      for (const block of response.content) {
        if (block.type === 'text') {
          iterationText += block.text
        }
      }
      fullResponse += iterationText

      // Gestisci tool use
      let hasCustomToolUse = false
      const toolResults: { type: 'tool_result'; tool_use_id: string; content: string }[] = []

      for (const block of response.content) {
        if (block.type === 'tool_use') {
          hasCustomToolUse = true
          // Manda notifica di quale tool sta usando
          const toolNames: Record<string, string> = {
            verifica_prezziario: '🔍 Verifico prezziario...',
            scarica_prezziario: '📥 Scarico prezziario...',
            calcola_preventivo: '🧮 Calcolo preventivo...',
          }
          if (toolNames[block.name]) {
            await sendTelegramMessage(chatId, toolNames[block.name])
          }
          const result = await executeTool(block.name, block.input as Record<string, string>)
          toolResults.push({
            type: 'tool_result',
            tool_use_id: block.id,
            content: result,
          })
        }
      }

      if (!hasCustomToolUse || response.stop_reason === 'end_turn') break

      currentMessages = [
        ...currentMessages,
        { role: 'assistant', content: response.content },
        { role: 'user', content: toolResults },
      ]
    }

    // Salva risposta in memoria e nella tabella messages
    if (fullResponse) {
      saveMessageWithEmbedding(conversationId, 'assistant', fullResponse).catch(() => {})
      await supabase.from('messages').insert({
        conversation_id: conversationId,
        role: 'assistant',
        content: fullResponse,
      })

      // Se c'erano file, salva anche l'analisi come conoscenza persistente
      if (hasFiles && fullResponse.length > 200) {
        const knowledgeContent = `[Analisi file "${fileDescription}" da Telegram]\n\nDomanda: ${userText}\n\nAnalisi:\n${fullResponse.slice(0, 10000)}`
        saveMessageWithEmbedding(conversationId, 'knowledge', knowledgeContent).catch(() => {})
        console.log('TELEGRAM MEMORY: salvata analisi file in memoria persistente')
      }
    }

    // Manda risposta su Telegram
    console.log('TELEGRAM risposta da inviare, lunghezza:', fullResponse.length, 'anteprima:', fullResponse.slice(0, 100))

    const responseBlocks = parseDocumentBlocks(fullResponse)
    let sentSomething = false
    for (const block of responseBlocks) {
      if (block.type === 'document') {
        // Estrai titolo e info chiave dall'HTML per un riepilogo sintetico
        const titleMatch = block.content.match(/<h1[^>]*>(.*?)<\/h1>/i)
          || block.content.match(/class="doc-title[^"]*"[^>]*>(.*?)<\//i)
          || block.content.match(/<title>(.*?)<\/title>/i)
        const title = titleMatch
          ? titleMatch[1].replace(/<[^>]+>/g, '').trim()
          : 'Documento'

        // Cerca un importo totale nel documento
        const totalMatch = block.content.match(/total[^<]*<\/td>\s*<td[^>]*>([^<]+)/i)
          || block.content.match(/totale[^<]*<\/[^>]+>\s*<[^>]+>([^<]*\u20AC[^<]*|[^<]*EUR[^<]*|[^<]*€[^<]*)/i)
          || block.content.match(/([\d.,]+\s*(?:\u20AC|EUR|€))/i)
        const totalInfo = totalMatch ? `\n\uD83D\uDCB0 ${totalMatch[1].replace(/<[^>]+>/g, '').trim()}` : ''

        // Conta le righe di tabella per dare un'idea della dimensione
        const rowCount = (block.content.match(/<tr/gi) || []).length
        const rowInfo = rowCount > 2 ? `\n\uD83D\uDCCA ${rowCount - 1} voci` : ''

        // Salva il documento HTML su Supabase per generare un link diretto
        let docUrl = 'https://cervellone-5poc.vercel.app'
        try {
          const { data: savedDoc, error: docError } = await supabase
            .from('documents')
            .insert({
              name: title,
              content: block.content,
              conversation_id: conversationId,
              type: 'html',
              metadata: { source: 'telegram', chatId, conversationId, savedAt: new Date().toISOString() },
            })
            .select('id')
            .single()
          if (docError) {
            console.error('TELEGRAM: errore Supabase salvataggio documento:', docError.message, docError.details)
          } else if (savedDoc?.id) {
            docUrl = `https://cervellone-5poc.vercel.app/doc/${savedDoc.id}`
            console.log('TELEGRAM: documento salvato con id:', savedDoc.id)
          }
        } catch (e) {
          console.error('TELEGRAM: errore salvataggio documento:', e)
        }

        const cardMsg = `\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\n\uD83D\uDCC4 *${title}*${totalInfo}${rowInfo}\n\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\n\n\uD83D\uDC49 Visualizzi il documento e lo scarichi come PDF:\n${docUrl}`
        await sendTelegramMessage(chatId, cardMsg)
        sentSomething = true
      } else if (block.content) {
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
    // Manda un messaggio di errore all'utente invece di morire in silenzio
    try {
      const errMsg = err instanceof Error ? err.message : String(err)
      let userMessage = '⚠️ Errore temporaneo. Riprova tra un momento.'
      if (errMsg.includes('credit') || errMsg.includes('billing') || errMsg.includes('rate') || errMsg.includes('429')) {
        userMessage = '⚠️ Crediti API esauriti o limite raggiunto. Controllare il piano Anthropic.'
      } else if (errMsg.includes('timeout') || errMsg.includes('TIMEOUT')) {
        userMessage = '⚠️ La richiesta ha impiegato troppo tempo. Provi con una domanda più semplice.'
      }
      if (telegramChatId) await sendTelegramMessage(telegramChatId, userMessage)
    } catch { /* ignore — non peggiorare la situazione */ }
    return NextResponse.json({ ok: true })
  }
}

// GET — per verifica webhook
export async function GET() {
  return NextResponse.json({ status: 'Cervellone Telegram webhook attivo' })
}
