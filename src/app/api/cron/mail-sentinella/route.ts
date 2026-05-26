import { NextRequest, NextResponse } from 'next/server'
import { supabase } from '@/lib/supabase'
import { sendTelegramMessage } from '@/lib/telegram-helpers'
import { estraiScadenzaDaAllegato } from '@/lib/scadenza-extract'
import { confirmProposta } from '@/lib/doc-proposte-actions'
import { ricorda } from '@/lib/memoria-tools'
import { readEmail, type ReadEmailMessage } from '@/v19/tools/email/read-email'
import { getEmailBody } from '@/v19/tools/email/get-email-body'
import type { AccountKey } from '@/v19/tools/email/config'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

type AttachmentWithContent = {
  filename: string | null
  contentType: string
  size: number
  contentBase64?: string
}

type ProposalResult = {
  id: string
  account: AccountKey
  uid: number
  attachment_filename: string
  tipo_documento: string | null
  soggetto: string | null
  data_scadenza: string
  notified: boolean
}

type NotificationProposal = Pick<
  ProposalResult,
  'id' | 'attachment_filename' | 'tipo_documento' | 'soggetto' | 'data_scadenza'
>

type PendingProposal = NotificationProposal & {
  attempts: number | null
}

const ACCOUNTS: AccountKey[] = ['info', 'raffaele']
const FOLDER = 'INBOX'
const LOOKBACK_DAYS = 3
const READ_LIMIT = 50
const MAX_EXTRACTIONS = 5
const MIN_CONFIDENCE = 0.5
const ONE_DAY_MS = 24 * 60 * 60 * 1000
const KEYWORDS = [
  'idoneita',
  'attestato',
  'formazione',
  'visita medica',
  'sorveglianza sanitaria',
  'corso',
  'certificat',
  'abilitazione',
]

function sinceISO(days: number): string {
  const date = new Date()
  date.setDate(date.getDate() - days)
  return date.toISOString().slice(0, 10)
}

function normalizeForMatch(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
}

function hasKeyword(value: string | null | undefined): boolean {
  if (!value) return false
  const normalized = normalizeForMatch(value)
  return KEYWORDS.some((keyword) => normalized.includes(keyword))
}

function attachmentName(attachment: AttachmentWithContent, index: number): string {
  const name = attachment.filename?.trim()
  return name || `allegato-${index + 1}`
}

function getAdminChatId(): number {
  let adminChat = parseInt(process.env.ADMIN_CHAT_ID || '0', 10)
  if (!adminChat) {
    const firstAllowed = (process.env.TELEGRAM_ALLOWED_IDS || '').split(',')[0]?.trim()
    adminChat = parseInt(firstAllowed || '0', 10)
  }
  return adminChat
}

function buildNotification(result: NotificationProposal): string {
  const tipo = result.tipo_documento || 'documento'
  const soggetto = result.soggetto || 'soggetto non riconosciuto'
  return [
    `Documento personale rilevato: ${tipo} di ${soggetto}, scade ${result.data_scadenza}.`,
    `Allegato: ${result.attachment_filename}`,
    `Per archiviare e registrare: \`/conferma_${result.id}\``,
    `Per ignorare: \`/ignora_${result.id}\``,
  ].join('\n')
}

async function proposalExists(account: AccountKey, uid: number, attachmentFilename: string): Promise<boolean> {
  const { data, error } = await supabase
    .from('cervellone_doc_proposte')
    .select('id')
    .eq('account', account)
    .eq('uid', uid)
    .eq('attachment_filename', attachmentFilename)
    .maybeSingle()

  if (error) throw new Error(`Errore dedup proposta ${account}/${uid}/${attachmentFilename}: ${error.message}`)
  return Boolean(data)
}

