/**
 * src/lib/agent-job.ts — Fase 1b
 *
 * Estrazione PURA del lavoro core di `bgProcess` (route Telegram) in una
 * funzione riusabile e serializzabile-input, condivisa fra:
 *   - il path flag-OFF (waitUntil(bgProcess()) → bgProcess chiama runAgentJob)
 *   - il path durable (workflow WDK → runAgentJobStep → runAgentJob)
 *
 * INVARIANTE FLAG-OFF: il corpo di runAgentJob riproduce ESATTAMENTE, nello
 * stesso ordine, le operazioni che oggi vivono dentro il `try` di bgProcess
 * (placeholder → stream Claude → mark uploads processed → parse documenti →
 * invio finale → salvataggio conoscenza/embedding).
 *
 * Mutex/heartbeat/typing: NON sono lavoro core, sono legati al ciclo di vita
 * della request HTTP. Restano in bgProcess (heartbeat + finally con release
 * mutex + clear intervalli). L'unico punto in cui bgProcess clear-a heartbeat
 * e typing PRIMA dell'invio finale è esposto qui come hook opzionale
 * `onStreamSettled`, invocato da runAgentJob nello stesso identico punto in cui
 * lo faceva il codice originale (subito dopo lo stream Claude + il mark uploads,
 * prima del parsing documenti). Nel path durable l'hook è assente (no-op):
 * il workflow non possiede heartbeat/typing della request.
 */

import type Anthropic from '@anthropic-ai/sdk'

import { callClaudeStreamTelegram } from '@/lib/claude'
import { isWorkingMemoryEnabled, buildWorkingContext } from '@/lib/working-memory'
import { captureArtifact, buildArtifactsPointer } from '@/lib/artifact-capture'
import { buildSentMailPointer } from '@/lib/sent-mail'
import { supabase } from '@/lib/supabase'
import { parseDocumentBlocks } from '@/lib/parseDocumentBlocks'
import { getTelegramSystemPrompt } from '@/lib/prompts'
import { saveMessageWithEmbedding } from '@/lib/memory'
import {
  sendTelegramMessage,
  editTelegramMessage,
  sendTelegramMessageWithId,
} from '@/lib/telegram-helpers'
import { safeSupabase } from '@/lib/resilience'

/**
 * Input SERIALIZZABILE del job agent (sicuro da passare a un workflow WDK).
 * Contiene esattamente i dati che bgProcess calcola e su cui lavora.
 */
export type AgentJobInput = {
  chatId: number
  userText: string
  conversationId: string
  history: Anthropic.MessageParam[]
  fileBlocks: Anthropic.ContentBlockParam[]
  fileDescription: string
  attachedRecentUploadIds: string[]
  requestId: string
  /** Serializzabile. Budget token per run; settato SOLO dal ramo durable (MAX_DURABLE_RUN_TOKENS).
   *  Undefined → callClaudeStreamTelegram usa il default MAX_RUN_TOKENS (200K). */
  maxRunTokens?: number
}

/**
 * Hook NON serializzabili, validi SOLO per il path flag-OFF in-process.
 * Non fanno parte di AgentJobInput perché un workflow durable non può
 * serializzare funzioni / handle di timer.
 */
export type AgentJobHooks = {
  /**
   * Invocato subito dopo il completamento dello stream Claude e il mark
   * degli upload recenti come processed, PRIMA del parsing documenti.
   * Nel path flag-OFF qui bgProcess clear-a heartbeatInterval e typingInterval
   * (identico ordine all'originale). Nel path durable: assente.
   */
  onStreamSettled?: () => void
}

export async function runAgentJob(
  input: AgentJobInput,
  hooks: AgentJobHooks = {},
): Promise<void> {
  const {
    chatId,
    userText,
    conversationId,
    history,
    fileBlocks,
    fileDescription,
    attachedRecentUploadIds,
  } = input

  const placeholderMsgId = await sendTelegramMessageWithId(chatId, '🧠 Sto elaborando...')
  const currentMsgId = placeholderMsgId
  let lastEditText = ''

  // FASE 1 Memoria procedurale (flag-gated, OFF di default): se attiva, carica la
  // checklist obbligatoria del tipo-documento inferito dalla richiesta. Best-effort.
  // Pointer "bozze già pronte" ri-iniettato a ogni turno: sopravvive alla finestra di
  // history (vedi cattura artefatti a fine turno) così il bot recupera invece di rigenerare.
  const workingContext = (await isWorkingMemoryEnabled())
    ? [
        await buildWorkingContext(userText, conversationId),
        await buildArtifactsPointer(conversationId),
        await buildSentMailPointer(conversationId),
      ].filter((b) => b && b.trim()).join('\n\n') || undefined
    : undefined

  const fullResponse = await callClaudeStreamTelegram(
    {
      messages: history,
      systemPrompt: await getTelegramSystemPrompt(userText),
      userQuery: userText,
      conversationId,
      hasFiles: fileBlocks.length > 0,
      workingContext,
      maxRunTokens: input.maxRunTokens,
    },
    async (accumulated) => {
      if (!currentMsgId) return
      const preview = accumulated.slice(0, 4000)
      if (preview === lastEditText) return
      lastEditText = preview
      await editTelegramMessage(chatId, currentMsgId, preview)
    }
  )

  if (attachedRecentUploadIds.length > 0) {
    await safeSupabase(() => supabase.from('telegram_recent_uploads')
      .update({ processed: true, processed_at: new Date().toISOString() })
      .in('id', attachedRecentUploadIds))
  }

  // Punto in cui bgProcess (flag-OFF) clear-a heartbeat + typing intervals.
  // Path durable: hook assente → no-op.
  hooks.onStreamSettled?.()

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
        ? `https://cervellone-five.vercel.app/doc/${(savedDoc as any).id}`
        : 'https://cervellone-five.vercel.app'

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

  // Cattura automatica artefatti in-task: se il bot ha COMPOSTO un artefatto sostanziale
  // (mail/lettera/documento) come testo — non già salvato come document block sopra — lo
  // persistiamo in `documents` (auto-bozza) così non lo perde quando scorre fuori dalla
  // finestra di history e lo recupera con ritrova_bozza. Best-effort, gated dal flag.
  const hadDocumentBlock = responseBlocks.some((b) => b.type === 'document')
  if (!hadDocumentBlock) {
    captureArtifact(conversationId, finalText).catch(() => {})
  }
}
