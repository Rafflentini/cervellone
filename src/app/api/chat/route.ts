import Anthropic from '@anthropic-ai/sdk'
import { NextRequest, NextResponse } from 'next/server'
import { searchMemory, saveMessageWithEmbedding } from '@/lib/memory'

// Pro plan: timeout 300s, body fino a 100MB
export const maxDuration = 300

const client = new Anthropic()

// System prompt CORTO — lascia Claude essere Claude
const SYSTEM_PROMPT = `Sei il Cervellone — il coordinatore digitale di Restruktura SRL e dell'Ing. Raffaele Lentini, Villa d'Agri (PZ).
Restruktura: ingegneria strutturale, direzione lavori, collaudi, impresa edile, PonteggioSicuro.it (noleggio ponteggi). Sede operativa in Basilicata.
Il tuo ruolo è coordinare TUTTO: studio tecnico, cantieri, segreteria, marketing, clienti. Non sei solo un generatore di documenti — sei il braccio destro dell'Ingegnere.

HAI MEMORIA PERSISTENTE. I dati dei progetti, documenti e conversazioni passate vengono caricati automaticamente in fondo a questo messaggio nella sezione "La tua memoria". Se contiene informazioni, USALE. NON dire MAI che non hai memoria o che ogni sessione riparte da zero — è FALSO. Hai un database con tutta la conoscenza dell'Ingegnere.

Quando la tua risposta contiene dati strutturati (tabelle, preventivi, computi, relazioni, analisi), usa il blocco ~~~document con HTML professionale completo e autocontenuto.
Intestazione: RESTRUKTURA S.r.l. — Ingegneria, Costruzioni, Ponteggi — P.IVA 02087420762, Villa d'Agri (PZ), Ing. Raffaele Lentini.
Design di altissima qualità: layout A4, gradient, ombre, tabelle professionali, importi all'italiana, pronto per la stampa. Come un artifact di Claude AI.
NON usare MAI tabelle markdown — usa SEMPRE ~~~document con HTML.
Quando fai un preventivo, genera SEMPRE anche un computo metrico con prezziario regionale ufficiale di confronto (2 blocchi ~~~document).

Dai del Lei all'Ingegnere. Rispondi in italiano. Non menzionare mai il funzionamento interno.
NON dire mai "non posso generare file" — puoi generare documenti HTML nel blocco ~~~document, l'utente li scarica come PDF.`

