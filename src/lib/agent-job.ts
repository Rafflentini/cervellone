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
import { salvaRispostaTurno } from '@/lib/salva-risposta'
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
import { annotateHallucinatedLinks } from '@/lib/link-allucinati'

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

  // Il turno e' arrivato in fondo, o quello che leggiamo e' un messaggio del
  // loop (errore API, turno muto, budget esaurito)? Senza questa risposta, tutta
  // la pipeline qui sotto archivia il fallimento come se fosse il lavoro
  // richiesto: documenti, "conoscenza file", auto-bozza, memoria immagini,
  // debrief. Il caso peggiore e' la memoria immagini, che lega i drive_file_id
  // VERI delle foto al testo estratto: per 24 ore il bot "sa" di aver estratto
  // da quelle foto un messaggio di scusa, e il pointer gli dice di fidarsene.
  let turnoFallito = false
  // L'istante a cui attribuire la risposta: l'inizio del turno, non la fine
  // della scrittura. Una scrittura lenta non deve infilarsi DOPO la domanda
  // successiva dell'Ingegnere.
  const inizioTurno = new Date().toISOString()
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
    },
    { onTurnFailed: (motivo) => { turnoFallito = true; console.warn(`[agent-job] turno non consegnato (${motivo}): niente archiviazione`) } },
  )

  if (attachedRecentUploadIds.length > 0) {
    await safeSupabase(() => supabase.from('telegram_recent_uploads')
      .update({ processed: true, processed_at: new Date().toISOString() })
      .in('id', attachedRecentUploadIds))
  }

  // Punto in cui bgProcess (flag-OFF) clear-a heartbeat + typing intervals.
  // Path durable: hook assente → no-op.
  hooks.onStreamSettled?.()

  // ⭐ Il salvataggio sta nel `finally`: qui sotto ci sono un insert su
  // Supabase, un validatore e un edit Telegram, e se uno esplode la risposta
  // del modello non deve sparire dalla storia. Prima la scriveva il motore,
  // prima di tutto questo, e per questo non poteva contenere i link.
  const linkDocumenti: string[] = []
  try {
    // Gestisci documenti e risposta finale.
    // Su turno fallito non si salva niente: il testo e' troncato a meta'.
    const responseBlocks = turnoFallito ? [] : parseDocumentBlocks(fullResponse)
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
      // Lo stesso link va anche in STORIA: senza, al turno dopo il modello
      // non puo ripassarlo e tende a RIGENERARE il documento.
      linkDocumenti.push(`

📄 ${title}
👉 ${docUrl}`)
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
    if (!turnoFallito && fileBlocks.length > 0 && fullResponse.length > 200) {
      const knowledge = `[Analisi file "${fileDescription}"]\nDomanda: ${userText}\nAnalisi:\n${fullResponse.slice(0, 10000)}`
      saveMessageWithEmbedding(conversationId, 'knowledge', knowledge).catch(() => {})
    }

    // Cattura automatica artefatti in-task: se il bot ha COMPOSTO un artefatto sostanziale
    // (mail/lettera/documento) come testo — non già salvato come document block sopra — lo
    // persistiamo in `documents` (auto-bozza) così non lo perde quando scorre fuori dalla
    // finestra di history e lo recupera con ritrova_bozza. Best-effort, gated dal flag.
    const hadDocumentBlock = responseBlocks.some((b) => b.type === 'document')
    if (!turnoFallito && !hadDocumentBlock) {
      captureArtifact(conversationId, finalText).catch(() => {})
    }

    // Cattura "memoria immagini" a fine turno: lega l'estrazione testuale del turno ai
    // riferimenti Drive delle foto caricate in questo turno. Usa `fullResponse` (testo
    // GREZZO del modello, come fa il path web) e NON `finalText`: quest'ultimo, sui turni
    // con document block, è il link "📄 …👉 url" e non l'estrazione vera. Best-effort;
    // se uploadedImages è vuoto, captureImageExtraction non salva (reason: no-images).
    if (!turnoFallito) {
      captureImageExtraction(conversationId, fullResponse, input.uploadedImages ?? []).catch(() => {})
    }

    // Debrief di fine turno: distilla decisioni e lezioni in memoria durevole. È il
    // pezzo che conserva il PERCHÉ di un lavoro, non solo i nomi che vi compaiono —
    // il riassunto notturno, per progetto, scarta proprio i ragionamenti.
    // Resta flag-gated (fail-closed) dentro maybeRunDebrief: accenderlo è una
    // decisione separata. Il .catch è deliberato: la risposta è già stata
    // consegnata all'utente, e un debrief fallito non deve poterla rovinare.
    // Su turno fallito il debrief distillerebbe una "lezione" da un messaggio
    // d'errore, e la metterebbe in memoria durevole.
    const { maybeRunDebrief } = await import('./auto-debrief')
    if (!turnoFallito) await maybeRunDebrief({
      conversationId,
      userText,
      transcript: [
        ...history.map((m) => `[${m.role}]: ${typeof m.content === 'string' ? m.content : ''}`),
        `[user]: ${userText}`,
        `[assistant]: ${fullResponse}`,
      ].join('\n'),
      sendSummary: (line: string) => { void sendTelegramMessage(chatId, line) },
    }).catch(() => {})
  } finally {
    await salvaRispostaTurno({
      conversationId,
      testo: fullResponse + linkDocumenti.join(String.fromCharCode(10)),
      turnoFallito,
      istante: inizioTurno,
      tag: 'tg',
    })
  }
}
