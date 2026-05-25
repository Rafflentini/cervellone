import { NextRequest, NextResponse } from 'next/server'
import { supabase } from '@/lib/supabase'
import { estraiScadenzaDaAllegato } from '@/lib/scadenza-extract'
import { sendTelegramMessage } from '@/lib/telegram-helpers'
import { getEmailBody } from '@/v19/tools/email/get-email-body'
import { readEmail } from '@/v19/tools/email/read-email'
import type { AccountKey } from '@/v19/tools/email/config'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

const ACCOUNTS: AccountKey[] = ['info', 'raffaele']
const FOLDER = 'INBOX'
const MAX_EXTRACTIONS = 10
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

type AttachmentWithContent = {
  filename: string | null
  contentType: string
  size: number
  contentBase64?: string
}

function recentSince(): string {
  return new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
}

function normalizeText(value: string | null | undefined): string {
  return (value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
}

function hasDocumentKeyword(...values: Array<string | null | undefined>): boolean {
  const haystack = values.map(normalizeText).join(' ')
  return KEYWORDS.some((keyword) => haystack.includes(keyword))
}

function getAdminChatId(): number {
  const adminChat = parseInt(process.env.ADMIN_CHAT_ID || '0', 10)
  if (adminChat) return adminChat
  const firstAllowed = (process.env.TELEGRAM_ALLOWED_IDS || '').split(',')[0]?.trim()
  return parseInt(firstAllowed || '0', 10)
}

async function proposalExists(account: AccountKey, uid: number, attachmentFilename: string): Promise<boolean> {
  const { data, error } = await supabase
    .from('cervellone_doc_proposte')
    .select('id')
    .eq('account', account)
    .eq('uid', uid)
    .eq('attachment_filename', attachmentFilename)
    .maybeSingle()

  if (error) throw error
  return Boolean(data)
}

export async function GET(req: NextRequest) {
  const auth = req.headers.get('authorization')
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 })
  }

  let checked = 0
  let nuoveProposte = 0
  let extractions = 0
  const adminChatId = getAdminChatId()
  const since = recentSince()

  try {
    for (const account of ACCOUNTS) {
      const { messages } = await readEmail({ account, folder: FOLDER, since, limit: 50 })
      for (const message of messages) {
        checked += 1
        if (!message.has_attachments || extractions >= MAX_EXTRACTIONS) continue

        const subjectMatches = hasDocumentKeyword(message.subject)
        const mail = await getEmailBody({ account, uid: message.uid, folder: FOLDER, include_attachments: true })
        const attachments = mail.attachments as AttachmentWithContent[]
        const candidateAttachments = attachments
          .map((attachment, index) => ({
            ...attachment,
            filename: attachment.filename || `allegato-${index + 1}`,
          }))
          .filter((attachment) => subjectMatches || hasDocumentKeyword(attachment.filename))

        for (const attachment of candidateAttachments) {
          if (extractions >= MAX_EXTRACTIONS) break
          if (!attachment.contentBase64) continue
          if (await proposalExists(account, message.uid, attachment.filename)) continue

          extractions += 1
          const extracted = await estraiScadenzaDaAllegato(
            attachment.contentBase64,
            attachment.contentType,
            attachment.filename,
          )
          if (!extracted.ok || !extracted.data.data_scadenza || extracted.data.confidenza < 0.5) continue

          const now = new Date().toISOString()
          const { error } = await supabase.from('cervellone_doc_proposte').insert({
            account,
            uid: message.uid,
            folder: FOLDER,
            message_subject: message.subject,
            attachment_filename: attachment.filename,
            drive_url: null,
            tipo_documento: extracted.data.tipo_documento,
            soggetto: extracted.data.soggetto,
            data_scadenza: extracted.data.data_scadenza,
            emittente: extracted.data.emittente,
            confidenza: extracted.data.confidenza,
            stato: 'in_attesa',
            attempts: 1,
            last_notified_at: now,
            created_at: now,
            updated_at: now,
          })

          if (error) {
            if (error.code === '23505') continue
            throw error
          }

          nuoveProposte += 1
          if (adminChatId) {
            const tipo = extracted.data.tipo_documento || 'documento'
            const soggetto = extracted.data.soggetto || 'soggetto non identificato'
            const text = `Documento personale rilevato: ${tipo} di ${soggetto}, scade ${extracted.data.data_scadenza}. Vuoi che lo archivi e aggiunga allo scadenzario? (gestione conferma in arrivo)`
            await sendTelegramMessage(adminChatId, text).catch((err) =>
              console.error('[CRON mail-sentinella] telegram send failed:', err),
            )
          }
        }
      }
    }

    return NextResponse.json({ ok: true, checked, nuove_proposte: nuoveProposte })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[CRON mail-sentinella] failed:', err)
    return NextResponse.json({ ok: false, error: message, checked, nuove_proposte: nuoveProposte }, { status: 500 })
  }
}
