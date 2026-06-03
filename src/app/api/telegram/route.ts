/**
 * app/api/telegram/route.ts — All fixes integrated
 * SEC-002: webhook secret, SEC-003: rate limit, FUN-002: video,
 * FUN-003: sticker/location, /nuova: clears embeddings, UX-002: thinking msg
 */

import { NextRequest, NextResponse } from 'next/server'
import { waitUntil } from '@vercel/functions'
import type Anthropic from '@anthropic-ai/sdk'
import crypto from 'crypto'
import { supabase } from '@/lib/supabase'
import { getSupabaseServer } from '@/lib/supabase-server'
import { downloadTelegramFile, buildContentBlocks, transcribeAudio, sendTelegramMessage, sendTyping } from '@/lib/telegram-helpers'
import { runAgentJob, type AgentJobInput } from '@/lib/agent-job'
import { shouldUseDurable } from '@/lib/workflow/should-use-durable'
import { createRun } from '@/lib/workflow/runs'
import { start } from 'workflow/api'
import { runAgentTask } from '@/workflows/agent-task'
import { validateWebhookSecret } from '@/lib/auth'
import { rateLimit } from '@/lib/rate-limiter'
import { safeSupabase } from '@/lib/resilience'
import { confirmFicStep1, confirmFicStep2, cancelFic } from '@/lib/fic-write-tools'
// Trigger.dev imports temporaneamente non usati (Task #10 backlog)
// import { tasks } from '@trigger.dev/sdk/v3'
// import type { cervelloneLongTask } from '../../../../trigger/cervellone-long-task'

