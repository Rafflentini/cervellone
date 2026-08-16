import { supabase } from '@/lib/supabase'
import { getEmailBody } from '@/v19/tools/email/get-email-body'
import type { AccountKey } from '@/v19/tools/email/config'
import { DRIVE_FOLDERS, getOrCreatePathFolders, uploadBinaryToDrive } from '@/lib/drive'
import { registraScadenzaCore } from '@/lib/scadenze-tools'

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
  if (stato === 'auto_memorizzata') return { ok: true, message: 'Proposta gia auto-memorizzata dal sistema.' }
  if (stato === 'in_lavorazione') return { ok: false, message: 'Proposta in elaborazione, riprova tra poco.' }
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

/**
 * Registra la scadenza della proposta confermata.
 *
 * 2026-08: NON scrive piu su cervellone_scadenze per conto suo. Prima era il
 * SECONDO scrittore della tabella e faceva un INSERT diretto: niente evento in
 * agenda, niente sostituzione della scadenza precedente, niente validazione
 * della data, niente strip dei NUL byte. Il suo dedup era `.eq` case-sensitive
 * su soggetto+data+drive_url+tipo_documento, cioe lo stesso bug corretto in
 * registra_scadenza — e questo e il flusso AUTOMATICO (mail-sentinella →
 * proposta → /conferma), quello che gira senza che l'Ingegnere digiti nulla.
 *
 * Ora delega a `registraScadenzaCore`, che e la stessa identica logica del
 * path manuale. Nessun dedup locale: se la stessa proposta viene confermata due
 * volte, la sostituzione per chiave (soggetto + tipo_documento + categoria)
 * chiude la riga precedente invece di lasciarne due attive.
 *
 * Ritorna la nota Calendar quando l'evento NON e stato creato, cosi il
 * messaggio di conferma non promette un'agenda che non e stata aggiornata.
 */
async function ensureScadenza(proposta: ProposalRow, categoria: string, driveUrl: string): Promise<string | null> {
  const dataScadenza = proposta.data_scadenza
  if (!dataScadenza) throw new Error('La proposta non contiene una data_scadenza valida.')

  const esito = await registraScadenzaCore({
    soggetto: proposta.soggetto || 'Vari',
    categoria,
    tipo_documento: proposta.tipo_documento || 'documento',
    data_scadenza: dataScadenza,
    drive_url: driveUrl,
  })

  if (!esito.ok) throw new Error(`Errore registrazione scadenza: ${esito.error ?? 'causa sconosciuta'}`)
  // La sostituzione fallita non invalida la scadenza (e gia in DB), ma va detta.
  if (esito.avviso) return esito.avviso
  return esito.calendarOk ? null : esito.calendarNota
}

export async function confirmProposta(id: string): Promise<ActionResult> {
  try {
    const proposta = await loadProposal(id)
    if (!proposta) return { ok: false, message: 'Proposta non trovata.' }
    if (proposta.stato !== 'in_attesa') return statusMessage(proposta.stato, proposta.drive_url)

    const { data: claimedRows, error: claimError } = await supabase
      .from('cervellone_doc_proposte')
      .update({ stato: 'in_lavorazione', updated_at: new Date().toISOString() })
      .eq('id', proposta.id)
      .eq('stato', 'in_attesa')
      .select('id')
    if (claimError) throw new Error(`Errore claim proposta: ${claimError.message}`)
    if (!claimedRows || claimedRows.length === 0) {
      return { ok: false, message: 'Proposta gia in elaborazione o elaborata.' }
    }

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

    const scadenzaAvviso = await ensureScadenza(proposta, categoria, driveUrl)

    const { data: updatedRows, error: updateError } = await supabase
      .from('cervellone_doc_proposte')
      .update({ stato: 'confermata', drive_url: driveUrl, updated_at: new Date().toISOString() })
      .eq('id', proposta.id)
      .eq('stato', 'in_lavorazione')
      .select('id')

    if (updateError) throw new Error(`Errore conferma proposta: ${updateError.message}`)
    if (!updatedRows || updatedRows.length === 0) {
      return { ok: false, message: 'Proposta gia elaborata da un altro canale.' }
    }

    const base = `Archiviato in ${pathSegments.join('/')} e scadenza ${proposta.data_scadenza} registrata.`
    return {
      ok: true,
      message: scadenzaAvviso ? `${base} ⚠️ ${scadenzaAvviso}` : base,
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

    const { data: updatedRows, error } = await supabase
      .from('cervellone_doc_proposte')
      .update({ stato: 'ignorata', updated_at: new Date().toISOString() })
      .eq('id', proposta.id)
      .eq('stato', 'in_attesa')
      .select('id')

    if (error) throw new Error(`Errore aggiornamento proposta: ${error.message}`)
    if (!updatedRows || updatedRows.length === 0) {
      return { ok: false, message: 'Proposta gia elaborata da un altro canale.' }
    }
    return { ok: true, message: 'Proposta ignorata.' }
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) }
  }
}
