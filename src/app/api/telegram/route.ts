/**
 * app/api/telegram/route.ts — All fixes integrated
 * SEC-002: webhook secret, SEC-003: rate limit, FUN-002: video,
 * FUN-003: sticker/location, /nuova: clears embeddings, UX-002: thinking msg
 */

import { NextRequest, NextResponse } from 'next/server'
import { waitUntil } from '@vercel/functions'
import crypto from 'crypto'
import { callClaudeStreamTelegram } from '@/lib/claude'
import { supabase } from '@/lib/supabase'
import { parseDocumentBlocks } from '@/lib/parseDocumentBlocks'
import { getTelegramSystemPrompt } from '@/lib/prompts'
import { saveMessageWithEmbedding } from '@/lib/memory'
import { downloadTelegramFile, buildContentBlocks, transcribeAudio, sendTelegramMessage, sendTyping, editTelegramMessage, sendTelegramMessageWithId } from '@/lib/telegram-helpers'
import { validateWebhookSecret } from '@/lib/auth'
import { rateLimit } from '@/lib/rate-limiter'
import { safeSupabase } from '@/lib/resilience'
// Trigger.dev imports temporaneamente non usati (Task #10 backlog)
// import { tasks } from '@trigger.dev/sdk/v3'
// import type { cervelloneLongTask } from '../../../../trigger/cervellone-long-task'
import { classifyTask } from '@/lib/task-classifier'

export const maxDuration = 300

