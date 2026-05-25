import { supabase } from '@/lib/supabase'
import { getEmailBody } from '@/v19/tools/email/get-email-body'
import type { AccountKey } from '@/v19/tools/email/config'
import { DRIVE_FOLDERS, getOrCreatePathFolders, uploadBinaryToDrive } from '@/lib/drive'

type ActionResult = { ok: boolean; message: string }

type ProposalRow = {
  id: string
  account: string
  uid: number | string
  folder: string | null
  attachment_filename: string
  drive_url: string | null
  tipo_documento: string | null
  soggetto: string | null
  data_scadenza: string | null
  stato: string
}

type AttachmentWithContent = {
  filename: string | null
  contentType: string
  size: number
  contentBase64?: string
}

function parseAccount(value: string): AccountKey | null {
  return value === 'info' || value === 'raffaele' ? value : null
}

function sanitizeSegment(value: string | null | undefined, fallback: string): string {
  const cleaned = (value ?? '')
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return cleaned || fallback
}

function attachmentName(attachment: AttachmentWithContent, index: number): string {
  const name = attachment.filename?.trim()
  return name || `allegato-${index + 1}`
}

function statusMessage(stato: string, driveUrl: string | null): ActionResult {
  if (stato === 'confermata') {
    return { ok: true, message: driveUrl ? `Proposta gia confermata: ${driveUrl}` : 'Proposta gia confermata.' }
  }
  if (stato === 'ignorata') return { ok: true, message: 'Proposta gia ignorata.' }
  return { ok: false, message: `Proposta non gestibile: stato attuale "${stato}".` }
}

async function loadProposal(id: string): Promise<ProposalRow | null> {
  const { data, error } = await supabase
    .from('cervellone_doc_proposte')
    .select('id, account, uid, folder, attachment_filename, drive_url, tipo_documento, soggetto, data_scadenza, stato')
    .eq('id', id)
    .maybeSingle()

  if (error) throw new Error(`Errore lettura proposta: ${error.message}`)
  return data as ProposalRow | null
}

async function rememberDriveUrl(id: string, driveUrl: string): Promise<void> {
  const { error } = await supabase
    .from('cervellone_doc_proposte')
    .update({ drive_url: driveUrl, updated_at: new Date().toISOString() })
    .eq('id', id)
  if (error) throw new Error(`Errore aggiornamento link Drive proposta: ${error.message}`)
}

async function ensureScadenza(proposta: ProposalRow, categoria: string, driveUrl: string): Promise<void> {
  const soggetto = proposta.soggetto || 'Vari'
  const tipoDocumento = proposta.tipo_documento || 'documento'
  const dataScadenza = proposta.data_scadenza
  if (!dataScadenza) throw new Error('La proposta non contiene una data_scadenza valida.')

  let existingQuery = supabase
    .from('cervellone_scadenze')
    .select('id')
    .eq('soggetto', soggetto)
    .eq('data_scadenza', dataScadenza)
    .eq('drive_url', driveUrl)
    .limit(1)

  existingQuery = tipoDocumento
    ? existingQuery.eq('tipo_documento', tipoDocumento)
    : existingQuery.is('tipo_documento', null)

  const { data: existing, error: existingError } = await existingQuery
  if (existingError) throw new Error(`Errore verifica scadenza esistente: ${existingError.message}`)
  if ((existing ?? []).length > 0) return

  const { error } = await supabase
    .from('cervellone_scadenze')
    .insert({
      soggetto,
      categoria,
      tipo_documento: tipoDocumento,
      data_scadenza: dataScadenza,
      drive_url: driveUrl,
      stato: 'attivo',
    })

  if (error) throw new Error(`Errore registrazione scadenza: ${error.message}`)
}

export async function confirmProposta(id: string): Promise<ActionResult> {
  try {
    const proposta = await loadProposal(id)
    if (!proposta) return { ok: false, message: 'Proposta non trovata.' }
    if (proposta.stato !== 'in_attesa') return statusMessage(proposta.stato, proposta.drive_url)

    const account = parseAccount(proposta.account)
    if (!account) return { ok: false, message: `Account proposta non valido: ${proposta.account}` }
    if (!proposta.data_scadenza) return { ok: false, message: 'La proposta non contiene una data di scadenza.' }

    const folder = proposta.folder || 'INBOX'
    const mail = await getEmailBody({
      account,
      uid: Number(proposta.uid),
      folder,
      include_attachments: true,
    })
    const attachments = (mail.attachments ?? []) as AttachmentWithContent[]
    const match = attachments
      .map((attachment, index) => ({ attachment, filename: attachmentName(attachment, index) }))
      .find(({ attachment, filename }) => filename === proposta.attachment_filename || attachment.filename === proposta.attachment_filename)

    if (!match) return { ok: false, message: `Allegato "${proposta.attachment_filename}" non trovato nella mail.` }
    if (!match.attachment.contentBase64) return { ok: false, message: `Allegato "${match.filename}" senza contenuto scaricabile.` }

    const categoria = sanitizeSegment('Documenti', 'Documenti')
    const soggettoSegment = sanitizeSegment(proposta.soggetto, 'Vari')
    const pathSegments = [categoria, soggettoSegment]
    let driveUrl = proposta.drive_url

    if (!driveUrl) {
      const targetFolderId = await getOrCreatePathFolders(DRIVE_FOLDERS.DOC_IMPRESA, pathSegments)
      const uploaded = await uploadBinaryToDrive(
        Buffer.from(match.attachment.contentBase64, 'base64'),
        sanitizeSegment(match.filename, 'allegato'),
        match.attachment.contentType,
        targetFolderId,
      )
      driveUrl = uploaded.webViewLink
      await rememberDriveUrl(proposta.id, driveUrl)
    }

    await ensureScadenza(proposta, categoria, driveUrl)

    const { error: updateError } = await supabase
      .from('cervellone_doc_proposte')
      .update({ stato: 'confermata', drive_url: driveUrl, updated_at: new Date().toISOString() })
      .eq('id', proposta.id)
      .eq('stato', 'in_attesa')

    if (updateError) throw new Error(`Errore conferma proposta: ${updateError.message}`)

    return {
      ok: true,
      message: `Archiviato in ${pathSegments.join('/')} e scadenza ${proposta.data_scadenza} registrata.`,
    }
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) }
  }
}

export async function ignoraProposta(id: string): Promise<ActionResult> {
  try {
    const proposta = await loadProposal(id)
    if (!proposta) return { ok: false, message: 'Proposta non trovata.' }
    if (proposta.stato !== 'in_attesa') return statusMessage(proposta.stato, proposta.drive_url)

    const { error } = await supabase
      .from('cervellone_doc_proposte')
      .update({ stato: 'ignorata', updated_at: new Date().toISOString() })
      .eq('id', proposta.id)
      .eq('stato', 'in_attesa')

    if (error) throw new Error(`Errore aggiornamento proposta: ${error.message}`)
    return { ok: true, message: 'Proposta ignorata.' }
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) }
  }
}
