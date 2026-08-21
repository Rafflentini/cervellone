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
import { isWorkingMemoryEnabled, buildProcedureContext, buildActiveProjectContext } from '@/lib/working-memory'
import { buildTemplateContext } from '@/lib/template-context'
import { captureArtifact, buildArtifactsPointer } from '@/lib/artifact-capture'
import { captureImageExtraction, buildImagesPointer, type UploadedImageRef } from '@/lib/image-memory'
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
import { runHallucinationValidator, extractDriveUrls } from '@/v19/agent/hallucination-validator'
import { HallucinationError } from '@/v19/agent/types'

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
  /** Riferimenti Drive delle immagini caricate IN QUESTO turno (memoria immagini).
   *  Usati a fine turno da captureImageExtraction per legare l'estrazione alle foto. */
  uploadedImages?: UploadedImageRef[]
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

/**
 * ── Guardia anti-allucinazione (link Drive promessi e mai prodotti) ──
 *
 * Il validatore esisteva già (src/v19/agent/hallucination-validator.ts) ma era
 * cablato SOLO in src/v19/agent/loop.ts, che non è il path di produzione:
 * Telegram passa di qui. Senza questo blocco la difesa era testo nel system
 * prompt e nient'altro.
 *
 * Politica deliberata: NON blocchiamo e NON ri-promptiamo. Un re-prompt
 * automatico su un turno già completato rischia loop e costi; un blocco
 * farebbe sparire una risposta magari corretta al 95%. Avvisiamo e basta.
 */
const HALLUCINATION_CHECK_TIMEOUT_MS = 8_000

const HALLUCINATION_WARNING =
  '⚠️ Attenzione: un link a un file Drive citato in questo messaggio non risulta esistente. ' +
  'Non fidarti di quel link.'

const CHECK_TIMED_OUT = Symbol('hallucination-check-timeout')

/**
 * Ritorna il testo da inviare, con l'avviso in testa se un link Drive citato
 * non esiste. Non lancia MAI: la verifica non può far fallire il turno.
 *
 * Perché l'avviso va IN TESTA e non in coda: sopra i 4000 caratteri il testo
 * viene spezzato (edit del placeholder + messaggi successivi). In coda l'avviso
 * finirebbe nell'ultimo spezzone di una cascata che l'utente spesso non scorre;
 * in testa è nel messaggio principale, quello che legge di sicuro.
 */
