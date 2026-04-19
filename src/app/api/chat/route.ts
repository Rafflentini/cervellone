/**
 * app/api/chat/route.ts — SEC-001, SEC-003, REL-004 fixes
 */

import { NextRequest, NextResponse } from 'next/server'
import { callClaudeStream, trimMessages } from '@/lib/claude'
import { getChatSystemPrompt } from '@/lib/prompts'
import { validateAuth } from '@/lib/auth'
import { rateLimit } from '@/lib/rate-limiter'
import { parseDocumentBlocks } from '@/lib/parseDocumentBlocks'
import { supabase } from '@/lib/supabase'

export const maxDuration = 300

export async function POST(request: NextRequest) {
  // SEC-001: Validate cookie content, not just existence
  const authCookie = request.cookies.get('cervellone_auth')
  if (!validateAuth(authCookie?.value)) {
    return NextResponse.json({ error: 'Non autorizzato' }, { status: 401 })
  }

  // SEC-003: Rate limiting
  const sessionId = authCookie!.value.slice(0, 16)
  if (!rateLimit(`chat_${sessionId}`, 60_000, 10)) {
    return new Response('Troppe richieste. Attenda un momento.', { status: 429 })
  }

  // REL-004: Safe JSON parsing
  let body: any
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Body JSON non valido' }, { status: 400 })
  }

  const { messages: rawMessages, conversationId } = body
  if (!rawMessages || !Array.isArray(rawMessages)) {
    return NextResponse.json({ error: '"messages" deve essere un array' }, { status: 400 })
  }

  const messages = filterEmptyMessages(rawMessages)
  if (messages.length === 0) {
    return new Response('Non ho ricevuto messaggi validi.', {
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    })
  }

  if (messages[0]?.role !== 'user') {
    messages.unshift({ role: 'user', content: '(continua la conversazione)' })
  }

  await resolveFileUrls(messages)
  const trimmedMessages = trimMessages(messages)

  const lastUserMsg = [...trimmedMessages].reverse().find(m => m.role === 'user')
  const userQuery = extractText(lastUserMsg)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const hasFiles = trimmedMessages.some(m =>
    Array.isArray(m.content) && (m.content as any[]).some((b: any) =>
      b.type === 'image' || b.type === 'document'
    )
  )

  const encoder = new TextEncoder()
  const readable = new ReadableStream({
    async start(controller) {
      try {
        const fullResponse = await callClaudeStream(
          { messages: trimmedMessages, systemPrompt: await getChatSystemPrompt(userQuery), userQuery, conversationId, hasFiles },
          {
            onText: (text) => controller.enqueue(encoder.encode(text)),
            onToolStart: () => controller.enqueue(encoder.encode('\n\n🔍 *Cerco informazioni...*\n\n')),
          },
        )

        // Estrai document blocks e salva come documenti linkabili
        const responseBlocks = parseDocumentBlocks(fullResponse)
        const docLinks: string[] = []

        for (const block of responseBlocks) {
          if (block.type === 'document') {
            const titleMatch = block.content.match(/<h1[^>]*>(.*?)<\/h1>/i)
            const title = titleMatch ? titleMatch[1].replace(/<[^>]+>/g, '').trim() : 'Documento'

            const { data: savedDoc } = await supabase.from('documents')
              .insert({
                name: title,
                content: block.content,
                conversation_id: conversationId,
                type: 'html',
                metadata: { source: 'web_chat' }
              })
              .select('id')
              .single()

            if (savedDoc?.id) {
              docLinks.push(`\n\n📄 **${title}**\n👉 [Apri documento](https://cervellone-5poc.vercel.app/doc/${savedDoc.id})`)
            }
          }
        }

        if (docLinks.length > 0) {
          controller.enqueue(encoder.encode(docLinks.join('\n')))
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        console.error('CHAT error:', msg)
        controller.enqueue(encoder.encode(`\n\n⚠️ ${msg.slice(0, 300)}`))
      } finally {
        controller.close()
      }
    },
  })

  return new Response(readable, {
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-cache' },
  })
}

// ── Helpers ──

function filterEmptyMessages(raw: any[]): any[] {
  return (raw || []).filter(m => {
    if (!m?.role || !m?.content) return false
    if (typeof m.content === 'string') return m.content.trim().length > 0
    if (Array.isArray(m.content)) {
      m.content = m.content.filter((b: any) => {
        if (!b?.type) return false
        if (b.type === 'text') return b.text?.trim().length > 0
        return true
      })
      return m.content.length > 0
    }
    return false
  })
}

async function resolveFileUrls(messages: any[]) {
  const lastUserMsg = [...messages].reverse().find(m => m.role === 'user')
  if (!Array.isArray(lastUserMsg?.content)) return

  for (let i = 0; i < lastUserMsg.content.length; i++) {
    const block = lastUserMsg.content[i]
    if (block.type !== 'text' || !block.text?.startsWith('[FILE_URL:')) continue
    const match = block.text.match(/\[FILE_URL:(.*?):(.*?):(.*?)\]/)
    if (!match) continue
    const [, url, , mediaType] = match
    try {
      const res = await fetch(url)
      if (!res.ok) continue
      const buffer = Buffer.from(await res.arrayBuffer())
      // PER-002: Check file size
      if (buffer.length > 25 * 1024 * 1024) continue
      const base64 = buffer.toString('base64')
      if (mediaType === 'application/pdf') {
        lastUserMsg.content[i] = { type: 'document', source: { type: 'base64', media_type: mediaType, data: base64 } }
      } else if (mediaType.startsWith('image/')) {
        lastUserMsg.content[i] = { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } }
      }
    } catch { /* skip */ }
  }
}

function extractText(msg: any): string {
  if (!msg) return ''
  if (typeof msg.content === 'string') return msg.content
  if (Array.isArray(msg.content)) return msg.content.find((b: any) => b.type === 'text')?.text || ''
  return ''
}