async function insertProposal(
  account: AccountKey,
  message: ReadEmailMessage,
  attachmentFilename: string,
  extracted: {
    tipo_documento: string | null
    soggetto: string | null
    data_scadenza: string
    emittente: string | null
    confidenza: number
  },
): Promise<ProposalResult | null> {
  const now = new Date().toISOString()
  const { data, error } = await supabase
    .from('cervellone_doc_proposte')
    .insert({
      account,
      uid: message.uid,
      folder: FOLDER,
      message_subject: message.subject,
      attachment_filename: attachmentFilename,
      drive_url: null,
      tipo_documento: extracted.tipo_documento,
      soggetto: extracted.soggetto,
      data_scadenza: extracted.data_scadenza,
      emittente: extracted.emittente,
      confidenza: extracted.confidenza,
      stato: 'in_attesa',
      attempts: 1,
      last_notified_at: now,
      updated_at: now,
    })
    .select('id')
    .single()

  if (error) {
    if (error.code === '23505') return null
    throw new Error(`Errore insert proposta ${account}/${message.uid}/${attachmentFilename}: ${error.message}`)
  }

  const id = (data as { id?: string } | null)?.id
  if (!id) throw new Error(`Insert proposta senza id ${account}/${message.uid}/${attachmentFilename}`)

  return {
    id,
    account,
    uid: message.uid,
    attachment_filename: attachmentFilename,
    tipo_documento: extracted.tipo_documento,
    soggetto: extracted.soggetto,
    data_scadenza: extracted.data_scadenza,
    notified: false,
  }
}

async function notifyProposal(result: ProposalResult, adminChat: number): Promise<ProposalResult> {
  if (!adminChat) return result
  await sendTelegramMessage(adminChat, buildNotification(result))
  return { ...result, notified: true }
}

function olderThan24h(): string {
  return new Date(Date.now() - ONE_DAY_MS).toISOString()
}

function autoMemoryText(proposal: NotificationProposal): string {
  const tipo = proposal.tipo_documento || 'documento'
  const soggetto = proposal.soggetto || 'soggetto non riconosciuto'
  return `AUTO-MEMORIZZATO (3 solleciti senza risposta): ${tipo} di ${soggetto}, scade ${proposal.data_scadenza}. Allegato ${proposal.attachment_filename}.`
}

async function updateReminderAttempt(proposal: PendingProposal): Promise<void> {
  const now = new Date().toISOString()
  const { error } = await supabase
    .from('cervellone_doc_proposte')
    .update({
      attempts: (proposal.attempts ?? 0) + 1,
      last_notified_at: now,
      updated_at: now,
    })
    .eq('id', proposal.id)
    .eq('stato', 'in_attesa')

  if (error) throw new Error(`Errore update sollecito proposta ${proposal.id}: ${error.message}`)
}

async function remindPendingProposals(adminChat: number, errors: string[]): Promise<number> {
  const { data, error } = await supabase
    .from('cervellone_doc_proposte')
    .select('id, attachment_filename, tipo_documento, soggetto, data_scadenza, attempts')
    .eq('stato', 'in_attesa')
    .lt('attempts', 3)
    .lt('last_notified_at', olderThan24h())
    .order('last_notified_at', { ascending: true })
    .limit(20)

  if (error) throw new Error(`Errore query proposte da risollecitare: ${error.message}`)

  let riproposte = 0
  for (const proposal of (data ?? []) as PendingProposal[]) {
    try {
      await updateReminderAttempt(proposal)
      riproposte += 1
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err))
      continue
    }
    if (adminChat) {
      await sendTelegramMessage(adminChat, buildNotification(proposal)).catch((err) => {
        console.error('[CRON mail-sentinella] reminder telegram failed:', err)
      })
    }
  }
  return riproposte
}

async function autoMemorizePendingProposals(adminChat: number, errors: string[]): Promise<number> {
  const { data, error } = await supabase
    .from('cervellone_doc_proposte')
    .select('id, attachment_filename, tipo_documento, soggetto, data_scadenza, attempts')
    .eq('stato', 'in_attesa')
    .gte('attempts', 3)
    .lt('last_notified_at', olderThan24h())
    .order('last_notified_at', { ascending: true })
    .limit(20)

  if (error) throw new Error(`Errore query proposte da auto-memorizzare: ${error.message}`)

  let autoMemorizzate = 0
  for (const proposal of (data ?? []) as PendingProposal[]) {
    const confirmed = await confirmProposta(proposal.id)
    if (!confirmed.ok) {
      errors.push(`Auto-memoria proposta ${proposal.id}: ${confirmed.message}`)
      continue
    }

    const memory = await ricorda({
      testo: autoMemoryText(proposal),
      tag: 'scadenza:auto',
      source: 'cron',
    })
    if (!memory.ok) {
      errors.push(`Errore memoria proposta ${proposal.id}: ${memory.error ?? 'errore sconosciuto'}`)
      console.error(`[CRON mail-sentinella] auto-memory ricorda failed for ${proposal.id}:`, memory.error)
      continue
    }

    const { data: updatedRows, error: updateError } = await supabase
      .from('cervellone_doc_proposte')
      .update({ stato: 'auto_memorizzata', updated_at: new Date().toISOString() })
      .eq('id', proposal.id)
      .eq('stato', 'confermata')
      .select('id')
    if (updateError) {
      errors.push(`Errore stato auto_memorizzata proposta ${proposal.id}: ${updateError.message}`)
      continue
    }
    if (!updatedRows || updatedRows.length === 0) {
      errors.push(`Auto-memoria proposta ${proposal.id}: stato non aggiornato, probabilmente gia gestita da un altro canale.`)
      console.warn(`[CRON mail-sentinella] auto-memory state update affected 0 rows for ${proposal.id}`)
      continue
    }

    if (adminChat) {
      const tipo = proposal.tipo_documento || 'documento'
      const soggetto = proposal.soggetto || 'soggetto non riconosciuto'
      await sendTelegramMessage(
        adminChat,
        `Nessuna risposta dopo 3 solleciti: ho archiviato e registrato comunque ${tipo} di ${soggetto} (scade ${proposal.data_scadenza}).`,
      ).catch((err) => {
        console.error('[CRON mail-sentinella] auto-memory telegram failed:', err)
      })
    }

    autoMemorizzate += 1
  }
  return autoMemorizzate
}

