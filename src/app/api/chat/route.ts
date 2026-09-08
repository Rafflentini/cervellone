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
import { saveMessageOnly, saveEmbeddingOnly } from '@/lib/memory'
import { societaAttivaPerDocumenti } from '@/lib/societa-documenti'
import { conTetto } from '@/lib/tetto-attesa'
import { comprimiDocumentiNellaStoria, type MessaggioStoria } from '@/lib/compressione-documenti'
import { salvaRispostaTurno } from '@/lib/salva-risposta'
import { waitUntil } from '@vercel/functions'

/**
 * Quanto si aspetta la scrittura della risposta prima di chiudere comunque lo
 * stream. Oltre, l'Ingegnere resterebbe col testo a schermo e lo spinner
 * acceso: meglio chiudere e lasciare che la riga si scriva in background.
 */
const ATTESA_MASSIMA_SCRITTURA_MS = 5_000

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

  // L'istante del TURNO, preso adesso e non quando la riga viene scritta. Il
  // messaggio dell'utente e' gia' a DB (lo scrive il client prima di partire),
  // quindi questo istante gli sta subito dopo. Se la connessione cade e il
  // server finisce molto piu' tardi, senza questo la risposta si infilerebbe
  // dopo la domanda successiva.
  const inizioTurno = new Date().toISOString()

  // BUG4 fix
  try {
  const messages = filterEmptyMessages(rawMessages)

  // I documenti gia' consegnati si accorciano, l'ULTIMO no: e' quello su cui
  // l'Ingegnere sta lavorando. Prima qui si schiacciavano tutti, con uno stub
  // che non conservava nemmeno il titolo — cioe' il server disfaceva la cura
  // che il suo stesso client aveva applicato, e sul web il modello non vedeva
  // mai il documento appena prodotto. Su Telegram lo vedeva.
  comprimiDocumentiNellaStoria(messages as unknown as MessaggioStoria[])

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
        async start(controller) {
          controller.enqueue(new TextEncoder().encode(testo))
          // Anche queste risposte vanno in `messages`, e devono passare da qui:
          // i nove rami che chiamano `rispostaSemplice` escono PRIMA del
          // salvataggio in fondo al file. Finche' a salvare era il browser non
          // si notava; da quando salva il server, senza questa riga la conferma
          // di un comando sparirebbe.
          //
          // Il caso peggiore e' `/condividi_ok_`, che risponde con un link
          // firmato: non e' ricostruibile da nessuna parte. Ma vale anche per
          // "Fattura emessa" e "Mail inviata a...": riaprendo la conversazione
          // si troverebbe il comando e sotto il vuoto, e al turno dopo il
          // modello potrebbe ri-proporre un'operazione gia' fatta.
          if (conversationId && testo.trim()) {
            // Solo la RIGA nel percorso critico: aspettare anche l'embedding
            // terrebbe il comando appeso mezzo secondo a testo gia' a schermo,
            // col pulsante invio bloccato e i messaggi dirottati in coda.
            const scrittura = saveMessageOnly(conversationId, 'assistant', testo, inizioTurno)
            const salvato = await conTetto(scrittura, ATTESA_MASSIMA_SCRITTURA_MS, 'in-corso')
            if (salvato === 'in-corso') {
              console.warn('[chat] comando: scrittura lenta, prosegue in background')
              waitUntil(scrittura)
            } else if (!salvato) {
              console.error('[chat] risposta a comando NON salvata')
            } else {
              waitUntil(saveEmbeddingOnly(conversationId, 'assistant', testo).catch(() => {}))
            }
          }
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
  const { eConfermaInvio } = await import('@/lib/conferma-invio')
  if (eConfermaInvio(userQuery)) {
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
? await confirmSalStep2(uuid, await societaAttivaPerDocumenti(conversationId))
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
      // Dichiarati FUORI dal try: il salvataggio avviene nel `finally`, e da li'
      // quello che l'Ingegnere ha gia' letto dev'essere raggiungibile anche se a
      // meta' strada e' stata sollevata un'eccezione. Con la `const` dentro il
      // try, un guasto della pipeline di archiviazione buttava via una risposta
      // gia' consegnata a schermo.
      let fullResponse = ''
      const docLinks: string[] = []
      let testoErrore = ''
      try {
        fullResponse = await callClaudeStream(
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
        testoErrore = `\n\n⚠️ ${msg.slice(0, 300)}`
        invia(testoErrore)
      } finally {
        // ── La risposta la salva il SERVER (8 set 2026) ──
        // Prima la scriveva il browser a streaming finito. Misurato in
        // produzione: due turni conclusi con `success` (199 e 2.961 token,
        // $0,27) non sono mai arrivati a `messages`, perche' era caduta la
        // connessione. Il lavoro del server non puo' dipendere dal fatto che il
        // browser sia ancora vivo.
        //
        // Si salva QUI e non nel loop perche' qui il testo e' completo: i link
        // ai documenti nascono dopo il loop, e ritrovarli e' il motivo per cui
        // si riapre una conversazione vecchia.
        //
        // Nel `finally` e non in fondo al try: quello che l'Ingegnere ha gia'
        // letto va salvato anche se la pipeline di archiviazione e' esplosa a
        // meta'. E si salva anche il testo dell'errore, perche' e' cio' che ha
        // sotto gli occhi.
        //
        // `await`, non fire-and-forget: su serverless quel che parte dopo la
        // chiusura dello stream non e' garantito che arrivi in fondo. Ma con un
        // TETTO: `controller.close()` sta dietro questa attesa, e un Supabase
        // lento terrebbe lo stream aperto con il testo gia' a schermo — spinner
        // acceso e pulsante invio bloccato — fino a `maxDuration`, 800 secondi.
        // Scaduto il tetto si chiude comunque e la scrittura prosegue in
        // background con `waitUntil`.
        // La stessa funzione che usa Telegram (`salva-risposta.ts`): c'erano
        // tre copie divergenti di questa logica, e quella di Telegram
        // sbagliava in quattro modi.
        //
        // `inizioTurno` e non l'istante della scrittura: se la connessione
        // dell'Ingegnere e' caduta e il server ha finito molto dopo, la riga
        // scritta adesso si infilerebbe DOPO la domanda successiva.
        //
        // Il criterio per la memoria semantica e' `turnoFallito` e SOLO
        // quello. Non `testoErrore`: se il modello ha risposto benissimo e
        // poi e' esploso l'insert in `documents`, la risposta e' valida.
        await salvaRispostaTurno({
          conversationId: conversationId ?? '',
          testo: fullResponse + docLinks.join(String.fromCharCode(10)) + testoErrore,
          turnoFallito,
          istante: inizioTurno,
          tag: 'chat',
        })
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