export const maxDuration = 800

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
      if (Array.isArray(existing) && existing.length > 0) return NextResponse.json({ ok: true })
      await safeSupabase(() => supabase.from('telegram_dedup').insert({ chat_id: chatId, message_id: msgId }))
    }

    let userText = message.text || message.caption || ''
    let fileBlocks: Anthropic.ContentBlockParam[] = []
    let fileDescription = ''
    let currentUploadFileId: string | null = null // FIX multi-foto: file_id dell'upload di QUESTO turno

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
        // Echo trascrizione all'utente PRIMA del processing LLM (pattern Claude AI app).
        // Cosi se la risposta poi si interrompe / sbaglia, l'utente ha la trascrizione
        // come riferimento e puo riformulare. Best-effort: errori non bloccano il flow.
        await sendTelegramMessage(chatId, `🎙 _Trascrizione:_ ${userText}`).catch(() => {})
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

      // AUTO-ARCHIVE: salva sempre il file originale su Drive prima di passarlo al LLM
      let archivedDriveLink: string | null = null
      if (fileData && message.document.file_size && message.document.file_size < 32 * 1024 * 1024) {
        try {
          const { uploadBinaryToDrive, getTelegramInboxFolderId } = await import('@/lib/drive')
          const folderId = await getTelegramInboxFolderId()
          const { webViewLink } = await uploadBinaryToDrive(
            Buffer.from(fileData.buffer),
            fileData.fileName,
            fileData.mimeType,
            folderId,
          )
          archivedDriveLink = webViewLink
          console.log(`[TG-ARCHIVE] file=${fileData.fileName} → ${archivedDriveLink}`)
        } catch (err) {
          console.warn(`[TG-ARCHIVE] failed, continuing without archive:`, err instanceof Error ? err.message : err)
        }
      }

      fileBlocks = await buildContentBlocks(fileData)
      fileDescription = message.document.file_name || fileData.fileName
      if (archivedDriveLink) {
        fileDescription += ` (originale archiviato su Drive: ${archivedDriveLink})`
      }
      // FIX multi-upload: registra l'upload (prima del mutex) per poterlo allegare al turno
      await safeSupabase(() => supabase.from('telegram_recent_uploads').insert({
        chat_id: chatId,
        telegram_file_id: message.document.file_id,
        drive_url: archivedDriveLink,
        filename: fileData.fileName,
        caption: message.caption ?? null,
        mime_type: fileData.mimeType,
      }))
      currentUploadFileId = message.document.file_id
    }

    // ── Photo ──
    if (message.photo?.length > 0) {
      await sendTyping(chatId)
      const largest = message.photo[message.photo.length - 1]
      const fileData = await downloadTelegramFile(largest.file_id)
      if (fileData) {
        // AUTO-ARCHIVE + record persistente foto_pending (parità con web): la foto è SUBITO su Drive.
        let archivedDriveLink: string | null = null
        if (!largest.file_size || largest.file_size < 32 * 1024 * 1024) {
          try {
            const { ingestPhotoUpload } = await import('@/lib/foto-ingest')
            const [rec] = await ingestPhotoUpload({
              canale: 'telegram',
              chatId: chatIdToUuid(chatId),
              items: [{ buffer: Buffer.from(fileData.buffer), mimeType: fileData.mimeType, filename: fileData.fileName }],
            })
            archivedDriveLink = rec?.driveUrl ?? null
            if (archivedDriveLink) console.log(`[TG-ARCHIVE] file=${fileData.fileName} → ${archivedDriveLink}`)
          } catch (err) {
            console.error('[TG-AUTOARCHIVE] photo archive failed:', err instanceof Error ? err.message : err)
          }
        }

        fileBlocks = await buildContentBlocks(fileData)
        fileDescription = fileData.fileName
        if (archivedDriveLink) {
          fileDescription += ` (originale archiviato su Drive: ${archivedDriveLink})`
        }
        // FIX multi-foto: registra l'upload (prima del mutex) per poterlo allegare al turno
        await safeSupabase(() => supabase.from('telegram_recent_uploads').insert({
          chat_id: chatId,
          telegram_file_id: largest.file_id,
          drive_url: archivedDriveLink,
          filename: fileData.fileName,
          caption: message.caption ?? null,
          mime_type: fileData.mimeType,
        }))
        currentUploadFileId = largest.file_id
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

    // ─── /ricorda <testo> — salva in memoria esplicita (sub-progetto B) ───
    if (userText.startsWith('/ricorda ') || userText === '/ricorda') {
      const testo = userText.startsWith('/ricorda ') ? userText.slice('/ricorda '.length).trim() : ''
      if (!testo) {
        await sendTelegramMessage(chatId, '⛔ Uso: /ricorda <testo da memorizzare>')
        return NextResponse.json({ ok: true })
      }
      const convId = chatIdToUuid(chatId)
      const sb = getSupabaseServer()
      const { error } = await sb.from('cervellone_memoria_esplicita').insert({
        contenuto: testo,
        source: 'telegram',
        conversation_id: convId,
      })
      if (error) {
        await sendTelegramMessage(chatId, `⛔ Errore salvataggio: ${error.message}`)
      } else {
        await sendTelegramMessage(chatId, '✅ Salvato in memoria esplicita.')
      }
      return NextResponse.json({ ok: true })
    }

    // ─── /dimentica <uuid> — DELETE memoria esplicita (sub-progetto B) ───
    if (userText.startsWith('/dimentica ') || userText === '/dimentica') {
      const uuid = userText.startsWith('/dimentica ') ? userText.slice('/dimentica '.length).trim() : ''
      const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
      if (!uuidRegex.test(uuid)) {
        await sendTelegramMessage(chatId, '⛔ Formato UUID non valido. Serve UUID esatto.')
        return NextResponse.json({ ok: true })
      }
      const sb = getSupabaseServer()
      const { data, error } = await sb
        .from('cervellone_memoria_esplicita')
        .delete()
        .eq('id', uuid)
        .select('id')
      if (error) {
        await sendTelegramMessage(chatId, `⛔ Errore: ${error.message}`)
      } else if (!data || data.length === 0) {
        await sendTelegramMessage(chatId, '⛔ ID non trovato.')
      } else {
        await sendTelegramMessage(chatId, '✅ Riga rimossa.')
      }
      return NextResponse.json({ ok: true })
    }

    // ─── /invia_<uuid> + /annulla_<uuid> — confirm flow mail subagent V19 ───
    const mInvia = userText.match(/^\/invia_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/i)
    if (mInvia) {
      const { confirmPendingSend } = await import('@/v19/tools/email/telegram-confirm')
      const r = await confirmPendingSend(mInvia[1])
      await sendTelegramMessage(chatId, r.message)
      return NextResponse.json({ ok: true })
    }
    const mAnnulla = userText.match(/^\/annulla_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/i)
    if (mAnnulla) {
      const { cancelPendingSend } = await import('@/v19/tools/email/telegram-confirm')
      const r = await cancelPendingSend(mAnnulla[1])
      await sendTelegramMessage(chatId, r.message)
      return NextResponse.json({ ok: true })
    }

    const mConferma = userText.match(/^\/conferma_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/i)
    const mIgnora = userText.match(/^\/ignora_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/i)
    if (mConferma || mIgnora) {
      const uuid = (mConferma ?? mIgnora)![1]
      const mod = await import('@/lib/doc-proposte-actions')
      const r = mConferma
        ? await mod.confirmProposta(uuid)
        : await mod.ignoraProposta(uuid)
      await sendTelegramMessage(chatId, r.message)
      return NextResponse.json({ ok: true })
    }

    // Governance accesso cartelle Drive — doppia conferma (parità con web)
    const mAccOk2 = userText.match(/^\/accesso_ok2_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/i)
    const mAccOk = userText.match(/^\/accesso_ok_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/i)
    const mAccNo = userText.match(/^\/accesso_no_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/i)
    if (mAccOk2 || mAccOk || mAccNo) {
      const uuid = (mAccOk2 ?? mAccOk ?? mAccNo)![1]
      const mod = await import('@/lib/drive-policy-actions')
      const r = mAccOk2
        ? await mod.confirmStep2(uuid)
        : mAccOk
          ? await mod.confirmStep1(uuid)
          : await mod.cancelPending(uuid)
      await sendTelegramMessage(chatId, r.message)
      return NextResponse.json({ ok: true })
    }

    // ── /reset — sblocca manualmente il mutex se il bot è bloccato ──
    if (userText.trim().toLowerCase() === '/reset') {
      await safeSupabase(() => supabase.from('telegram_active_jobs').delete().eq('chat_id', chatId))
      await sendTelegramMessage(chatId, '✅ Sbloccato. Puoi rimandare il messaggio.')
      return NextResponse.json({ ok: true })
    }

    // ── Bug 1: mutex per chat ──
    // Evita bgProcess paralleli sulla stessa chat: se l'utente manda un messaggio
    // mentre il bot sta elaborando il precedente, droppiamo il nuovo per non
    // creare hallucination ("Trovato!" senza tool eseguito) e streaming sovrapposti.
    // Stale lock cleanup a 90s (heartbeat-based): task live aggiorna started_at ogni 20s.
    // Se Supabase down → fallback degradato (lockClaimed=true), lascia passare.
    // FIC bozze documenti - doppia conferma (parita con web)
    const mFicOk2 = userText.match(/^\/fic_ok2_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/i)
    const mFicOk = userText.match(/^\/fic_ok_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/i)
    const mFicNo = userText.match(/^\/fic_no_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/i)
    if (mFicOk2 || mFicOk || mFicNo) {
      const uuid = (mFicOk2 ?? mFicOk ?? mFicNo)![1]
      const message = mFicOk2
        ? await confirmFicStep2(uuid)
        : mFicOk
          ? await confirmFicStep1(uuid)
          : await cancelFic(uuid)
      await sendTelegramMessage(chatId, message)
      return NextResponse.json({ ok: true })
    }

    const STALE_LOCK_MS = 90 * 1000
    const requestId = `${chatId}-${msgId || Date.now()}-${Date.now()}`
    let lockClaimed = true
    let lockReason = 'fresh'  // diagnostica: motivo dell'esito
    try {
      const { error: insertErr } = await supabase
        .from('telegram_active_jobs')
        .insert({ chat_id: chatId, request_id: requestId })
      if (!insertErr) {
        lockReason = 'fresh'  // prima volta, lock acquisito pulito
      } else {
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
              lockClaimed = false
              lockReason = `race-after-stale (${Math.round(ageMs/1000)}s)`
            } else {
              lockReason = `stale-released (${Math.round(ageMs/1000)}s)`
            }
          } else {
            lockClaimed = false
            lockReason = `active (${Math.round(ageMs/1000)}s)`
          }
        } else {
          lockClaimed = false
          lockReason = `insertErr-no-existing-row: ${insertErr.message}`
        }
      }
    } catch (err) {
      lockReason = `supabase-down: ${err instanceof Error ? err.message : err}`
      console.warn('[MUTEX] Supabase exception, degraded claim=true:', lockReason)
      // lockClaimed resta true → degraded mode, no serializzazione
    }

    console.log(`[MUTEX] chat=${chatId} msgId=${msgId} claimed=${lockClaimed} reason=${lockReason}`)

    if (!lockClaimed) {
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
      recentMessages.reverse()
    }

    const history: Anthropic.MessageParam[] = ((recentMessages as any[]) || [])
      .filter(m => m.role === 'user' || m.role === 'assistant')
      .map(m => ({ role: m.role, content: m.content }))

    const attachedRecentUploadIds: string[] = []

    // FIX multi-foto (Approccio 2): allega gli upload recenti NON ancora processati di questa chat
    // (es. 2ª foto di un album scartata dal mutex), escludendo quello del messaggio corrente.
    try {
      const cutoffIso = new Date(Date.now() - 10 * 60 * 1000).toISOString()
      const pending = await safeSupabase(
        () => supabase.from('telegram_recent_uploads')
          .select('id, telegram_file_id')
          .eq('chat_id', chatId)
          .eq('processed', false)
          .gt('inserted_at', cutoffIso)
          .order('inserted_at', { ascending: true })
          .limit(5),
        []
      )
      const pendingRows = (Array.isArray(pending) ? pending : []) as Array<{ id: string; telegram_file_id: string }>
      for (const row of pendingRows) {
        if (row.telegram_file_id === currentUploadFileId) continue // già nei fileBlocks correnti
        try {
          const extra = await downloadTelegramFile(row.telegram_file_id)
          if (extra) {
            fileBlocks = [...fileBlocks, ...(await buildContentBlocks(extra))]
            attachedRecentUploadIds.push(row.id)
          } else {
            console.warn(`[recent-uploads] download fallito file_id=${row.telegram_file_id}, skip`)
          }
        } catch (err) {
          console.warn('[recent-uploads] attach error:', err instanceof Error ? err.message : err)
        }
      }
    } catch (err) {
      console.warn('[recent-uploads] step saltato:', err instanceof Error ? err.message : err)
    }

    if (fileBlocks.length > 0) {
      history.push({ role: 'user', content: [...fileBlocks, { type: 'text', text: userText }] })
    } else {
      history.push({ role: 'user', content: userText })
    }
    if (history.length > 0 && history[0].role !== 'user') history.shift()

    // FIX BUG-DDT (07/05/2026): compressione documenti stratificata.
    //
    // Bug precedente: TUTTI i ~~~document venivano sostituiti con stringa
    // generica "[Documento gia generato]", facendo sparire i dati reali
    // (es. articoli DDT, voci preventivo) dalla history. Quando l'utente
    // chiedeva modifiche di formato ("impaginalo A4"), il modello non
    // vedeva più il contenuto e ricostruiva a memoria → HALLUCINATION
    // di dati che non erano mai stati specificati.
    //
    // Repro: chat #X del 07/05 — DDT con piastrelle "IRIS cotto serie 8"
    // mai menzionate dall'utente, inventate dal modello su richiesta di
    // re-impaginazione perché non vedeva più i dati originali.
    //
    // Fix stratificato:
    //   1. Identifica l'INDICE dell'ultimo messaggio assistant con un ~~~document.
    //   2. L'ultimo documento NON viene compresso — è quello su cui si lavora ora.
    //   3. I documenti precedenti vengono troncati a 3000 char (header + struttura
    //      + dati chiave preservati) invece di cancellati interamente.
    //   4. Il placeholder include il <h1> del documento per identificarlo.
    {
      // Trova l'indice dell'ultimo messaggio assistant che contiene un documento.
      let lastDocIdx = -1
      for (let k = history.length - 1; k >= 0; k--) {
        const m = history[k]
        if (m.role === 'assistant' && typeof m.content === 'string' && m.content.includes('~~~document')) {
          lastDocIdx = k
          break
        }
      }

      const compressDoc = (docBlock: string): string => {
        // docBlock = "~~~document\n...html...\n~~~"
        const titleMatch = docBlock.match(/<h1[^>]*>([^<]+)<\/h1>/i)
        const title = titleMatch ? titleMatch[1].trim().slice(0, 80) : 'senza titolo'
        const TRUNCATE_AT = 3000
        if (docBlock.length <= TRUNCATE_AT) return docBlock // già piccolo, lascia
        const head = docBlock.slice(0, TRUNCATE_AT)
        const remaining = docBlock.length - TRUNCATE_AT
        return `${head}\n[...documento "${title}" troncato — ${remaining} char omessi per economia di contesto]\n~~~\n`
      }

      for (let k = 0; k < history.length; k++) {
        const msg = history[k]
        if (msg.role !== 'assistant' || typeof msg.content !== 'string') continue
        if (k === lastDocIdx) continue // ultimo documento: integro
        // Per i precedenti: sostituisci ogni blocco ~~~document con versione troncata
        msg.content = msg.content.replace(/~~~document\n[\s\S]*?~~~(?:\n|$)/g, (match: string) => compressDoc(match))
      }
    }

    // ── Claude (ASINCRONO) — risponde subito, elabora in background ──
    const bgProcess = async () => {
      // Heartbeat: aggiorna started_at ogni 20s per mantenere il lock "fresco".
      // Se Vercel hard-kills la funzione, il heartbeat si ferma e il lock diventa
      // stale dopo STALE_LOCK_MS (90s), permettendo al messaggio successivo di reclamarlo.
      let heartbeatInterval: NodeJS.Timeout | null = setInterval(() => {
        safeSupabase(() =>
          supabase
            .from('telegram_active_jobs')
            .update({ started_at: new Date().toISOString() })
            .eq('chat_id', chatId)
            .eq('request_id', requestId)
        ).catch(() => {})
      }, 20_000)

      try {
        // FASE 1b: lavoro core estratto in runAgentJob (condiviso con il path
        // durable). L'hook onStreamSettled riproduce ESATTAMENTE il punto in cui
        // l'originale clear-ava heartbeat + typing (subito dopo lo stream Claude
        // + mark uploads, prima del parsing documenti).
        await runAgentJob(
          {
            chatId,
            userText,
            conversationId,
            history,
            fileBlocks,
            fileDescription,
            attachedRecentUploadIds,
            requestId,
          },
          {
            onStreamSettled: () => {
              if (heartbeatInterval) { clearInterval(heartbeatInterval); heartbeatInterval = null }
              if (typingInterval) { clearInterval(typingInterval); typingInterval = null }
            },
          },
        )
      } catch (err) {
        console.error('TELEGRAM BG error:', err)
        const msg = err instanceof Error ? err.message : String(err)
        let userMsg = `⚠️ ${msg.slice(0, 300)}`
        if (msg.includes('credit') || msg.includes('billing')) userMsg = '⚠️ Crediti API esauriti.'
        if (msg.includes('too large') || msg.includes('payload')) userMsg = '⚠️ File troppo pesante.'
        await sendTelegramMessage(chatId, userMsg).catch(() => {})
      } finally {
        if (heartbeatInterval) { clearInterval(heartbeatInterval); heartbeatInterval = null }
        if (typingInterval) clearInterval(typingInterval)
        // Bug 1: release del mutex chat (sempre, anche su errore)
        await safeSupabase(() =>
          supabase.from('telegram_active_jobs').delete().eq('chat_id', chatId)
        )
      }
    }

    // ── Classifica task: veloce vs durable (FASE 1b) ──
    // shouldUseDurable = flag `durable_workflows_enabled` ON **E** task lungo.
    // FLAG OFF (prod): ritorna sempre false → ramo else → comportamento IDENTICO
    // a oggi (waitUntil(bgProcess()), path in-process 300s).
    if (await shouldUseDurable(userText, fileBlocks)) {
      // ── Path DURABLE (flag ON + long task) ──
      const input: AgentJobInput = {
        chatId,
        userText,
        conversationId,
        history,
        fileBlocks,
        fileDescription,
        attachedRecentUploadIds,
        requestId,
      }
      const run = await start(runAgentTask, [input])
      await createRun({
        id: run.runId,
        channel: 'telegram',
        chatId: String(chatId),
        conversationId,
      })

      // Mutex/heartbeat: nel path durable bgProcess NON viene eseguito, quindi
      // il suo finally (che rilasciava il lock) non gira e non c'è heartbeat.
      // Il workflow possiede ora il job in modo durevole/crash-safe: il mutex
      // in-process (serializzazione bgProcess paralleli) non serve più per
      // questa request. Lo rilascio QUI per non lasciare la chat bloccata fino
      // allo stale-cleanup a 90s. Fermo anche il typingInterval avviato prima
      // del dispatch (il workflow invia il proprio placeholder/stream).
      if (typingInterval) { clearInterval(typingInterval); typingInterval = null }
      await safeSupabase(() =>
        supabase.from('telegram_active_jobs').delete().eq('chat_id', chatId)
      )
    } else {
      // ── Path FLAG-OFF (default prod) — INVARIATO ──
      // Path veloce in-process (max 300s Vercel). bgProcess gestisce
      // heartbeat + release mutex nel proprio finally, come sempre.
      waitUntil(bgProcess())
    }

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