function chatIdToUuid(chatId: number): string {
  const hash = crypto.createHash('md5').update(`telegram_${chatId}`).digest('hex')
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}`
}

function isAuthorized(chatId: number): boolean {
  return (process.env.TELEGRAM_ALLOWED_IDS || '').split(',').map(Number).includes(chatId)
}

export async function POST(request: NextRequest) {
  // SEC-002: Validate webhook secret
  if (!validateWebhookSecret(request.headers.get('x-telegram-bot-api-secret-token'))) {
    return new Response('Unauthorized', { status: 401 })
  }

  let errorChatId: number | null = null
  let typingInterval: NodeJS.Timeout | null = null

  try {
    const body = await request.json()
    const message = body.message
    if (!message) return NextResponse.json({ ok: true })

    const chatId: number = message.chat.id
    errorChatId = chatId

    // SEC-003: Rate limiting
    if (!rateLimit(`tg_${chatId}`, 60_000, 5)) {
      await sendTelegramMessage(chatId, '⚠️ Troppi messaggi. Attenda un momento.')
      return NextResponse.json({ ok: true })
    }

    // REL-001: Dedup con fallback se Supabase è down
    const msgId = message.message_id
    if (msgId) {
      const existing = await safeSupabase(
        () => supabase.from('telegram_dedup').select('message_id')
          .eq('chat_id', chatId).eq('message_id', msgId).limit(1),
        []
      )
      if (existing && (existing as any[]).length > 0) return NextResponse.json({ ok: true })
      await safeSupabase(() => supabase.from('telegram_dedup').insert({ chat_id: chatId, message_id: msgId }))
    }

    let userText = message.text || message.caption || ''
    let fileBlocks: any[] = []
    let fileDescription = ''

    // ── Voice ──
    if (!userText && (message.voice || message.audio)) {
      const fileId = message.voice?.file_id || message.audio?.file_id
      if (fileId) {
        await sendTyping(chatId)
        userText = await transcribeAudio(fileId)
        if (!userText) {
          await sendTelegramMessage(chatId, 'Non sono riuscito a trascrivere il vocale.')
          return NextResponse.json({ ok: true })
        }
      }
    }

    // ── Document ──
    if (message.document) {
      await sendTyping(chatId)
      if ((message.document.file_size || 0) > 20 * 1024 * 1024) {
        await sendTelegramMessage(chatId, '⚠️ File troppo pesante (max 20 MB).')
        return NextResponse.json({ ok: true })
      }
      const ext = (message.document.file_name || '').split('.').pop()?.toLowerCase()
      if (!ext) {
        await sendTelegramMessage(chatId, '⚠️ File senza estensione.')
        return NextResponse.json({ ok: true })
      }
      const fileData = await downloadTelegramFile(message.document.file_id)
      if (!fileData) {
        await sendTelegramMessage(chatId, '⚠️ Non riesco a scaricare il file.')
        return NextResponse.json({ ok: true })
      }
      fileBlocks = await buildContentBlocks(fileData)
      fileDescription = message.document.file_name || fileData.fileName
    }

    // ── Photo ──
    if (message.photo?.length > 0) {
      await sendTyping(chatId)
      const largest = message.photo[message.photo.length - 1]
      const fileData = await downloadTelegramFile(largest.file_id)
      if (fileData) {
        fileBlocks = await buildContentBlocks(fileData)
        fileDescription = fileData.fileName
      }
    }

    // ── FUN-002: Video (extract thumbnail) ──
    if (message.video && fileBlocks.length === 0) {
      await sendTyping(chatId)
      const thumb = message.video.thumb || message.video.thumbnail
      if (thumb) {
        const fileData = await downloadTelegramFile(thumb.file_id)
        if (fileData) {
          fileBlocks = await buildContentBlocks({ ...fileData, mimeType: 'image/jpeg', fileName: 'video_frame.jpg' })
          fileDescription = 'frame dal video'
        }
      }
      if (!userText && fileBlocks.length === 0) {
        userText = 'Ho ricevuto un video ma non riesco a estrarre il frame. Può rimandarlo come foto?'
      }
    }

    // ── FUN-003: Sticker, Location, Contact ──
    if (!userText && fileBlocks.length === 0) {
      if (message.sticker || message.animation) {
        userText = "(L'utente ha inviato uno sticker/GIF)"
      } else if (message.location) {
        userText = `L'utente ha condiviso una posizione GPS: lat ${message.location.latitude}, lon ${message.location.longitude}`
      } else if (message.contact) {
        userText = `L'utente ha condiviso un contatto: ${message.contact.first_name} ${message.contact.phone_number || ''}`
      } else {
        return NextResponse.json({ ok: true })
      }
    }

    if (!userText && fileBlocks.length > 0) userText = `Analizza questo file: ${fileDescription}`

    if (!isAuthorized(chatId)) {
      await sendTelegramMessage(chatId, '⛔ Non autorizzato.')
      return NextResponse.json({ ok: true })
    }

    // ── Comandi ──
    if (userText === '/start') {
      await sendTelegramMessage(chatId, '🧠 *Cervellone attivo.* Come posso aiutarLa?')
      return NextResponse.json({ ok: true })
    }
    if (userText === '/id') {
      await sendTelegramMessage(chatId, `Chat ID: ${chatId}`)
      return NextResponse.json({ ok: true })
    }
    if (userText === '/nuova') {
      const convId = chatIdToUuid(chatId)
      // Cancella solo i messaggi della chat, NON la memoria (embeddings)
      // La memoria deve persistere SEMPRE — contiene documenti, analisi, regole
      await safeSupabase(() => supabase.from('messages').delete().eq('conversation_id', convId))
      await sendTelegramMessage(chatId, 'Conversazione azzerata. La memoria permanente è intatta.')
      return NextResponse.json({ ok: true })
    }
    if (userText === '/help') {
      await sendTelegramMessage(chatId, '🧠 *Comandi Cervellone*\n\n/nuova — Azzera conversazione\n/opus — Modello piu potente\n/sonnet — Modello standard\n/modello — Mostra modello attivo\n/aggiorna — Controlla aggiornamenti\n/skill — Lista skill disponibili\n/help — Questa lista')
      return NextResponse.json({ ok: true })
    }
    if (userText === '/opus') {
      await supabase.from('cervellone_config').update({ value: 'claude-opus-4-7', updated_by: 'telegram /opus' }).eq('key', 'model_default')
      const { invalidateConfigCache } = await import('@/lib/claude')
      invalidateConfigCache()
      await sendTelegramMessage(chatId, '🧠 Modello: *Opus* (massima potenza)')
      return NextResponse.json({ ok: true })
    }
    if (userText === '/sonnet') {
      await supabase.from('cervellone_config').update({ value: 'claude-sonnet-4-6', updated_by: 'telegram /sonnet' }).eq('key', 'model_default')
      const { invalidateConfigCache } = await import('@/lib/claude')
      invalidateConfigCache()
      await sendTelegramMessage(chatId, '⚡ Modello: *Sonnet* (veloce)')
      return NextResponse.json({ ok: true })
    }
    if (userText === '/modello') {
      const { data } = await supabase.from('cervellone_config').select('value').eq('key', 'model_default').single()
      const model = data?.value ? String(data.value).replace(/"/g, '') : 'sconosciuto'
      await sendTelegramMessage(chatId, `🧠 Modello attivo: *${model}*`)
      return NextResponse.json({ ok: true })
    }
    if (userText === '/aggiorna') {
      const { executeTool } = await import('@/lib/tools')
      const result = await executeTool('cervellone_check_aggiornamenti', { applica: true })
      await sendTelegramMessage(chatId, result)
      return NextResponse.json({ ok: true })
    }
    if (userText === '/skill') {
      const { data } = await supabase.from('cervellone_skills').select('id, nome, descrizione').order('id')
      if (data?.length) {
        const list = data.map((s: any) => `*${s.nome}*\n${s.descrizione}`).join('\n\n')
        await sendTelegramMessage(chatId, `🧠 *Skill disponibili*\n\n${list}`)
      } else {
        await sendTelegramMessage(chatId, 'Nessuna skill configurata.')
      }
      return NextResponse.json({ ok: true })
    }

    // ── Bug 1: mutex per chat ──
    // Evita bgProcess paralleli sulla stessa chat: se l'utente manda un messaggio
    // mentre il bot sta elaborando il precedente, droppiamo il nuovo per non
    // creare hallucination ("Trovato!" senza tool eseguito) e streaming sovrapposti.
    // Stale lock cleanup a 5 min = Vercel function max duration.
    // Se Supabase down → fallback degradato (lockClaimed=true), lascia passare.
    const STALE_LOCK_MS = 5 * 60 * 1000
    const requestId = `${chatId}-${msgId || Date.now()}-${Date.now()}`
    let lockClaimed = true
    try {
      const { error: insertErr } = await supabase
        .from('telegram_active_jobs')
        .insert({ chat_id: chatId, request_id: requestId })
      if (insertErr) {
        // Conflict (PK chat_id): chat già attiva. Verifica se lock stale.
        const { data: existing } = await supabase
          .from('telegram_active_jobs')
          .select('started_at')
          .eq('chat_id', chatId)
          .maybeSingle()
        if (existing?.started_at) {
          const ageMs = Date.now() - new Date(existing.started_at).getTime()
          if (ageMs > STALE_LOCK_MS) {
            await supabase.from('telegram_active_jobs').delete().eq('chat_id', chatId)
            const { error: retryErr } = await supabase
              .from('telegram_active_jobs')
              .insert({ chat_id: chatId, request_id: requestId })
            if (retryErr) {
              lockClaimed = false  // race con altra istanza, lasciamo vincere lei
            } else {
              console.log(`MUTEX chat=${chatId} stale lock released (age=${Math.round(ageMs/1000)}s) and re-acquired`)
            }
          } else {
            lockClaimed = false  // lock attivo recente
          }
        } else {
          lockClaimed = false  // unknown error, conservativo
        }
      }
    } catch (err) {
      console.warn('[MUTEX] Supabase down, fallback claim true:', err instanceof Error ? err.message : err)
      // lockClaimed resta true → degraded mode, no serializzazione
    }

    if (!lockClaimed) {
      console.log(`MUTEX chat=${chatId} BUSY — drop msgId=${msgId}`)
      await sendTelegramMessage(chatId, '⏳ Sto ancora elaborando il messaggio precedente, attenda un momento.')
      return NextResponse.json({ ok: true })
    }

    // ── Typing + thinking timeout ──
    typingInterval = setInterval(() => sendTyping(chatId), 4000)
    await sendTyping(chatId)

    // ── Conversazione ──
    const conversationId = chatIdToUuid(chatId)
    const existingConv = await safeSupabase(
      () => supabase.from('conversations').select('id').eq('id', conversationId).single()
    )
    if (!existingConv) {
      await safeSupabase(() => supabase.from('conversations').insert({ id: conversationId, title: '💬 Telegram' }))
    }

    // ── Storia ──
    // FIX W1.2: history ridotta da 10 a 6 messaggi per ridurre contaminazione cross-turn
    // (es. POS chiesto 3 turni fa che si trascina in nuovi saluti).
    // Per knowledge persistente la RAG via embedding fa il resto.
    const recentMessages = await safeSupabase(
      () => supabase.from('messages').select('role, content')
        .eq('conversation_id', conversationId)
        .order('created_at', { ascending: false }).limit(6),
      []
    )
    // L'order DESC + reverse: prendi gli ultimi 6, poi rimetti in ordine cronologico
    if (Array.isArray(recentMessages)) {
      (recentMessages as unknown[]).reverse()
    }

    const history: any[] = ((recentMessages as any[]) || [])
      .filter(m => m.role === 'user' || m.role === 'assistant')
      .map(m => ({ role: m.role, content: m.content }))

    if (fileBlocks.length > 0) {
      history.push({ role: 'user', content: [...fileBlocks, { type: 'text', text: userText }] })
    } else {
      history.push({ role: 'user', content: userText })
    }
    if (history.length > 0 && history[0].role !== 'user') history.shift()

    // V10: Comprimi documenti HTML nei messaggi precedenti
    for (const msg of history) {
      if (msg.role === 'assistant' && typeof msg.content === 'string') {
        msg.content = msg.content.replace(
          /~~~document\n[\s\S]*?~~~(?:\n|$)/g,
          '[Documento gia generato]\n'
        )
      }
    }

    // ── Claude (ASINCRONO) — risponde subito, elabora in background ──
    const bgProcess = async () => {
      try {
        const placeholderMsgId = await sendTelegramMessageWithId(chatId, '🧠 Sto elaborando...')
        const currentMsgId = placeholderMsgId
        let lastEditText = ''

        const fullResponse = await callClaudeStreamTelegram(
          {
            messages: history,
            systemPrompt: await getTelegramSystemPrompt(userText),
            userQuery: userText,
            conversationId,
            hasFiles: fileBlocks.length > 0,
          },
          async (accumulated) => {
            if (!currentMsgId) return
            const preview = accumulated.slice(0, 4000)
            if (preview === lastEditText) return
            lastEditText = preview
            await editTelegramMessage(chatId, currentMsgId, preview)
          }
        )

        if (typingInterval) { clearInterval(typingInterval); typingInterval = null }

        // Gestisci documenti e risposta finale
        const responseBlocks = parseDocumentBlocks(fullResponse)
        const textParts: string[] = []

        for (const block of responseBlocks) {
          if (block.type === 'document') {
            const titleMatch = block.content.match(/<h1[^>]*>(.*?)<\/h1>/i)
            const title = titleMatch ? titleMatch[1].replace(/<[^>]+>/g, '').trim() : 'Documento'

            const savedDoc = await safeSupabase(
              () => supabase.from('documents')
                .insert({ name: title, content: block.content, conversation_id: conversationId, type: 'html', metadata: { source: 'telegram' } })
                .select('id').single()
            )
            const docUrl = (savedDoc as any)?.id
              ? `https://cervellone-5poc.vercel.app/doc/${(savedDoc as any).id}`
              : 'https://cervellone-5poc.vercel.app'

            // FIX W1.3 (utente 2/5): NO auto-save su Drive di default.
            // Il documento resta nella memoria permanente Cervellone (Supabase + URL /doc/[id]).
            // Per salvare su Drive, l'utente deve chiederlo esplicitamente — Cervellone
            // chiama il tool salva_su_drive che fa la mappatura Y+X.
            textParts.push(`📄 *${title}*\n👉 ${docUrl}`)
          } else if (block.content.trim()) {
            textParts.push(block.content)
          }
        }

        const finalText = textParts.join('\n\n') || fullResponse
        if (placeholderMsgId) {
          if (finalText.length <= 4000) {
            await editTelegramMessage(chatId, placeholderMsgId, finalText)
          } else {
            await editTelegramMessage(chatId, placeholderMsgId, finalText.slice(0, 4000))
            const remaining = finalText.slice(4000)
            if (remaining.trim()) await sendTelegramMessage(chatId, remaining)
          }
        } else {
          await sendTelegramMessage(chatId, finalText)
        }

        // Salva conoscenza file
        if (fileBlocks.length > 0 && fullResponse.length > 200) {
          const knowledge = `[Analisi file "${fileDescription}"]\nDomanda: ${userText}\nAnalisi:\n${fullResponse.slice(0, 10000)}`
          saveMessageWithEmbedding(conversationId, 'knowledge', knowledge).catch(() => {})
        }
      } catch (err) {
        console.error('TELEGRAM BG error:', err)
        const msg = err instanceof Error ? err.message : String(err)
        let userMsg = `⚠️ ${msg.slice(0, 300)}`
        if (msg.includes('credit') || msg.includes('billing')) userMsg = '⚠️ Crediti API esauriti.'
        if (msg.includes('too large') || msg.includes('payload')) userMsg = '⚠️ File troppo pesante.'
        await sendTelegramMessage(chatId, userMsg).catch(() => {})
      } finally {
        if (typingInterval) clearInterval(typingInterval)
        // Bug 1: release del mutex chat (sempre, anche su errore)
        await safeSupabase(() =>
          supabase.from('telegram_active_jobs').delete().eq('chat_id', chatId)
        )
      }
    }

    // ── Classifica task: veloce vs durable ──
    // FIX W1.3 BUG-1: path Trigger.dev DISABILITATO temporaneamente.
    // Il dispatch nativo fallisce silenziosamente (Task #10 backlog). Finché non
    // funziona, ogni messaggio long-task entrava nel path durable, falliva,
    // mandava "Modalità degradata" e si bloccava. Adesso TUTTI i messaggi vanno
    // direttamente in waitUntil 300s che funziona perfettamente (testato in W1).
    // Riabilitare quando Task #10 è risolto.
    const isLongTask = classifyTask(userText, fileBlocks)
    console.log(`CLASSIFY: long=${isLongTask} userText="${userText.slice(0, 80)}"`)

    // Path veloce in-process (max 300s Vercel) — copre tutti i casi finché Task #10
    waitUntil(bgProcess())

    // Rispondi SUBITO al webhook — niente più timeout
    return NextResponse.json({ ok: true })
  } catch (err) {
    if (typingInterval) clearInterval(typingInterval)
    console.error('TELEGRAM error:', err)
    if (errorChatId) {
      const msg = err instanceof Error ? err.message : String(err)
      await sendTelegramMessage(errorChatId, `⚠️ ${msg.slice(0, 300)}`).catch(() => {})
      // Bug 1: release lock se errore prima del dispatch bgProcess (altrimenti
      // il lock rimane fino a stale cleanup 5 min, bloccando l'utente).
      await safeSupabase(() =>
        supabase.from('telegram_active_jobs').delete().eq('chat_id', errorChatId!)
      )
    }
    return NextResponse.json({ ok: true })
  }
}

export async function GET() {
  return NextResponse.json({ status: 'Cervellone Telegram webhook attivo' })
}
