import { NextRequest, NextResponse } from 'next/server'
import Anthropic from '@anthropic-ai/sdk'
import { searchMemory, saveMessageWithEmbedding } from '@/lib/memory'
import { CUSTOM_TOOLS, executeTool } from '@/lib/tools'

const client = new Anthropic()

const TELEGRAM_API = 'https://api.telegram.org/bot'

const SYSTEM_PROMPT = `Sei il Cervellone — l'assistente AI personale dell'Ing. Raffaele, titolare di Restruktura SRL.

Chi è Restruktura:
- Società di ingegneria: progettazione strutturale, direzione lavori, collaudi
- Impresa edile: ristrutturazioni, manutenzioni, cantieri
- PonteggioSicuro.it: noleggio ponteggi con servizio completo
- Sede operativa in Basilicata

Hai accesso a:
- Ricerca web in tempo reale
- Generazione documenti Word e Excel
- Un database di conoscenza che contiene documenti, analisi e conversazioni passate dell'Ingegnere. I dati rilevanti vengono caricati automaticamente qui sotto nella sezione "La tua memoria". Se contiene informazioni, USALE per rispondere.

Stai comunicando via Telegram. Rispondi in modo conciso e diretto, adatto a messaggi chat.
Usa la formattazione Telegram (Markdown): *grassetto*, _corsivo_, `codice`.

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
    await fetch(`${TELEGRAM_API}${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: chunk,
        parse_mode: 'Markdown',
      }),
    })
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

// Webhook Telegram — riceve messaggi
export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const message = body.message

    if (!message || !message.text) {
      return NextResponse.json({ ok: true })
    }

    const chatId = message.chat.id
    const userText = message.text

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
      await sendTelegramMessage(chatId, `Il Suo chat ID è: \`${chatId}\``)
      return NextResponse.json({ ok: true })
    }

    // Manda "sta scrivendo..."
    await sendTyping(chatId)

    // Cerca nella memoria
    const memoryContext = await searchMemory(userText)
    const fullSystemPrompt = SYSTEM_PROMPT + memoryContext

    // Conversazione Telegram — usa un ID fisso per chat Telegram
    const conversationId = `telegram_${chatId}`

    // Salva messaggio utente
    saveMessageWithEmbedding(conversationId, 'user', userText).catch(() => {})

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
    let currentMessages: any[] = [{ role: 'user', content: userText }]
    let fullResponse = ''
    let maxIterations = 10

    while (maxIterations > 0) {
      maxIterations--

      // Rinnova typing ogni iterazione
      await sendTyping(chatId)

      const response = await client.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 4000,
        system: fullSystemPrompt,
        messages: currentMessages,
        tools,
        thinking: {
          type: 'enabled',
          budget_tokens: 5000,
        },
      })

      // Estrai testo dalla risposta
      for (const block of response.content) {
        if (block.type === 'text') {
          fullResponse += block.text
        }
      }

      // Gestisci tool use
      let hasCustomToolUse = false
      const toolResults: { type: 'tool_result'; tool_use_id: string; content: string }[] = []

      for (const block of response.content) {
        if (block.type === 'tool_use') {
          hasCustomToolUse = true
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

    // Salva risposta in memoria
    if (fullResponse) {
      saveMessageWithEmbedding(conversationId, 'assistant', fullResponse).catch(() => {})
    }

    // Manda risposta su Telegram
    await sendTelegramMessage(chatId, fullResponse || 'Non sono riuscito a elaborare una risposta.')

    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error('TELEGRAM errore:', err)
    return NextResponse.json({ ok: true })
  }
}

// GET — per verifica webhook
export async function GET() {
  return NextResponse.json({ status: 'Cervellone Telegram webhook attivo' })
}