export async function GET(req: NextRequest) {
  const auth = req.headers.get('authorization')
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 })
  }

  const adminChat = getAdminChatId()
  const errors: string[] = []
  const nuoveProposte: ProposalResult[] = []
  let checked = 0
  let extractionCount = 0

  for (const account of ACCOUNTS) {
    if (extractionCount >= MAX_EXTRACTIONS) break

    try {
      const inbox = await readEmail({
        account,
        folder: FOLDER,
        since: sinceISO(LOOKBACK_DAYS),
        limit: READ_LIMIT,
      })

      for (const message of inbox.messages) {
        checked += 1
        if (!message.has_attachments) continue
        if (extractionCount >= MAX_EXTRACTIONS) break

        // Match su subject/mittente; se non matcha, l'allegato può comunque essere candidato
        // se il NOME FILE contiene una keyword (es. "idoneita_rossi.pdf" con subject generico).
        const metadataMatches = hasKeyword(message.subject) || hasKeyword(message.from)

        const mail = await getEmailBody({ account, uid: message.uid, folder: FOLDER, include_attachments: true })
        const attachments = (mail.attachments ?? []) as AttachmentWithContent[]
        const candidateAttachments = attachments
          .map((attachment, index) => ({ attachment, filename: attachmentName(attachment, index) }))
          .filter(({ filename }) => metadataMatches || hasKeyword(filename))

        for (const { attachment, filename } of candidateAttachments) {
          if (extractionCount >= MAX_EXTRACTIONS) break
          if (await proposalExists(account, message.uid, filename)) continue
          if (!attachment.contentBase64) continue
          if (attachment.size && attachment.size > 2 * 1024 * 1024) continue // cost: salta allegati >2MB

          extractionCount += 1
          const extracted = await estraiScadenzaDaAllegato(
            attachment.contentBase64,
            attachment.contentType,
            filename,
          )
          if (!extracted.ok) continue
          const data = extracted.data
          if (!data.data_scadenza || data.confidenza < MIN_CONFIDENCE) continue

          const proposal = await insertProposal(account, message, filename, {
            tipo_documento: data.tipo_documento,
            soggetto: data.soggetto,
            data_scadenza: data.data_scadenza,
            emittente: data.emittente,
            confidenza: data.confidenza,
          })
          if (!proposal) continue

          try {
            nuoveProposte.push(await notifyProposal(proposal, adminChat))
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err)
            errors.push(`Telegram proposta ${proposal.id}: ${message}`)
            nuoveProposte.push(proposal)
          }
        }
      }
    } catch (err) {
      errors.push(`${account}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  let riproposte = 0
  let autoMemorizzate = 0
  try {
    riproposte = await remindPendingProposals(adminChat, errors)
    autoMemorizzate = await autoMemorizePendingProposals(adminChat, errors)
  } catch (err) {
    errors.push(err instanceof Error ? err.message : String(err))
  }

  const body = {
    ok: errors.length === 0,
    checked,
    nuove_proposte: nuoveProposte.length,
    estrazioni: extractionCount,
    riproposte,
    auto_memorizzate: autoMemorizzate,
    details: nuoveProposte,
    errors,
  }
  return NextResponse.json(body, { status: errors.length === 0 ? 200 : 500 })
}