async function annotateHallucinatedLinks(text: string): Promise<string> {
  // Costo ZERO senza link Drive: niente timer, niente import, niente rete.
  if (extractDriveUrls(text).length === 0) return text

  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    // Normalizzata a un valore risolto: così una reject tardiva (dopo il
    // timeout) non diventa una unhandled rejection.
    const validation: Promise<unknown> = runHallucinationValidator(text).then(
      () => null,
      (err: unknown) => err,
    )
    const timeout = new Promise<symbol>((resolve) => {
      timer = setTimeout(() => resolve(CHECK_TIMED_OUT), HALLUCINATION_CHECK_TIMEOUT_MS)
    })

    const outcome = await Promise.race([validation, timeout])

    if (outcome === CHECK_TIMED_OUT) {
      // maxDuration è 800s ma il turno ha già consumato tempo: meglio un
      // messaggio senza avviso che un turno scaduto.
      console.warn('[agent-job] hallucination check: timeout, invio senza verifica')
      return text
    }
    if (outcome instanceof HallucinationError) {
      console.error('[agent-job] link Drive ALLUCINATO nella risposta:', outcome.url)
      return `${HALLUCINATION_WARNING}\n\n${text}`
    }
    if (outcome) {
      console.warn('[agent-job] hallucination check non concluso (ignorato):', outcome)
    }
    return text
  } catch (err) {
    console.warn('[agent-job] hallucination check: errore inatteso (ignorato):', err)
    return text
  } finally {
    if (timer) clearTimeout(timer)
  }
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
  // NB: qui resta SOLO buildProcedureContext (la procedura è gated). Il contesto del
  // PROGETTO ATTIVO è stato spostato nel merge INCONDIZIONATO sotto (vedi projectContext),
  // così la continuità non dipende dal flag (incidente: bot perde il filo a metà task).
  const flaggedWorkingContext = (await isWorkingMemoryEnabled())
    ? [
        await buildProcedureContext(userText),
        await buildArtifactsPointer(conversationId),
        await buildSentMailPointer(conversationId),
      ].filter((b) => b && b.trim()).join('\n\n') || undefined
    : undefined

  // Contesto PROGETTO ATTIVO: INCONDIZIONATO (non dipende dal flag working_memory_enabled).
  // Best-effort: '' se non c'è progetto attivo / conversationId assente / errore.
  // Garantisce la continuità conversazionale anche con il flag OFF.
  const projectContext = await buildActiveProjectContext(conversationId)

  // Società attiva: INCONDIZIONATA e sempre presente. Ogni operazione contabile
  // deve sapere per quale azienda lavora, e il nome deve comparire nel contesto
  // perché il modello lo ripeta nelle conferme: la difesa vera contro la società
  // sbagliata è che l'Ingegnere legga il nome errato PRIMA di confermare.
  const { getSocietaAttiva, bloccoSocietaAttiva } = await import('./societa-attiva')
  const { getSocieta } = await import('./societa')
  const societaContext = bloccoSocietaAttiva(getSocieta(await getSocietaAttiva(conversationId)))

  // Injection modelli documento: INCONDIZIONATA (non dipende dal flag working_memory_enabled).
  // Cheap: cache 5 min + un solo loop regex sui template. Best-effort: '' su errore.
  // Lanciata in parallelo con il flag check sopra per non aggiungere latenza.
  const templateContext = await buildTemplateContext(userText)

  // Pointer "memoria immagini" INCONDIZIONATO (non gated dal flag working_memory):
  // ri-iniettato a ogni turno così le estrazioni delle foto sopravvivono alla finestra
  // di history (analogo a templateContext). Best-effort: '' se non c'è nulla.
  const imagesPointer = await buildImagesPointer(conversationId)

  // societaContext per PRIMO: e la cornice dentro cui va letto tutto il resto.
  const workingContext = [societaContext, projectContext, flaggedWorkingContext, templateContext, imagesPointer]
    .filter((b) => b && b.trim())
    .join('\n\n') || undefined

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

  // Verifica che i link Drive citati esistano DAVVERO, prima di spedirli.
  // `outgoingText` = finalText (+ eventuale avviso). Volutamente NON usato per
  // captureArtifact più sotto: l'avviso non deve finire nelle bozze salvate.
  const outgoingText = await annotateHallucinatedLinks(finalText)

  if (placeholderMsgId) {
    if (outgoingText.length <= 4000) {
      await editTelegramMessage(chatId, placeholderMsgId, outgoingText)
    } else {
      await editTelegramMessage(chatId, placeholderMsgId, outgoingText.slice(0, 4000))
      const remaining = outgoingText.slice(4000)
      if (remaining.trim()) await sendTelegramMessage(chatId, remaining)
    }
  } else {
    await sendTelegramMessage(chatId, outgoingText)
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

  // Cattura "memoria immagini" a fine turno: lega l'estrazione testuale del turno ai
  // riferimenti Drive delle foto caricate in questo turno. Usa `fullResponse` (testo
  // GREZZO del modello, come fa il path web) e NON `finalText`: quest'ultimo, sui turni
  // con document block, è il link "📄 …👉 url" e non l'estrazione vera. Best-effort;
  // se uploadedImages è vuoto, captureImageExtraction non salva (reason: no-images).
  captureImageExtraction(conversationId, fullResponse, input.uploadedImages ?? []).catch(() => {})

  // Debrief di fine turno: distilla decisioni e lezioni in memoria durevole. È il
  // pezzo che conserva il PERCHÉ di un lavoro, non solo i nomi che vi compaiono —
  // il riassunto notturno, per progetto, scarta proprio i ragionamenti.
  // Resta flag-gated (fail-closed) dentro maybeRunDebrief: accenderlo è una
  // decisione separata. Il .catch è deliberato: la risposta è già stata
  // consegnata all'utente, e un debrief fallito non deve poterla rovinare.
  const { maybeRunDebrief } = await import('./auto-debrief')
  await maybeRunDebrief({
    conversationId,
    userText,
    transcript: [
      ...history.map((m) => `[${m.role}]: ${typeof m.content === 'string' ? m.content : ''}`),
      `[user]: ${userText}`,
      `[assistant]: ${fullResponse}`,
    ].join('\n'),
    sendSummary: (line: string) => { void sendTelegramMessage(chatId, line) },
  }).catch(() => {})
}
