/**
 * app/api/telegram/route.ts — All fixes integrated
 * SEC-002: webhook secret, SEC-003: rate limit, FUN-002: video,
 * FUN-003: sticker/location, /nuova: clears embeddings, UX-002: thinking msg
 */

import { NextRequest, NextResponse } from 'next/server'
import { waitUntil } from '@vercel/functions'
import { societaAttivaPerDocumenti } from '@/lib/societa-documenti'
import type Anthropic from '@anthropic-ai/sdk'
import crypto from 'crypto'
import { supabase } from '@/lib/supabase'
import { saveMessageOnly, saveEmbeddingOnly } from '@/lib/memory'
import { comprimiDocumentiNellaStoria, type MessaggioStoria } from '@/lib/compressione-documenti'
import { getSupabaseServer } from '@/lib/supabase-server'
import { downloadTelegramFile, buildContentBlocks, sendTelegramMessage, sendTyping } from '@/lib/telegram-helpers'
import { transcribeAudio } from '@/lib/trascrizione'
import { runAgentJob, type AgentJobInput } from '@/lib/agent-job'
import { shouldUseDurable } from '@/lib/workflow/should-use-durable'
import { createRun, getActiveRunForChat } from '@/lib/workflow/runs'
import { start } from 'workflow/api'
import { runAgentTask } from '@/workflows/agent-task'
import { validateWebhookSecret } from '@/lib/auth'
import { rateLimit } from '@/lib/rate-limiter'
import { safeSupabase } from '@/lib/resilience'
import { messaggioGiaVisto } from '@/lib/telegram-dedup'
import { confirmFicStep1, confirmFicStep2, cancelFic } from '@/lib/fic-write-tools'
import { confirmSalStep1, confirmSalStep2, cancelSal } from '@/lib/sal-tools'
import { parseOpusCommand, computeOpusUntil, isOpusExpired, OPUS_MODEL, SONNET_MODEL } from '@/lib/opus-ttl'
import { MAX_DURABLE_RUN_TOKENS } from '@/lib/run-budget'
// Il codice dei comandi, una volta sola per i due canali: accetta la forma CON
// e SENZA trattini e ritorna l'uuid canonico. Prima erano 18 regex in fila qui
// e un helper gemello su `api/chat/route.ts`.
import { comandoUuid } from '@/lib/comandi-uuid'
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
  // Arretrati drenati dalla coda e non ancora consegnati al lavoro vero: sono
  // gia' marcati letti, quindi finche' stanno qui dentro vanno restituiti su
  // QUALUNQUE uscita — return anticipati e catch esterno compresi.
  let arretratiFuoriCoda: Array<{ testo: string; created_at: string }> = []
  let typingInterval: NodeJS.Timeout | null = null

  try {
    const body = await request.json()
    const message = body.message
    if (!message) return NextResponse.json({ ok: true })

    const chatId: number = message.chat.id
    errorChatId = chatId

    // SEC-003: Rate limiting.
    // ⚠️ BUG CRITICO STORICO (fix 14 giu): un album / upload multiplo arriva come N webhook
    // SEPARATI con lo stesso media_group_id. Col vecchio limite unico 5/60s, dal 6° file in poi
    // il webhook veniva SCARTATO QUI, PRIMA dell'ingest → perdita SILENZIOSA (l'utente credeva di
    // averli caricati). Ora i messaggi con MEDIA usano un bucket dedicato con limite ALTO (consente
    // album da 30+ file); il solo testo resta protetto a 5/60s contro lo spam.
    const hasMediaUpload = !!(
      message.photo || message.video || message.document ||
      message.audio || message.voice || message.animation
    )
    const rlKey = hasMediaUpload ? `tg_media_${chatId}` : `tg_${chatId}`
    const rlMax = hasMediaUpload ? 90 : 5
    if (!rateLimit(rlKey, 60_000, rlMax)) {
      // Il messaggio deve dire cosa e' andato PERSO, non solo di aspettare.
      // "Troppi messaggi, attenda un momento" suona come un rinvio: l'utente
      // aspetta e va avanti, convinto che quella foto sia arrivata. Invece
      // questo webhook viene scartato QUI e il file non esiste da nessuna parte
      // — la stessa perdita silenziosa del 14 giugno, con un avviso che la
      // nasconde meglio.
      //
      // Il rate limit sta PRIMA del dedup, quindi rimandare lo stesso file
      // funziona davvero: dirlo e' un consiglio eseguibile, non una scusa.
      await sendTelegramMessage(
        chatId,
        hasMediaUpload
          ? '⚠️ *Questo file NON è stato salvato*: troppi invii in un minuto.\n\nAttenda una decina di secondi e *lo rimandi* — gli altri file già inviati sono al sicuro.'
          : '⚠️ Troppi messaggi di fila: questo non è stato preso in carico. Attenda un momento e lo rimandi.',
      )
      return NextResponse.json({ ok: true })
    }

    // REL-001: la riconsegna dello stesso messaggio non si lavora due volte.
    //
    // Qui c'era un LEGGI-POI-SCRIVI: fra la select e l'insert non c'era
    // atomicita', e due consegne simultanee passavano entrambe. Peggio, la
    // select usava `safeSupabase(..., [])`, e `[]` significa "non visto":
    // col database in difficolta' la guardia non si limitava a non funzionare,
    // diceva ATTIVAMENTE di procedere.
    //
    // `telegram_dedup` ha gia' PRIMARY KEY (chat_id, message_id): l'atomicita'
    // stava li' dentro. Ora si scrive prima e si guarda l'esito.
    const msgId = message.message_id
    if (msgId && (await messaggioGiaVisto(chatId, msgId))) {
      return NextResponse.json({ ok: true })
    }

    let userText = message.text || message.caption || ''
    let fileBlocks: Anthropic.ContentBlockParam[] = []
    let fileDescription = ''
    let currentUploadFileId: string | null = null // FIX multi-foto: file_id dell'upload di QUESTO turno
    // Memoria immagini: riferimenti Drive delle foto ingerite IN QUESTO turno, passati a
    // runAgentJob → captureImageExtraction per legare l'estrazione alle immagini caricate.
    const turnImageRefs: { driveFileId: string; filename: string; driveUrl: string | null }[] = []

    // ── Voice ──
    if (!userText && (message.voice || message.audio)) {
      const fileId = message.voice?.file_id || message.audio?.file_id
      if (fileId) {
        await sendTyping(chatId)
        const durataVocale = message.voice?.duration ?? message.audio?.duration
        const esito = await transcribeAudio(fileId, durataVocale)
        userText = esito.testo
        if (!userText) {
          // `problema` dice cosa e' andato storto e cosa fare. Prima qui c'era
          // una frase sola per ogni causa — chiave scaduta, file troppo grande,
          // vocale partito a vuoto — e soprattutto una trascrizione inventata
          // dal silenzio ("Sottotitoli creati dalla comunità Amara.org") NON
          // finiva qui: passava come se fosse una richiesta dell'Ingegnere.
          await sendTelegramMessage(chatId, esito.problema ?? 'Non sono riuscito a trascrivere il vocale.')
          return NextResponse.json({ ok: true })
        }
        // Echo trascrizione all'utente PRIMA del processing LLM (pattern Claude AI app).
        // Cosi se la risposta poi si interrompe / sbaglia, l'utente ha la trascrizione
        // come riferimento e puo riformulare. Best-effort: errori non bloccano il flow.
        await sendTelegramMessage(chatId, `🎙 _Trascrizione:_ ${userText}`).catch(() => {})
      }
    }

    // Quello che l'Ingegnere ha DAVVERO scritto o detto, fotografato qui e non
    // dopo. Serve alla coda e al classificatore, e il punto e' proprio il
    // momento: `message.text || message.caption` non basta — per un VOCALE sono
    // entrambi vuoti, il contenuto e' la trascrizione appena scritta in
    // `userText`. Da qui in giu' invece `userText` si sporca di frasi
    // fabbricate dal codice ("Analizza questo file: ...", "la foto NON e' stata
    // salvata..."), che riproposte al turno dopo sarebbero ordini su allegati
    // che non ci sono piu'.
    const testoOriginale = userText.trim()

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

      // Dal cantiere si usa "Invia come file" (iPhone) per non comprimere: la foto arriva
      // come message.document. Se la trattassimo da documento finirebbe su Drive SENZA riga
      // cervellone_foto_pending → `archivia_foto` non la vedrebbe mai. Instradala all'ingest foto.
      const { isPhotoLikeDocument, photoMimeFromFilename } = await import('@/lib/upload-flow')
      const documentIsPhoto = isPhotoLikeDocument({
        mime_type: message.document.mime_type,
        file_name: message.document.file_name,
      })

      // AUTO-ARCHIVE: salva sempre il file originale su Drive prima di passarlo al LLM
      let archivedDriveLink: string | null = null
      if (documentIsPhoto && (!message.document.file_size || message.document.file_size < 32 * 1024 * 1024)) {
        try {
          const { ingestPhotoUpload, formatFotoIngestWarning } = await import('@/lib/foto-ingest')
          const rawMime: string = typeof message.document.mime_type === 'string' ? message.document.mime_type : ''
          const photoFilename: string = message.document.file_name || fileData.fileName
          const photoMime = rawMime.toLowerCase().startsWith('image/')
            ? rawMime
            : (photoMimeFromFilename(photoFilename) ?? photoMimeFromFilename(fileData.fileName) ?? fileData.mimeType)
          const ingested = await ingestPhotoUpload({
            canale: 'telegram',
            chatId: chatIdToUuid(chatId),
            items: [{ buffer: Buffer.from(fileData.buffer), mimeType: photoMime, filename: photoFilename }],
          })
          for (const rec of ingested.records) {
            turnImageRefs.push({ driveFileId: rec.driveFileId, filename: rec.filename, driveUrl: rec.driveUrl })
          }
          archivedDriveLink = ingested.records[0]?.driveUrl ?? null
          if (archivedDriveLink) console.log(`[TG-ARCHIVE] foto-come-file=${photoFilename} → ${archivedDriveLink}`)
          const warn = formatFotoIngestWarning(ingested)
          if (warn) await sendTelegramMessage(chatId, warn).catch(() => {})
        } catch (err) {
          console.error('[TG-ARCHIVE] foto-come-file ingest failed:', err instanceof Error ? err.message : err)
          await sendTelegramMessage(
            chatId,
            '⚠️ Errore durante l\'archiviazione della foto inviata come file: *non risulta salvata*. La rimandi, per favore.',
          ).catch(() => {})
        }
      } else if (fileData && message.document.file_size && message.document.file_size < 32 * 1024 * 1024) {
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
      if (!fileData) {
        // BUCO STORICO (mancava l'else): token assente, getFile fallito o CDN Telegram 5xx
        // facevano sparire la foto SENZA un solo messaggio. Ora si dice, e si dice la verità:
        // non è salvata da nessuna parte, va rimandata.
        await sendTelegramMessage(
          chatId,
          '⚠️ Non riesco a scaricare la foto da Telegram: *NON è stata salvata*. La rimandi, per favore.',
        )
        if (!userText) {
          userText = "L'utente ha inviato una foto ma il download da Telegram è fallito: la foto NON è stata salvata né archiviata. Diglielo e chiedi di rimandarla."
        }
        fileDescription = 'foto (download da Telegram fallito)'
      } else {
        // AUTO-ARCHIVE + record persistente foto_pending (parità con web): la foto è SUBITO su Drive.
        let archivedDriveLink: string | null = null
        if (!largest.file_size || largest.file_size < 32 * 1024 * 1024) {
          try {
            const { ingestPhotoUpload, formatFotoIngestWarning } = await import('@/lib/foto-ingest')
            const ingested = await ingestPhotoUpload({
              canale: 'telegram',
              chatId: chatIdToUuid(chatId),
              items: [{ buffer: Buffer.from(fileData.buffer), mimeType: fileData.mimeType, filename: fileData.fileName }],
            })
            // Memoria immagini: raccogli TUTTI i ref Drive ingeriti in questo turno.
            for (const rec of ingested.records) {
              turnImageRefs.push({ driveFileId: rec.driveFileId, filename: rec.filename, driveUrl: rec.driveUrl })
            }
            const [rec] = ingested.records
            archivedDriveLink = rec?.driveUrl ?? null
            if (archivedDriveLink) console.log(`[TG-ARCHIVE] file=${fileData.fileName} → ${archivedDriveLink}`)
            // Ciò che NON è entrato va detto PRIMA della risposta normale.
            const warn = formatFotoIngestWarning(ingested)
            if (warn) await sendTelegramMessage(chatId, warn).catch(() => {})
          } catch (err) {
            console.error('[TG-AUTOARCHIVE] photo archive failed:', err instanceof Error ? err.message : err)
            await sendTelegramMessage(
              chatId,
              '⚠️ Errore durante l\'archiviazione della foto: *non risulta salvata*. La rimandi, per favore.',
            ).catch(() => {})
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

    // ── FUN-002: Video — salva il VIDEO vero su Drive (Inbox), non solo la thumb ──
    if (message.video && fileBlocks.length === 0) {
      await sendTyping(chatId)
      const videoSize = message.video.file_size || 0
      if (videoSize > 20 * 1024 * 1024) {
        // Telegram Bot API non scarica file oltre ~20MB: messaggio ONESTO, niente download.
        await sendTelegramMessage(
          chatId,
          '⚠️ Il video supera i 20 MB: Telegram non permette al bot di scaricarlo. Caricalo direttamente nella cartella Drive del progetto, oppure invialo come file più leggero.',
        )
        if (!userText) {
          userText = "L'utente ha inviato un video oltre i 20 MB: non posso scaricarlo da Telegram, va caricato manualmente su Drive o reinviato più leggero."
        }
        fileDescription = 'video oltre 20 MB (non scaricabile dal bot)'
      } else {
        const fileData = await downloadTelegramFile(message.video.file_id)
        if (!fileData) {
          await sendTelegramMessage(chatId, '⚠️ Non riesco a scaricare il video.')
          if (!userText) {
            userText = "L'utente ha inviato un video ma il download da Telegram è fallito. Chiedi di riprovare o di caricarlo su Drive."
          }
          fileDescription = 'video (download fallito)'
        } else {
          // Nome file: usa file_name se presente, altrimenti deriva dall'estensione del mime.
          const extFromMime = fileData.mimeType === 'video/quicktime' ? 'mov'
            : fileData.mimeType === 'video/x-msvideo' ? 'avi'
            : fileData.mimeType === 'video/x-matroska' ? 'mkv'
            : fileData.mimeType === 'video/webm' ? 'webm'
            : fileData.mimeType === 'video/x-m4v' ? 'm4v'
            : 'mp4'
          const fileName = message.video.file_name || `video-${Date.now()}.${extFromMime}`
          const mimeType = fileData.mimeType && fileData.mimeType.startsWith('video/')
            ? fileData.mimeType
            : 'video/mp4'

          // AUTO-ARCHIVE: salva sempre il video originale su Drive (garanzia salva-video).
          let archivedDriveLink: string | null = null
          let archivedDriveFileId: string | null = null
          try {
            const { uploadBinaryToDrive, getTelegramInboxFolderId } = await import('@/lib/drive')
            const folderId = await getTelegramInboxFolderId()
            const { id, webViewLink } = await uploadBinaryToDrive(
              Buffer.from(fileData.buffer),
              fileName,
              mimeType,
              folderId,
            )
            archivedDriveLink = webViewLink
            archivedDriveFileId = id
            console.log(`[TG-ARCHIVE] video=${fileName} → ${archivedDriveLink}`)
          } catch (err) {
            console.warn(`[TG-ARCHIVE] video archive failed, continuing without archive:`, err instanceof Error ? err.message : err)
          }

          // Facoltativo: estrai la thumbnail per dare al modello il contenuto VISIVO del video.
          const thumb = message.video.thumb || message.video.thumbnail
          if (thumb) {
            try {
              const thumbData = await downloadTelegramFile(thumb.file_id)
              if (thumbData) {
                fileBlocks = await buildContentBlocks({ ...thumbData, mimeType: 'image/jpeg', fileName: 'video_frame.jpg' })
              }
            } catch (err) {
              console.warn('[TG-VIDEO] thumb extract failed:', err instanceof Error ? err.message : err)
            }
          }

          // fileDescription con il link Drive così il modello conosce l'ID per archivia_documento.
          fileDescription = fileName
          if (archivedDriveLink) {
            fileDescription += ` (video originale archiviato su Drive: ${archivedDriveLink}`
            if (archivedDriveFileId) fileDescription += ` — drive_file_id: ${archivedDriveFileId}`
            fileDescription += ')'
          } else {
            fileDescription += ' (archiviazione su Drive fallita — avvisa l\'utente, non fingere successo)'
          }

          // Registra l'upload (stesso pattern del ramo Document) così è allegabile al turno
          // e il modello può poi spostarlo con archivia_documento.
          await safeSupabase(() => supabase.from('telegram_recent_uploads').insert({
            chat_id: chatId,
            telegram_file_id: message.video.file_id,
            drive_url: archivedDriveLink,
            filename: fileName,
            caption: message.caption ?? null,
            mime_type: mimeType,
          }))
          currentUploadFileId = message.video.file_id
        }
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

    /**
     * Risponde a un comando E lo mette in storia.
     *
     * Prima i nove rami qui sotto facevano solo `sendTelegramMessage` + `return`:
     * zero righe in `messages`. E nemmeno il comando dell'Ingegnere entrava,
     * perche' il `return` sta a monte di `runAgentTurn`, l'unico punto che
     * scrive la riga utente. Il caso peggiore e' `/condividi_ok_`, che risponde
     * con un link FIRMATO: non e' ricostruibile da nessuna parte, e al turno
     * dopo il modello non sa che quel documento e' gia' stato condiviso.
     *
     * Sul web la stessa cosa la fa `rispostaSemplice` (`api/chat/route.ts`).
     */
    const rispondiESalva = async (testoBot: string) => {
      await sendTelegramMessage(chatId, testoBot)
      const convId = chatIdToUuid(chatId)
      const istante = new Date().toISOString()
      const scritture = (async () => {
        const okUser = await saveMessageOnly(convId, 'user', userText, istante)
        const okBot = await saveMessageOnly(convId, 'assistant', testoBot, istante)
        if (!okUser || !okBot) console.error('[telegram] risposta a comando NON salvata')
        else await saveEmbeddingOnly(convId, 'assistant', testoBot).catch(() => {})
      })()
      waitUntil(scritture)
      return NextResponse.json({ ok: true })
    }

    // ── A: RAFFICA = cataloga SENZA analizzare (anti analisi-storm + mutex) ──
    // Se arrivano 4+ file NON processati in ~60s, NON avvio il turno LLM (niente analisi foto-per-foto):
    // i file sono già su Drive + registro, mando UN avviso (throttle) e attendo l'istruzione.
    // 1-3 file → comportamento normale (analisi). ECCEZIONE: se QUESTA foto porta una caption
    // (= istruzione esplicita, es. "mettila in C2026-010") NON sopprimo, la lascio agire (audit P2).
    // SAFE-FALLBACK: qualsiasi errore/colonna mancante → conta 0 → si procede come sempre.
    const hasCaptionInstruction = !!(message.caption && message.caption.trim())
    if (currentUploadFileId !== null && !hasCaptionInstruction) {
      try {
        const { isRaffica, shouldSendRafficaAck } = await import('@/lib/upload-flow')
        const since = new Date(Date.now() - 60_000).toISOString()
        const recent = await safeSupabase(
          () => supabase.from('telegram_recent_uploads').select('id')
            .eq('chat_id', chatId).eq('processed', false).gte('inserted_at', since),
          [],
        )
        const count = Array.isArray(recent) ? recent.length : 0
        if (isRaffica(count)) {
          if (shouldSendRafficaAck(String(chatId), Date.now())) {
            await sendTelegramMessage(
              chatId,
              '📥 Ho ricevuto i file e li sto raccogliendo (non li analizzo). Mi dica dove archiviarli, es. "archivia nel cantiere ...".',
            ).catch(() => {})
          }
          return NextResponse.json({ ok: true })
        }
      } catch (err) {
        console.error('[RAFFICA]', err instanceof Error ? err.message : err)
        // safe-fallback: prosegui col flusso normale (analisi)
      }
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
      // Chiude anche il progetto attivo. Il conversationId e' deterministico per
      // chat, quindi senza questo il cantiere resta "attivo" per sempre: dopo un
      // /nuova il modello non ha piu' nessuna storia — non puo' sapere su cosa
      // stiamo lavorando — ma l'archiviazione foto continuerebbe a dedurre il
      // cantiere di prima. L'utente ha appena creduto di ripulire il tavolo.
      // Niente `.catch()`: nessuna delle due lancia — loggano da sé e tornano
      // un esito. Un catch qui sarebbe codice morto che sembra prudenza.
      const { closeActiveProject } = await import('@/lib/working-memory')
      await closeActiveProject(convId)
      const { clearFotoContesto } = await import('@/lib/foto-contesto')
      await clearFotoContesto(convId)
      // Anche la coda: una conversazione "nuova" non deve nascere coi messaggi
      // arretrati della precedente dentro.
      const { svuotaCoda } = await import('@/lib/telegram-coda')
      await svuotaCoda(chatId)
      await sendTelegramMessage(chatId, 'Conversazione azzerata. La memoria permanente è intatta.')
      return NextResponse.json({ ok: true })
    }
    if (userText === '/help') {
      // /reset mancava proprio qui: e' l'unica via d'uscita quando il bot resta
      // bloccato su un messaggio precedente, ed era invisibile all'utente.
      await sendTelegramMessage(chatId, '🧠 *Comandi Cervellone*\n\n/nuova — Azzera conversazione\n/reset — Sblocca il bot se è fermo su un messaggio\n/regole — Regole che ho imparato e Lei ha confermato\n/opus [minuti] — Opus a tempo (default 60 min)\n/sonnet — Modello standard\n/modello — Mostra modello attivo\n/aggiorna — Controlla aggiornamenti\n/skill — Lista skill disponibili\n/help — Questa lista')
      return NextResponse.json({ ok: true })
    }
    const opusMinutes = parseOpusCommand(userText)
    if (opusMinutes !== null) {
      const { impostaModello } = await import('@/lib/modello-attivo')
      const esito = await impostaModello('opus', opusMinutes)
      return await rispondiESalva(`${esito}
(Per estendere: /opus 120. Per tornare subito: /sonnet)`)
    }
    if (userText === '/sonnet') {
      const { impostaModello } = await import('@/lib/modello-attivo')
      return await rispondiESalva(await impostaModello('sonnet'))
    }
    if (userText === '/modello') {
      // Stessa logica del tool `modello_attivo`, che vale anche sul web:
      // il modello e' uno solo per tutto il sistema.
      const { leggiModelloAttivo } = await import('@/lib/modello-attivo')
      return await rispondiESalva(await leggiModelloAttivo())
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

    // ─── /societa [nome] — quale delle due societa per le operazioni contabili ───
    if (userText === '/societa' || userText.startsWith('/societa ')) {
      const convId = chatIdToUuid(chatId)
      const { getSocietaAttiva, setSocietaAttiva } = await import('@/lib/societa-attiva')
      const { getSocieta, listaSocieta, risolviSocieta } = await import('@/lib/societa')

      const argomento = userText.startsWith('/societa ') ? userText.slice('/societa '.length).trim() : ''

      if (!argomento) {
        const attuale = getSocieta(await getSocietaAttiva(convId))
        const elenco = listaSocieta()
          .map((s) => `• ${s.denominazione} — /societa ${s.codice}`)
          .join('\n')
        await sendTelegramMessage(
          chatId,
          `🏢 Societa attiva: *${attuale.denominazione}* (P.IVA ${attuale.piva})\n\nPer cambiare:\n${elenco}`,
        )
        return NextResponse.json({ ok: true })
      }

      // Se il testo non nomina UNA societa con certezza non si indovina: una
      // deduzione sbagliata qui produce documenti fiscali dell'azienda sbagliata.
      const codice = risolviSocieta(argomento)
      if (!codice) {
        const elenco = listaSocieta().map((s) => `/societa ${s.codice}`).join('  ·  ')
        await sendTelegramMessage(
          chatId,
          `⛔ Non ho capito quale societa. Non tiro a indovinare: usa uno di questi.\n${elenco}`,
        )
        return NextResponse.json({ ok: true })
      }

      const esito = await setSocietaAttiva(convId, codice)
      const s = getSocieta(codice)
      await sendTelegramMessage(
        chatId,
        esito.ok
          ? `✅ Societa attiva: *${s.denominazione}* (P.IVA ${s.piva}) — IVA di riferimento ${s.aliquotaIvaDefault}%.`
          : `⛔ Errore: ${esito.error}`,
      )
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


    // ─── Il codice CORTO si risolve qui, una volta, per tutti i rami ───
    //
    // Il codice nei comandi e' di 16 cifre e non di 32, perche' Telegram
    // riconosce come comando `/` + al massimo 32 caratteri e `/invia_` + 32
    // cifre ne fa 38. Sedici cifre non sono piu' l'identificativo: vanno
    // risolte contro il database. Si fa QUI, riscrivendo il testo nella forma
    // lunga, cosi' i 18 rami sotto continuano a funzionare senza saperne
    // niente — la 15-copie di `comandi-uuid.ts` non si rifa'.
    //
    // 🚨 Se 16 cifre corrispondono a piu' di una bozza non si sceglie la piu'
    // recente: si dichiara l'ambiguita' e si chiede il codice lungo.
    // Il gemello sta in `api/chat/route.ts`: equipollenza vincolante.
    let testoComandi = userText
    {
      const { espandiCodiceBreve } = await import('@/lib/comandi-risolvi')
      const esp = await espandiCodiceBreve(userText)
      if (esp.stato === 'fermo') return await rispondiESalva(esp.messaggio)
      if (esp.stato === 'espanso') testoComandi = esp.testo
    }

    // ─── /invia_<uuid> + /annulla_<uuid> — confirm flow mail subagent V19 ───
    const mInvia = comandoUuid(testoComandi, 'invia')
    if (mInvia) {
      const { confirmPendingSend } = await import('@/v19/tools/email/telegram-confirm')
      const r = await confirmPendingSend(mInvia)
      return await rispondiESalva(r.message)
    }
    const mAnnulla = comandoUuid(testoComandi, 'annulla')
    if (mAnnulla) {
      const { cancelPendingSend } = await import('@/v19/tools/email/telegram-confirm')
      const r = await cancelPendingSend(mAnnulla)
      return await rispondiESalva(r.message)
    }
    // ─── Conferma invio mail a LINGUAGGIO NATURALE: "invia pure mail" ───
    // Conferma l'ultimo pending non scaduto senza codice uuid. Match SOLO su
    // frasi-conferma brevi (NON su "invia una mail a Mario ..." = composizione).
    // La regola sta in src/lib/conferma-invio.ts, una volta sola: la stessa
    // regex e la stessa pre-normalizzazione della voce valgono anche sul web,
    // che dall 8 set 2026 ha la dettatura.
    {
      const { eConfermaInvio, eMessaggioBreveNonConferma } = await import('@/lib/conferma-invio')
      if (eConfermaInvio(userText)) {
        const { confirmLatestPendingSend } = await import('@/v19/tools/email/telegram-confirm')
        const r = await confirmLatestPendingSend()
        return await rispondiESalva(r.message)
      }
      // 🚨 IL SILENZIO. Se c'e' una bozza in attesa e arriva un messaggio breve
      // che NON e' una conferma, non si ricomincia in silenzio preparando
      // un'altra bozza: si dice che non si e' capito e si da' la frase esatta
      // che funziona. Parole sue: «non mi dice ne' che non lo ha fatto ne' che
      // problema ha, questa cosa non dovrebbe succedere».
      // Il gemello sta in `api/chat/route.ts`: equipollenza vincolante.
      if (eMessaggioBreveNonConferma(userText)) {
        const { avvisoConfermaNonRiconosciuta } = await import(
          '@/v19/tools/email/telegram-confirm'
        )
        const avviso = await avvisoConfermaNonRiconosciuta(userText)
        if (avviso) return await rispondiESalva(avviso)
      }
    }

    // ─── Un comando col CODICE TRONCATO va detto, non passato al modello ───
    // Toccando un codice vecchio (coi trattini) Telegram manda `/invia_d8f8ad16`:
    // non corrisponde a nessun ramo e finiva al modello come richiesta nuova.
    {
      const { comandoDalCodiceRotto } = await import('@/lib/comandi-uuid')
      const rotto = comandoDalCodiceRotto(testoComandi)
      if (rotto) {
        const { avvisoCodiceRotto } = await import('@/v19/tools/email/telegram-confirm')
        return await rispondiESalva(avvisoCodiceRotto(rotto))
      }
    }

    const mConferma = comandoUuid(testoComandi, 'conferma')
    const mIgnora = comandoUuid(testoComandi, 'ignora')
    if (mConferma || mIgnora) {
      const uuid = (mConferma ?? mIgnora)!
      const mod = await import('@/lib/doc-proposte-actions')
      const r = mConferma
        ? await mod.confirmProposta(uuid)
        : await mod.ignoraProposta(uuid)
      return await rispondiESalva(r.message)
    }

    // Governance accesso cartelle Drive — doppia conferma (parità con web)
    const mAccOk2 = comandoUuid(testoComandi, 'accesso_ok2')
    const mAccOk = comandoUuid(testoComandi, 'accesso_ok')
    const mAccNo = comandoUuid(testoComandi, 'accesso_no')
    if (mAccOk2 || mAccOk || mAccNo) {
      const uuid = (mAccOk2 ?? mAccOk ?? mAccNo)!
      const mod = await import('@/lib/drive-policy-actions')
      const r = mAccOk2
        ? await mod.confirmStep2(uuid)
        : mAccOk
          ? await mod.confirmStep1(uuid)
          : await mod.cancelPending(uuid)
      return await rispondiESalva(r.message)
    }

    // ── Regole che il bot propone su se stesso: le conferma l'Ingegnere ──
    // Il canale di apprendimento era chiuso dal 6 giugno (guardrail di provenienza
    // su prompt_extra): il bot proponeva, il sistema scartava, e gli rispondeva
    // "salvato". Ora la proposta e' una riga con uno stato, e solo un comando
    // digitato qui la porta dentro al prompt. Nessun testo letto da fuori ci arriva.
    if (userText.trim().toLowerCase() === '/regole') {
      const { formatRegoleList } = await import('@/lib/regole-proposte')
      return await rispondiESalva(await formatRegoleList())
    }
    // Doppia conferma, come per le cartelle Drive: /regola_ok_ mostra il testo
    // LETTO DAL DATABASE, /regola_ok2_ lo attiva. Cosi' cio' che l'Ingegnere
    // approva lo scrive la route, non il modello — che potrebbe parafrasarlo.
    // ok2 va testato PRIMA di ok, altrimenti il prefisso piu' corto lo mangia.
    const mRegOk2 = comandoUuid(testoComandi, 'regola_ok2')
    const mRegOk = comandoUuid(testoComandi, 'regola_ok')
    const mRegNo = comandoUuid(testoComandi, 'regola_no')
    const mRegVia = comandoUuid(testoComandi, 'regola_via')
    if (mRegOk2 || mRegOk || mRegNo || mRegVia) {
      const mod = await import('@/lib/regole-proposte')
      const r = mRegOk2
        ? await mod.confermaRegola(mRegOk2)
        : mRegOk
          ? await mod.anteprimaRegola(mRegOk)
          : mRegNo
            ? await mod.rifiutaRegola(mRegNo)
            : await mod.rimuoviRegola(mRegVia!)
      return await rispondiESalva(r.message)
    }

    // ── Privacy doc: conferma condivisione → firma e invia il link a scadenza ──
    const mShareOk = comandoUuid(testoComandi, 'condividi_ok')
    if (mShareOk) {
      const { confirmShareProposal } = await import('@/lib/share-proposte')
      const url = await confirmShareProposal(mShareOk)
      const msg = url
        ? `🔗 Link di condivisione (scade tra i giorni indicati):\n${url}\n\nChi ha il link vede il documento finché non scade.`
        : '⚠️ Proposta di condivisione non trovata, già usata o scaduta.'
      return await rispondiESalva(msg)
    }

    // ── /reset — sblocca manualmente il mutex se il bot è bloccato ──
    if (userText.trim().toLowerCase() === '/reset') {
      // Azione MANUALE esplicita: delete per-chat (NON scoped per request_id) di
      // proposito. Sblocca la chat anche se c'è un job vivo, interrompendone il
      // mutex (il job, se ancora attivo, perde il lock e non potrà più rilasciarlo).
      await safeSupabase(() => supabase.from('telegram_active_jobs').delete().eq('chat_id', chatId))
      // Audit 6 giu (P0-B): /reset deve sbloccare anche le run durable rimaste 'running'
      // (workflow morto senza catch) — altrimenti il guard anti-paralleli blocca la chat 30 min.
      try {
        await getSupabaseServer()
          .from('agent_workflow_runs')
          .update({ status: 'error', updated_at: new Date().toISOString() })
          .eq('chat_id', String(chatId))
          .eq('status', 'running')
      } catch (err: unknown) {
        console.error('[/reset] durable run cleanup failed (best-effort):', err instanceof Error ? err.message : String(err))
      }
      // Anche la coda: "puoi rimandare il messaggio" e poi riproporglielo
      // insieme all'"anzi lascia stare" arrivato dopo sarebbe peggio del blocco.
      const { svuotaCoda } = await import('@/lib/telegram-coda')
      await svuotaCoda(chatId)
      return await rispondiESalva('✅ Sbloccato. Puoi rimandare il messaggio.')
    }

    // ── Bug 1: mutex per chat ──
    // Evita bgProcess paralleli sulla stessa chat: se l'utente manda un messaggio
    // mentre il bot sta elaborando il precedente, droppiamo il nuovo per non
    // creare hallucination ("Trovato!" senza tool eseguito) e streaming sovrapposti.
    // Stale lock cleanup a 90s (heartbeat-based): task live aggiorna started_at ogni 20s.
    // Se Supabase down → fallback degradato (lockClaimed=true), lascia passare.
    // FIC bozze documenti - doppia conferma (parita con web)
    const mFicOk2 = comandoUuid(testoComandi, 'fic_ok2')
    const mFicOk = comandoUuid(testoComandi, 'fic_ok')
    const mFicNo = comandoUuid(testoComandi, 'fic_no')
    if (mFicOk2 || mFicOk || mFicNo) {
      const uuid = (mFicOk2 ?? mFicOk ?? mFicNo)!
      const message = mFicOk2
        ? await confirmFicStep2(uuid)
        : mFicOk
          ? await confirmFicStep1(uuid)
          : await cancelFic(uuid)
      return await rispondiESalva(message)
    }

    const mSalOk2 = comandoUuid(testoComandi, 'sal_ok2')
    const mSalOk = comandoUuid(testoComandi, 'sal_ok')
    const mSalNo = comandoUuid(testoComandi, 'sal_no')
    if (mSalOk2 || mSalOk || mSalNo) {
      const uuid = (mSalOk2 ?? mSalOk ?? mSalNo)!
      const message = mSalOk2
? await confirmSalStep2(uuid, await societaAttivaPerDocumenti(chatIdToUuid(chatId)))
        : mSalOk
          ? await confirmSalStep1(uuid)
          : await cancelSal(uuid)
      return await rispondiESalva(message)
    }

    // STALE_LOCK_MS = 150s con heartbeat 20s → buffer ~7 battiti. Su Fluid compute
    // i battiti persi possono falsamente marcare stale un lock ancora vivo; 150s
    // riduce il rischio di falso-stale mantenendo l'heartbeat a 20s.
    const STALE_LOCK_MS = 150 * 1000
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
      // Prima qui il messaggio veniva SCARTATO: nessuna coda, e il dedup era
      // gia' stato scritto sopra, quindi nemmeno Telegram poteva riconsegnarlo.
      // "Attenda un momento" suonava come un rinvio ed era un addio.
      // Si accoda il testo VERO dell'Ingegnere, non `userText`: quello a questo
      // punto puo' essere una frase fabbricata dal codice ("Analizza questo
      // file: ...", "la foto NON e' stata salvata..."), che riproposta al turno
      // dopo sarebbe un ordine su un allegato che non c'e' piu'.
      // I comandi non si accodano: il dispatch sta a monte del drenaggio,
      // quindi non verrebbero mai eseguiti — comparirebbero solo come testo.
      const accodabile = testoOriginale && !testoOriginale.startsWith('/')
      const { accodaMessaggio } = await import('@/lib/telegram-coda')
      const accodato = accodabile ? await accodaMessaggio(chatId, testoOriginale) : false
      await sendTelegramMessage(
        chatId,
        accodato
          // "appena ho finito" sarebbe falso: nessuno drena a fine turno, il
          // recupero avviene all'inizio del messaggio successivo. Meglio dirlo.
          ? '⏳ Sto ancora finendo il messaggio precedente. Il suo l\'ho messo da parte e lo leggo al suo prossimo messaggio — non serve riscriverlo tutto.'
          : '⏳ Sto ancora elaborando il messaggio precedente, attenda un momento.',
      )
      return NextResponse.json({ ok: true })
    }

    // Tenuti da parte: se il turno esce senza processarli vanno RIMESSI in coda,
    // altrimenti li avremmo marcati letti e poi buttati — peggio di prima.
    let arretratiDrenati: import('@/lib/telegram-coda').MessaggioInCoda[] = []

    // Ora che il lock e' nostro, recuperiamo cio' che era arrivato mentre il
    // turno precedente girava: viene anteposto al messaggio corrente, marcato
    // come "non ancora letto" perche' il modello non lo scambi per un
    // ripensamento. Best-effort: se la coda non risponde, il turno prosegue.
    try {
      const { drenaCoda, formatCoda } = await import('@/lib/telegram-coda')
      arretratiDrenati = await drenaCoda(chatId)
      if (arretratiDrenati.length > 0) {
        console.log(`[CODA] chat=${chatId} recuperati=${arretratiDrenati.length}`)
        userText = formatCoda(arretratiDrenati) + userText
        arretratiFuoriCoda = arretratiDrenati.map(a => ({ testo: a.testo, created_at: a.created_at }))
      }
    } catch (err) {
      console.error('[CODA] recupero fallito:', err instanceof Error ? err.message : err)
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
    const HISTORY_MAX_MESSAGES = 80
    const HISTORY_CHAR_BUDGET = 120_000
    const recentMessages = await safeSupabase(
      () => supabase.from('messages').select('role, content')
        .eq('conversation_id', conversationId)
        .order('created_at', { ascending: false }).limit(HISTORY_MAX_MESSAGES),
      []
    )
    if (Array.isArray(recentMessages)) {
      recentMessages.reverse()
    }

    const PER_MSG_CHAR_CAP = 12_000
    const history: Anthropic.MessageParam[] = ((recentMessages as any[]) || [])
      .filter(m => m.role === 'user' || m.role === 'assistant')
      .map(m => ({
        role: m.role,
        content: typeof m.content === 'string' && m.content.length > PER_MSG_CHAR_CAP
          ? m.content.slice(0, PER_MSG_CHAR_CAP) + ' […troncato]'
          : m.content,
      }))
    {
      const charsOf = (c: Anthropic.MessageParam['content']): number =>
        typeof c === 'string' ? c.length : JSON.stringify(c ?? '').length
      let total = history.reduce((s, m) => s + charsOf(m.content), 0)
      while (history.length > 8 && total > HISTORY_CHAR_BUDGET) {
        total -= charsOf(history[0].content)
        history.shift()
      }
    }

    const attachedRecentUploadIds: string[] = []

    // FIX multi-foto (Approccio 2): allega gli upload recenti NON ancora processati di questa chat
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
        if (row.telegram_file_id === currentUploadFileId) continue
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

    // Compressione stratificata: i documenti vecchi si accorciano, l'ultimo
    // no. La regola sta in src/lib/compressione-documenti.ts, una volta sola:
    // il server della chat web faceva l'opposto e disfaceva la cura del suo
    // stesso client.
    comprimiDocumentiNellaStoria(history as unknown as MessaggioStoria[])

    // ── Claude (ASINCRONO) — risponde subito, elabora in background ──
    const bgProcess = async () => {
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
            uploadedImages: turnImageRefs,
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
        // Quello che l'Ingegnere ha LETTO deve stare in storia, come sul web.
        // Qui esplode cio' che sta DOPO il loop — l'insert in `documents`, il
        // validatore, l'edit finale, il debrief — e il motore quelli non li
        // vede: senza questa riga, al turno dopo lui scrive "e allora rifallo"
        // e il modello non trova nessuna traccia di cosa sia andato storto.
        waitUntil(
          saveMessageOnly(conversationId, 'assistant', userMsg, new Date().toISOString())
            .then((ok) => { if (!ok) console.error('[telegram] errore post-turno NON salvato') }),
        )
      } finally {
        if (heartbeatInterval) { clearInterval(heartbeatInterval); heartbeatInterval = null }
        if (typingInterval) clearInterval(typingInterval)
        await safeSupabase(() =>
          supabase.from('telegram_active_jobs').delete().eq('chat_id', chatId).eq('request_id', requestId)
        )
      }
    }

    // ── Avviso rientro Opus → Sonnet ──
    try {
      const ou = await safeSupabase(
        () => supabase.from('cervellone_config').select('value').eq('key', 'opus_until').maybeSingle(),
        null,
      )
      const opusUntilVal = (ou as { value?: unknown } | null)?.value
      const opusUntil = opusUntilVal ? String(opusUntilVal).replace(/"/g, '') : undefined
      if (opusUntil && isOpusExpired(opusUntil, new Date())) {
        await sendTelegramMessage(
          chatId,
          "⏱️ L'ora di *Opus* è finita: torno su *Sonnet* (modello standard). Se il lavoro non è concluso e ti serve ancora la massima potenza, riattivalo con /opus.",
        )
        await safeSupabase(() => supabase.from('cervellone_config').delete().eq('key', 'opus_until'), null)
      }
    } catch { /* best-effort: l'avviso non deve mai bloccare il messaggio */ }

    // Il testo dell'Ingegnere PIU' gli arretrati, senza la cornice.
    // Escluderli era sbagliato: si finisce in coda proprio perche' il bot era su
    // una task lunga, quindi l'arretrato e' spesso a sua volta una task lunga —
    // un "prepara il preventivo Blasi" accodato non avrebbe mai preso il ramo
    // durable perche' si classificava solo l'"ok" corrente.
    // La cornice va tolta lo stesso: un pattern del classificatore e' ancorato
    // a `^` e un prefisso lo disinnescherebbe.
    const testoPerClassificatore = [
      ...arretratiDrenati.map(a => a.testo),
      testoOriginale,
    ].filter(Boolean).join('\n')
    if (await shouldUseDurable(testoPerClassificatore || userText, fileBlocks)) {
      const activeRun = await getActiveRunForChat(String(chatId))
      if (activeRun) {
        // Si esce senza processare niente: gli arretrati sono gia' marcati
        // letti, quindi vanno RESTITUITI con la loro eta' originale, insieme al
        // messaggio corrente. E' lo scenario tipico, non un caso limite:
        // durante una run durable il mutex e' libero, quindi il drenaggio
        // scatta sempre, e la finestra della run e' di mezz'ora.
        const { riaccodaMessaggi, accodaMessaggio } = await import('@/lib/telegram-coda')
        let persi = await riaccodaMessaggi(chatId, arretratiFuoriCoda)
        arretratiDrenati = []
        arretratiFuoriCoda = [] // restituiti: il catch esterno non deve rifarlo
        if (testoOriginale && !testoOriginale.startsWith('/')) {
          if (!await accodaMessaggio(chatId, testoOriginale)) persi += 1
        }

        // La promessa va detta solo se e' vera: qui prima si affermava sempre
        // di aver messo da parte, ignorando l'esito della scrittura.
        await sendTelegramMessage(chatId, persi === 0
          ? '⏳ Ho già una task lunga in corso per questa chat. Attenda che finisca (o usi /reset se è bloccata). Quello che mi ha scritto l\'ho messo da parte.'
          : '⏳ Ho già una task lunga in corso per questa chat. Attenda che finisca (o usi /reset se è bloccata). ⚠️ NON sono riuscito a mettere da parte quello che mi ha scritto: me lo rimandi dopo.')
        if (typingInterval) { clearInterval(typingInterval); typingInterval = null }
        await safeSupabase(() =>
          supabase.from('telegram_active_jobs').delete().eq('chat_id', chatId).eq('request_id', requestId)
        )
        return NextResponse.json({ ok: true })
      }
      const input: AgentJobInput = {
        chatId,
        userText,
        conversationId,
        history,
        fileBlocks,
        fileDescription,
        attachedRecentUploadIds,
        requestId,
        maxRunTokens: MAX_DURABLE_RUN_TOKENS,
      }
      const run = await start(runAgentTask, [input])
      // Il testo (arretrati inclusi) e' dentro `input`: da qui il lavoro e'
      // partito. Se `createRun` qui sotto fallisce, restituirli li duplicherebbe.
      arretratiFuoriCoda = []
      await createRun({
        id: run.runId,
        channel: 'telegram',
        chatId: String(chatId),
        conversationId,
      })

      if (typingInterval) { clearInterval(typingInterval); typingInterval = null }
      await safeSupabase(() =>
        supabase.from('telegram_active_jobs').delete().eq('chat_id', chatId).eq('request_id', requestId)
      )
    } else {
      // Da qui il testo (arretrati compresi) vive dentro il lavoro in corso:
      // il catch esterno non deve piu' restituirli, o li duplicherebbe.
      arretratiFuoriCoda = []
      waitUntil(bgProcess())
    }

    return NextResponse.json({ ok: true })
  } catch (err) {
    if (typingInterval) clearInterval(typingInterval)
    console.error('TELEGRAM error:', err)
    // Gli arretrati erano gia' marcati letti: se il turno muore qui, senza
    // restituirli sarebbero persi. Toppare un `return` alla volta non basta —
    // la perdita passa soprattutto da qui.
    if (errorChatId && arretratiFuoriCoda.length > 0) {
      try {
        const { riaccodaMessaggi } = await import('@/lib/telegram-coda')
        await riaccodaMessaggi(errorChatId, arretratiFuoriCoda)
      } catch (e) {
        console.error('[CODA] restituzione dopo errore fallita:', e instanceof Error ? e.message : e)
      }
    }
    if (errorChatId) {
      const msg = err instanceof Error ? err.message : String(err)
      await sendTelegramMessage(errorChatId, `⚠️ ${msg.slice(0, 300)}`).catch(() => {})
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
