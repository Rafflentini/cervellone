import Anthropic from '@anthropic-ai/sdk'
import { NextRequest, NextResponse } from 'next/server'
import { searchMemory, saveMessageWithEmbedding } from '@/lib/memory'
import { supabase } from '@/lib/supabase'
import { CHAT_SYSTEM_PROMPT } from '@/lib/prompts'
import { CUSTOM_TOOLS, executeTool } from '@/lib/tools'

export const maxDuration = 300

const client = new Anthropic()

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

  // Scarica file da Storage URL → document/image blocks per Claude
  const lastUserMsg = [...messages].reverse().find((m: { role: string }) => m.role === 'user')
  if (Array.isArray(lastUserMsg?.content)) {
    for (let i = 0; i < lastUserMsg.content.length; i++) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const block = lastUserMsg.content[i] as any
      if (block.type === 'text' && block.text?.startsWith('[FILE_URL:')) {
        const match = block.text.match(/\[FILE_URL:(.*?):(.*?):(.*?)\]/)
        if (match) {
          const [, url, fileName, mediaType] = match
          try {
            const fileRes = await fetch(url)
            if (fileRes.ok) {
              const buffer = Buffer.from(await fileRes.arrayBuffer())
              const base64 = buffer.toString('base64')
              console.log(`CHAT FILE: ${fileName} — ${buffer.length} bytes`)
              if (mediaType === 'application/pdf') {
                lastUserMsg.content[i] = { type: 'document', source: { type: 'base64', media_type: mediaType, data: base64 } }
              } else if (mediaType.startsWith('image/')) {
                lastUserMsg.content[i] = { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } }
              }
            }
          } catch (err) {
            console.error('Download file da Storage fallito:', err)
          }
        }
      }
    }
  }

  const userQuery = typeof lastUserMsg?.content === 'string'
    ? lastUserMsg.content
    : lastUserMsg?.content?.find((b: { type: string }) => b.type === 'text')?.text || ''

  const hasFiles = Array.isArray(lastUserMsg?.content) &&
    lastUserMsg.content.some((b: { type: string }) => b.type === 'image' || b.type === 'document')

  // Memoria RAG
  const memoryContext = await searchMemory(userQuery)

  // FIX: salva embedding con fallback
  if (conversationId && userQuery) {
    try {
      await saveMessageWithEmbedding(conversationId, 'user', userQuery)
    } catch {
      await supabase.from('messages').insert({ conversation_id: conversationId, role: 'user', content: userQuery })
    }
  }

  const fullSystemPrompt = CHAT_SYSTEM_PROMPT + memoryContext

  // Routing: Sonnet default, Opus per task complessi (come fa claude.ai)
  const needsOpus = /relazione|calcolo|struttur|normativ|perizia|analisi.*complessa|confronto|verifica|progett|valutazione|consulenza|parere/i.test(userQuery)
  const model = needsOpus ? 'claude-opus-4-6' : 'claude-sonnet-4-6'

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tools: any[] = [{ type: 'web_search_20250305', name: 'web_search', max_uses: 5 }, ...CUSTOM_TOOLS]

  const encoder = new TextEncoder()
  let fullResponse = ''

  const readable = new ReadableStream({
    async start(controller) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        let currentMessages = [...messages] as any[]
        let maxIterations = 5
        let consecutiveToolOnly = 0 // FIX: freno loop tool-only

        while (maxIterations > 0) {
          maxIterations--

          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const streamParams: any = {
            model,
            max_tokens: 16000,
            system: fullSystemPrompt,
            messages: currentMessages,
            tools,
          }
          // Thinking SEMPRE abilitato — come claude.ai. Budget alto per Opus.
          streamParams.thinking = { type: 'enabled', budget_tokens: needsOpus ? 16000 : 10000 }

          const stream = client.messages.stream(streamParams)

          let iterationHasText = false
          for await (const event of stream) {
            if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
              fullResponse += event.delta.text
              controller.enqueue(encoder.encode(event.delta.text))
              iterationHasText = true
            }
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            if (event.type === 'content_block_start' && (event as any).content_block?.type === 'server_tool_use') {
              const label = '\n\n🔍 *Cerco informazioni...*\n\n'
              fullResponse += label
              controller.enqueue(encoder.encode(label))
            }
          }

          const finalMessage = await stream.finalMessage()

          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const hasToolUse = finalMessage.content.some((b: any) => b.type === 'tool_use')
          if (!hasToolUse || finalMessage.stop_reason === 'end_turn') break

          // FIX: freno loop tool-only
          if (hasToolUse && !iterationHasText) {
            consecutiveToolOnly++
            if (consecutiveToolOnly >= 2) break
          } else {
            consecutiveToolOnly = 0
          }

          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const toolResults: any[] = []
          for (const block of finalMessage.content) {
            if (block.type === 'tool_use') {
              let toolContent = 'OK'
              if (block.name !== 'web_search') {
                try {
                  toolContent = await executeTool(block.name, block.input as Record<string, unknown>)
                } catch (err) {
                  toolContent = `Errore tool ${block.name}: ${err}`
                }
              }
              toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: toolContent })
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
        controller.enqueue(encoder.encode(`\n\n⚠️ ${errMsg.slice(0, 300)}`))
      } finally {
        controller.close()
        // FIX: salva risposta con fallback
        if (conversationId && fullResponse) {
          try {
            await saveMessageWithEmbedding(conversationId, 'assistant', fullResponse)
          } catch {
            await supabase.from('messages').insert({ conversation_id: conversationId, role: 'assistant', content: fullResponse })
          }
          if (hasFiles && fullResponse.length > 200) {
            const knowledge = `[Analisi file dalla chat]\n\nDomanda: ${userQuery}\n\nAnalisi:\n${fullResponse.slice(0, 10000)}`
            saveMessageWithEmbedding(conversationId, 'knowledge', knowledge).catch(() => {})
          }

          // SALVA CONTENUTO COMPLETO di ogni file in memoria permanente
          if (Array.isArray(lastUserMsg?.content)) {
            for (const block of lastUserMsg.content) {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              const b = block as any
              if (b.type === 'text' && b.text && b.text.length > 100 && b.text.startsWith('[File')) {
                const text = b.text as string
                const chunkSize = 30000
                for (let ci = 0; ci < text.length; ci += chunkSize) {
                  const chunk = text.slice(ci, ci + chunkSize)
                  saveMessageWithEmbedding(conversationId, 'knowledge', chunk).catch(() => {})
                }
              }
            }
          }
        }
      }
    },
  })

  return new Response(readable, {
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-cache' },
  })
}