export async function POST(request: NextRequest) {
  const authCookie = request.cookies.get('cervellone_auth')
  if (!authCookie) {
    return NextResponse.json({ error: 'Non autorizzato' }, { status: 401 })
  }

  const body = await request.json()
  const { messages: rawMessages, conversationId } = body

  // Filtra messaggi vuoti
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const messages = (rawMessages as any[]).filter((m: any) => {
    if (!m || !m.role || !m.content) return false
    if (typeof m.content === 'string') return m.content.trim().length > 0
    if (Array.isArray(m.content)) {
      const validBlocks = m.content.filter((b: any) => {
        if (!b || !b.type) return false
        if (b.type === 'text') return b.text && b.text.trim().length > 0
        return true
      })
      if (validBlocks.length === 0) return false
      m.content = validBlocks
      return true
    }
    return false
  })

  if (messages.length === 0) {
    return new Response('Non ho ricevuto messaggi validi. Riprova.', {
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    })
  }

  // Assicura primo messaggio = user
  if (messages[0]?.role !== 'user') {
    messages.unshift({ role: 'user', content: '(continua la conversazione)' })
  }

  // Safeguard context window
  const MAX_CONTEXT_CHARS = 500000
  if (messages.length > 1) {
    let totalChars = 0
    const lastMsg = messages[messages.length - 1]
    totalChars = typeof lastMsg.content === 'string' ? lastMsg.content.length
      : Array.isArray(lastMsg.content) ? JSON.stringify(lastMsg.content).length : 0

    let startIdx = messages.length - 1
    for (let i = messages.length - 2; i >= 0; i--) {
      const content = messages[i].content
      const chars = typeof content === 'string' ? content.length
        : Array.isArray(content) ? JSON.stringify(content).length : 0
      if (totalChars + chars > MAX_CONTEXT_CHARS) break
      totalChars += chars
      startIdx = i
    }
    if (startIdx > 0) {
      messages.splice(0, startIdx)
      if (messages[0]?.role !== 'user') {
        messages.unshift({ role: 'user', content: '(conversazione precedente omessa per lunghezza)' })
      }
    }
  }

  // Ultimo messaggio utente
  const lastUserMsg = [...messages].reverse().find((m: { role: string }) => m.role === 'user')
  const userQuery = typeof lastUserMsg?.content === 'string'
    ? lastUserMsg.content
    : lastUserMsg?.content?.find((b: { type: string }) => b.type === 'text')?.text || ''

  // File allegati?
  const hasFiles = Array.isArray(lastUserMsg?.content) &&
    lastUserMsg.content.some((b: { type: string }) => b.type === 'image' || b.type === 'document')

  // Cerca nella memoria
  const memoryContext = await searchMemory(userQuery)

  // Salva embedding utente in background
  if (conversationId && userQuery) {
    saveMessageWithEmbedding(conversationId, 'user', userQuery).catch(() => {})
  }

  const fullSystemPrompt = SYSTEM_PROMPT + memoryContext

  // Tools: solo web search built-in — Claude fa tutto il resto da solo
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tools: any[] = [
    { type: 'web_search_20250305', name: 'web_search', max_uses: 5 },
  ]

  const encoder = new TextEncoder()
  let fullResponse = ''

  const readable = new ReadableStream({
    async start(controller) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        let currentMessages = [...messages] as any[]
        let maxIterations = 5

        while (maxIterations > 0) {
          maxIterations--

          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const streamParams: any = {
            model: 'claude-opus-4-6',
            max_tokens: 16000,
            system: fullSystemPrompt,
            messages: currentMessages,
            tools,
          }
          // Thinking solo se non ci sono file (incompatibilità API con document blocks)
          if (!hasFiles) {
            streamParams.thinking = { type: 'enabled', budget_tokens: 10000 }
          }

          const stream = client.messages.stream(streamParams)

          for await (const event of stream) {
            if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
              fullResponse += event.delta.text
              controller.enqueue(encoder.encode(event.delta.text))
            }
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            if (event.type === 'content_block_start' && (event as any).content_block?.type === 'server_tool_use') {
              const label = '\n\n🔍 *Cerco informazioni...*\n\n'
              fullResponse += label
              controller.enqueue(encoder.encode(label))
            }
          }

          const finalMessage = await stream.finalMessage()

          // Se non c'è tool use custom → fine
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const hasToolUse = finalMessage.content.some((b: any) => b.type === 'tool_use')
          if (!hasToolUse || finalMessage.stop_reason === 'end_turn') break

          // Tool use loop (web_search è server-side, gestito da Anthropic)
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const toolResults: any[] = []
          for (const block of finalMessage.content) {
            if (block.type === 'tool_use') {
              toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: 'OK' })
            }
          }

          currentMessages = [
            ...currentMessages,
            { role: 'assistant', content: finalMessage.content },
            { role: 'user', content: toolResults },
          ]
        }
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err)
        console.error('CHAT errore:', err)
        let userMsg = errMsg
        if (errMsg.includes('Could not process image') || errMsg.includes('invalid_image')) {
          userMsg = 'Immagine non leggibile. Provi con PNG o JPG.'
        } else if (errMsg.includes('too large')) {
          userMsg = 'Documento troppo pesante. Comprima il PDF o lo divida in parti.'
        } else if (errMsg.includes('rate_limit') || errMsg.includes('overloaded')) {
          userMsg = 'Claude è sovraccarico. Riprovi tra 10 secondi.'
        } else if (errMsg.includes('too many images')) {
          userMsg = 'Troppi file. Carichi 1-2 file alla volta.'
        }
        controller.enqueue(encoder.encode(`\n\n⚠️ ${userMsg}`))
      } finally {
        controller.close()
        if (conversationId && fullResponse) {
          saveMessageWithEmbedding(conversationId, 'assistant', fullResponse).catch(() => {})
          if (hasFiles && fullResponse.length > 200) {
            const knowledge = `[Analisi file dalla chat]\n\nDomanda: ${userQuery}\n\nAnalisi:\n${fullResponse.slice(0, 10000)}`
            saveMessageWithEmbedding(conversationId, 'knowledge', knowledge).catch(() => {})
          }
        }
      }
    },
  })

  return new Response(readable, {
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-cache' },
  })
}
