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
import { confirmFicStep1, confirmFicStep2, cancelFic } from '@/lib/fic-write-tools'
import { confirmSalStep1, confirmSalStep2, cancelSal } from '@/lib/sal-tools'
import { isWorkingMemoryEnabled, buildProcedureContext, buildActiveProjectContext } from '@/lib/working-memory'
import { buildTemplateContext } from '@/lib/template-context'
import { buildArtifactsPointer, captureArtifact } from '@/lib/artifact-capture'
import { captureImageExtraction, buildImagesPointer, type UploadedImageRef } from '@/lib/image-memory'

export const maxDuration = 800

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

  // BUG4 fix
  try {
  const messages = filterEmptyMessages(rawMessages)

  // V10: Comprimi blocchi ~~~document nei messaggi assistant (HTML enorme -> riferimento breve)
  for (const msg of messages) {
    if (msg.role === 'assistant' && typeof msg.content === 'string') {
      msg.content = msg.content.replace(
        /~~~document\n[\s\S]*?~~~(?:\n|$)/g,
        '[Documento gia generato — visibile nel pannello anteprima]\n'
      )
    }
  }

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

  // Parità con Telegram: salva SUBITO su Drive (Inbox) + record foto_pending le foto caricate da web.
  let uploadedImageRefs: UploadedImageRef[] = []
  if (lastUserMsg && Array.isArray(lastUserMsg.content)) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const imgs = (lastUserMsg.content as any[]).filter((b: any) =>
      b?.type === 'image' && b?.source?.type === 'base64' && typeof b.source.data === 'string'
    )
    if (imgs.length > 0) {
      try {
        const { ingestPhotoUpload, hasFotoIngestProblems } = await import('@/lib/foto-ingest')
        const res = await ingestPhotoUpload({
          canale: 'web',
          chatId: conversationId ?? null,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          items: imgs.map((b: any, i: number) => ({
            buffer: Buffer.from(b.source.data, 'base64'),
            mimeType: b.source.media_type || 'image/jpeg',
            filename: `web-${Date.now()}-${i}.jpg`,
          })),
        })
        uploadedImageRefs = res.records.map((r) => ({
          driveFileId: r.driveFileId,
          filename: r.filename,
          driveUrl: r.driveUrl,
        }))
        // Le foto che NON sono entrate non spariscono in silenzio: restano a log con il motivo
        // (fatal = Inbox Drive giu, orphans = byte su Drive senza riga → archivia_foto non le vede).
        if (hasFotoIngestProblems(res)) {
          console.error('[FOTO-INGEST web] ingest NON pulito:', JSON.stringify({
            caricate: res.records.length,
            fatal: res.fatal ?? null,
            orfane: res.orphans.map(o => ({ filename: o.filename, driveFileId: o.driveFileId })),
            scartate: res.skipped.map(s => s.filename),
            fallite: res.failed.map(f => f.filename),
          }))
        }
      } catch (err) {
        console.error('[FOTO-INGEST web] errore:', err instanceof Error ? err.message : err)
      }
    }
  }

  // ─── Comandi di conferma, PRIMA di chiamare il modello ───
  //
  // Vanno intercettati qui: se arrivassero all'LLM, li vedrebbe come messaggi
  // normali e risponderebbe "non posso bypassare il dispatcher".
  //
  // Fino al 3 settembre 2026 la chat web ne gestiva quattro famiglie e Telegram
  // sette. Le tre mancanti — /sal_*, /regola_*, /condividi_ok_ — erano il buco
  // piu' insidioso dell'equipollenza, perche' era GIA' raggiungibile: i tool
  // sono gli stessi su entrambi i canali, quindi il modello puo' proporre un SAL
  // o una regola dalla chat web, e li' quel comando era solo testo. Il flusso si
  // apriva e non si poteva chiudere. Vedi [[feedback_due_canali_equipollenti]].
  const UUID = '([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})'
  const comando = (nome: string) => userQuery.match(new RegExp(`^/${nome}_${UUID}\\b`, 'i'))

  // I quattro blocchi che c'erano prima ripetevano queste otto righe una per
  // famiglia di comandi: aggiungerne altre tre a copia-incolla e' esattamente il
  // modo in cui in questo repo sono nate tutte le divergenze.
  const rispostaSemplice = (testo: string) =>
    new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(testo))
          controller.close()
        },
      }),
      { headers: { 'Content-Type': 'text/plain; charset=utf-8' } },
    )

  // Mail subagent V19: /invia_<uuid> · /annulla_<uuid>
  const mInvia = comando('invia')
  const mAnnulla = comando('annulla')
  if (mInvia || mAnnulla) {
    const uuid = (mInvia ?? mAnnulla)![1]
    const mod = await import('@/v19/tools/email/telegram-confirm')
    const r = mInvia ? await mod.confirmPendingSend(uuid) : await mod.cancelPendingSend(uuid)
    return rispostaSemplice(r.message)
  }

  // ─── Conferma invio mail a LINGUAGGIO NATURALE: "invia pure mail" (parità Telegram) ───
  if (/^\s*(s[iì][,.\s]+)?(conferm[oai]\s+(l'?\s*)?invio|(invia|manda|spedisci)(la|lo|tela)?(\s+pure)?\s+(la\s+|quella\s+)?(mail|email|e-?mail|messaggio))(\s+pure)?\s*[.!…]*\s*$/i.test(userQuery)) {
    const { confirmLatestPendingSend } = await import('@/v19/tools/email/telegram-confirm')
    const r = await confirmLatestPendingSend()
    return rispostaSemplice(r.message)
  }

  // Proposte documento: /conferma_<uuid> · /ignora_<uuid>
  const mConferma = comando('conferma')
  const mIgnora = comando('ignora')
  if (mConferma || mIgnora) {
    const uuid = (mConferma ?? mIgnora)![1]
    const mod = await import('@/lib/doc-proposte-actions')
    const r = mConferma ? await mod.confirmProposta(uuid) : await mod.ignoraProposta(uuid)
    return rispostaSemplice(r.message)
  }

  // Governance accesso cartelle Drive — doppia conferma (parità con Telegram)
  const mAccOk2 = comando('accesso_ok2')
  const mAccOk = comando('accesso_ok')
  const mAccNo = comando('accesso_no')
  if (mAccOk2 || mAccOk || mAccNo) {
    const uuid = (mAccOk2 ?? mAccOk ?? mAccNo)![1]
    const mod = await import('@/lib/drive-policy-actions')
    const r = mAccOk2
      ? await mod.confirmStep2(uuid)
      : mAccOk
        ? await mod.confirmStep1(uuid)
        : await mod.cancelPending(uuid)
    return rispostaSemplice(r.message)
  }

  // FIC bozze documenti — doppia conferma (parità con Telegram)
  const mFicOk2 = comando('fic_ok2')
  const mFicOk = comando('fic_ok')
  const mFicNo = comando('fic_no')
  if (mFicOk2 || mFicOk || mFicNo) {
    const uuid = (mFicOk2 ?? mFicOk ?? mFicNo)![1]
    const message = mFicOk2
      ? await confirmFicStep2(uuid)
      : mFicOk
        ? await confirmFicStep1(uuid)
        : await cancelFic(uuid)
    return rispostaSemplice(message)
  }

  // SAL — doppia conferma. Mancava sul web: il modello poteva proporre
  // /sal_ok_<uuid> dalla chat e l'Ingegnere non aveva modo di confermarlo.
  const mSalOk2 = comando('sal_ok2')
  const mSalOk = comando('sal_ok')
  const mSalNo = comando('sal_no')
  if (mSalOk2 || mSalOk || mSalNo) {
    const uuid = (mSalOk2 ?? mSalOk ?? mSalNo)![1]
    const message = mSalOk2
      ? await confirmSalStep2(uuid)
      : mSalOk
        ? await confirmSalStep1(uuid)
        : await cancelSal(uuid)
    return rispostaSemplice(message)
  }

  // Regole apprese — doppia conferma. `/regola_ok_` mostra il testo LETTO DAL
  // DATABASE, `/regola_ok2_` lo attiva: cosi' cio' che l'Ingegnere approva lo
  // scrive la route, non il modello, che potrebbe parafrasarlo.
  if (userQuery.trim().toLowerCase() === '/regole') {
    const { formatRegoleList } = await import('@/lib/regole-proposte')
    return rispostaSemplice(await formatRegoleList())
  }
  const mRegOk2 = comando('regola_ok2')
  const mRegOk = comando('regola_ok')
  const mRegNo = comando('regola_no')
  const mRegVia = comando('regola_via')
  if (mRegOk2 || mRegOk || mRegNo || mRegVia) {
    const mod = await import('@/lib/regole-proposte')
    const r = mRegOk2
      ? await mod.confermaRegola(mRegOk2[1])
      : mRegOk
        ? await mod.anteprimaRegola(mRegOk[1])
        : mRegNo
          ? await mod.rifiutaRegola(mRegNo[1])
          : await mod.rimuoviRegola(mRegVia![1])
    return rispostaSemplice(r.message)
  }

  // Privacy doc: conferma condivisione → firma e invia il link a scadenza
  const mShareOk = comando('condividi_ok')
  if (mShareOk) {
    const { confirmShareProposal } = await import('@/lib/share-proposte')
    const url = await confirmShareProposal(mShareOk[1])
    return rispostaSemplice(
      url
        ? `🔗 Link di condivisione (scade tra i giorni indicati):\n${url}\n\nChi ha il link vede il documento finché non scade.`
        : '⚠️ Proposta di condivisione non trovata, già usata o scaduta.',
    )
  }

  // FASE 1 Memoria procedurale (flag-gated, OFF di default): se attiva, carica la
  // checklist obbligatoria del tipo-documento inferito dalla richiesta. Best-effort.
  // NB: qui resta SOLO buildProcedureContext (la procedura è gated). Il contesto del
  // PROGETTO ATTIVO è stato spostato nel merge INCONDIZIONATO sotto (projectContext),
  // per parità col path Telegram: la continuità non dipende dal flag.
  const flaggedWorkingContext = (await isWorkingMemoryEnabled())
    ? await buildProcedureContext(userQuery)
    : undefined

  // Contesto PROGETTO ATTIVO: INCONDIZIONATO (non dipende dal flag working_memory_enabled).
  // Best-effort: '' se non c'è progetto attivo / conversationId assente / errore.
  const projectContext = await buildActiveProjectContext(conversationId ?? '')

  // Società attiva: stessa cornice del path Telegram. Va iniettata anche qui,
  // altrimenti dall'app web le operazioni contabili non saprebbero per quale
  // azienda lavorano — e il modello non ripeterebbe il nome nelle conferme.
  const { getSocietaAttiva, bloccoSocietaAttiva } = await import('@/lib/societa-attiva')
  const { getSocieta } = await import('@/lib/societa')
  const societaContext = bloccoSocietaAttiva(getSocieta(await getSocietaAttiva(conversationId ?? '')))

  // Injection modelli documento: INCONDIZIONATA (non dipende dal flag working_memory_enabled).
  // Cheap: cache 5 min + un solo loop regex sui template. Best-effort: '' su errore.
  const templateContext = await buildTemplateContext(userQuery)

  const artifactsPointer = await buildArtifactsPointer(conversationId ?? '')
  const imagesPointer = await buildImagesPointer(conversationId ?? '')
  const workingContext = [societaContext, projectContext, flaggedWorkingContext, templateContext, artifactsPointer, imagesPointer]
    .filter((b) => b && b.trim())
    .join('\n\n') || undefined

  const encoder = new TextEncoder()
  const readable = new ReadableStream({
    async start(controller) {
      // Il turno e' finito su un errore dell'API? Fino al 3 set 2026 lo si
      // capiva dal fatto che callClaudeStream RILANCIAVA, e il catch qui sotto
      // saltava tutta l'archiviazione. Ora il motore restituisce un messaggio
      // leggibile invece di lanciare (parita' con Telegram), quindi il segnale
      // arriva da qui. Senza, una risposta troncata a meta' — "Gentile Ing. ...
      // ⚠️ Errore temporaneo del servizio AI" — verrebbe archiviata come bozza
      // finita, e al turno dopo il modello la ritroverebbe mutilata.
      let turnoFallito = false
      // Se il client ha abbandonato (tab chiusa, navigazione), il controller e'
      // chiuso e enqueue lancia. Non e' un guasto del modello: lasciarlo
      // propagare farebbe registrare 'api_error' sul modello attivo, e cinque
      // schede chiuse a meta' basterebbero a far rollbackare un modello sano.
      const invia = (testo: string) => {
        try { controller.enqueue(encoder.encode(testo)) } catch { /* client andato via */ }
      }
      try {
        const fullResponse = await callClaudeStream(
          { messages: trimmedMessages, systemPrompt: await getChatSystemPrompt(userQuery), userQuery, conversationId, hasFiles, workingContext },
          {
            onText: (text) => invia(text),
            onToolStart: () => invia('\n\n🔍 *Cerco informazioni...*\n\n'),
            onTurnFailed: (motivo) => { turnoFallito = true; console.warn(`[chat] turno non consegnato (${motivo}): niente archiviazione`) },
          },
        )

        if (conversationId && !turnoFallito) {
          captureArtifact(conversationId, fullResponse).catch(() => {})
          captureImageExtraction(conversationId, fullResponse, uploadedImageRefs).catch(() => {})
        }

        // Estrai document blocks e salva come documenti linkabili.
        // Su turno fallito non si salva niente: il testo e' troncato a meta'.
        const responseBlocks = turnoFallito ? [] : parseDocumentBlocks(fullResponse)
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
              docLinks.push(`\n\n📄 **${title}**\n👉 [Apri documento](https://cervellone-five.vercel.app/doc/${savedDoc.id})`)
            }
          }
        }

        if (docLinks.length > 0) {
          invia(docLinks.join('\n'))
        }
      } catch (err) {
        // Rete di sicurezza per gli errori NON-API (il motore quelli li gestisce
        // da se'): guasti della pipeline di archiviazione, Supabase, ecc.
        const msg = err instanceof Error ? err.message : String(err)
        console.error('CHAT error:', msg)
        invia(`\n\n⚠️ ${msg.slice(0, 300)}`)
      } finally {
        controller.close()
      }
    },
  })

  return new Response(readable, {
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-cache' },
  })
  } catch (err) {
    console.error('[CHAT POST] errore setup pre-stream:', err instanceof Error ? err.message : err)
    return new Response('Si è verificato un problema nel preparare la richiesta — può capitare quando carichi molte immagini insieme. Riprova caricando meno foto per volta (2-3 alla volta).', {
      status: 200,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    })
  }
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
