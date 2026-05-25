import { NextRequest, NextResponse } from 'next/server'
import { supabase } from '@/lib/supabase'
import { sendTelegramMessage } from '@/lib/telegram-helpers'
import { estraiScadenzaDaAllegato } from '@/lib/scadenza-extract'
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
  id?: string
  account: AccountKey
  uid: number
  attachment_filename: string
  tipo_documento: string | null
  soggetto: string | null
  data_scadenza: string
  notified: boolean
}

const ACCOUNTS: AccountKey[] = ['info', 'raffaele']
const FOLDER = 'INBOX'
const LOOKBACK_DAYS = 3
const READ_LIMIT = 50
const MAX_EXTRACTIONS = 10
const MIN_CONFIDENCE = 0.5
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

function buildNotification(result: ProposalResult): string {
  const tipo = result.tipo_documento || 'documento'
  const soggetto = result.soggetto || 'soggetto non riconosciuto'
  return [
    `Documento personale rilevato: ${tipo} di ${soggetto}, scade ${result.data_scadenza}.`,
    `Allegato: ${result.attachment_filename}`,
    'Vuoi che lo archivi e aggiunga allo scadenzario? (gestione conferma in arrivo)',
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

  return {
    id: (data as { id?: string } | null)?.id,
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

        const subjectMatches = hasKeyword(message.subject)
        const mail = await getEmailBody({ account, uid: message.uid, folder: FOLDER, include_attachments: true })
        const attachments = (mail.attachments ?? []) as AttachmentWithContent[]
        const candidateAttachments = attachments
          .map((attachment, index) => ({ attachment, filename: attachmentName(attachment, index) }))
          .filter(({ filename }) => subjectMatches || hasKeyword(filename))

        for (const { attachment, filename } of candidateAttachments) {
          if (extractionCount >= MAX_EXTRACTIONS) break
          if (await proposalExists(account, message.uid, filename)) continue
          if (!attachment.contentBase64) continue

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
            errors.push(`Telegram proposta ${proposal.id ?? filename}: ${message}`)
            nuoveProposte.push(proposal)
          }
        }
      }
    } catch (err) {
      errors.push(`${account}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  const body = {
    ok: errors.length === 0,
    checked,
    nuove_proposte: nuoveProposte.length,
    estrazioni: extractionCount,
    details: nuoveProposte,
    errors,
  }
  return NextResponse.json(body, { status: errors.length === 0 ? 200 : 500 })
}
