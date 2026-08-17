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

/**
 * Tipi documento che per NATURA esistono in una sola copia valida per soggetto:
 * ne arriva uno nuovo solo quando il precedente e scaduto o sta per scadere,
 * quindi (soggetto + tipo) identifica UN documento e il nuovo sostituisce
 * davvero il vecchio.
 *
 * E' una ALLOWLIST, non una denylist, e la direzione conta: un tipo che manca
 * da questa lista non viene sostituito, quindi restano due righe attive — due
 * promemoria dal cron, visibili, chiudibili con chiudi_scadenza. Un tipo di
 * troppo, al contrario, cancellerebbe in silenzio la scadenza di un altro
 * documento. Il costo di una dimenticanza e quindi rumore, mai perdita di dati:
 * aggiungere una voce e sicuro, toglierne una no.
 *
 * Restano deliberatamente FUORI i tipi di cui un soggetto puo detenere piu
 * documenti diversi contemporaneamente, che sono esattamente quelli su cui il
 * flusso automatico cancellava: "attestato formazione" (antincendio, ponteggi,
 * primo soccorso, preposto...), "polizza" (RCT, RCO, infortuni), "certificato",
 * "contratto".
 */
const TIPI_UNICI_PER_SOGGETTO = [
  'durc',
  'visura',
  'visura camerale',
  'revisione',
  'bollo',
  'idoneita alla mansione',
  'idoneita sanitaria',
  'visita medica',
]

/** Fallback usati quando l'estrattore non ha riconosciuto il campo. */
const SOGGETTO_FALLBACK = 'Vari'
const TIPO_FALLBACK = 'documento'

/** lower + accenti rimossi + separatori collassati: "Idoneità alla mansione" → "idoneita alla mansione". */
function normalizzaTipo(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase('it-IT')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

function tipoUnicoPerSoggetto(tipo: string): boolean {
  const normalizzato = normalizzaTipo(tipo)
  if (!normalizzato) return false
  return TIPI_UNICI_PER_SOGGETTO.some(voce => normalizzato === voce || normalizzato.startsWith(`${voce} `))
}

/**
 * La chiave di sostituzione (soggetto + tipo_documento + categoria) identifica
 * UN SOLO documento di questa proposta?
 *
 * Serve perche in questo path la `categoria` e la costante 'Documenti' (non c'e
 * nessun LLM che la scelga, e la cartella Drive di destinazione e sempre
 * quella): la chiave a tre componenti si riduce di fatto a due, e la terza —
 * quella che nel path manuale distingue l'attestato antincendio di Mario Rossi
 * dal suo attestato ponteggi — non discrimina nulla. Con `soggetto` e
 * `tipo_documento` a loro volta caduti sui fallback, la chiave diventa la
 * costante ('Vari', 'documento', 'Documenti') e due documenti qualunque si
 * annullano a vicenda.
 *
 * Chiediamo quindi tre prove positive, tutte e tre necessarie:
 *  1. l'estrattore ha letto un soggetto vero (non il fallback);
 *  2. ha letto un tipo vero (non il fallback);
 *  3. quel tipo esiste in una sola copia per soggetto (TIPI_UNICI_PER_SOGGETTO).
 *
 * In dubbio si risponde `false`: la scadenza si aggiunge senza cancellare
 * niente. E la stessa gerarchia di rischi dell'ordine INSERT-prima in
 * registraScadenzaCore — riga duplicata (visibile) >> riga sparita (silenziosa).
 * Il punto 3 e quello che conta di piu qui, perche il flusso automatico
 * auto-conferma dopo 3 solleciti senza risposta: nessun umano vede la
 * sostituzione al momento in cui avviene.
 */
function chiaveDiSostituzioneAffidabile(proposta: ProposalRow): boolean {
  const soggetto = sanitizeSegment(proposta.soggetto, '')
  const tipo = sanitizeSegment(proposta.tipo_documento, '')
  if (!soggetto || !tipo) return false
  if (normalizzaTipo(soggetto) === normalizzaTipo(SOGGETTO_FALLBACK)) return false
  if (normalizzaTipo(tipo) === normalizzaTipo(TIPO_FALLBACK)) return false
  return tipoUnicoPerSoggetto(tipo)
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
 * path manuale: validazione della data, cap su reminder_days, strip dei NUL,
 * evento in agenda.
 *
 * MA la sostituzione della scadenza precedente NON viene concessa a scatola
 * chiusa. Unificando i due path si era ereditata anche la `marcaSostituite`, che
 * qui girava su una chiave quasi costante — `categoria` e la costante
 * 'Documenti', e soggetto/tipo cadono sui fallback appena l'estrattore non
 * legge il documento. Risultato: la conferma di un documento marcava
 * 'sostituito' quello precedente di un ALTRO documento, che spariva da
 * lista_scadenze e dal cron promemoria (entrambi filtrano stato='attivo').
 * Il secondo attestato di formazione di Mario Rossi cancellava il primo.
 *
 * Ora la sostituzione parte solo se `chiaveDiSostituzioneAffidabile` la
 * autorizza; altrimenti la nuova scadenza si aggiunge e le due righe restano
 * entrambe attive.
 *
 * Ritorna la nota Calendar quando l'evento NON e stato creato, cosi il
 * messaggio di conferma non promette un'agenda che non e stata aggiornata.
 */
async function ensureScadenza(proposta: ProposalRow, categoria: string, driveUrl: string): Promise<string | null> {
  const dataScadenza = proposta.data_scadenza
  if (!dataScadenza) throw new Error('La proposta non contiene una data_scadenza valida.')

  const esito = await registraScadenzaCore(
    {
      soggetto: proposta.soggetto || SOGGETTO_FALLBACK,
      categoria,
      tipo_documento: proposta.tipo_documento || TIPO_FALLBACK,
      data_scadenza: dataScadenza,
      drive_url: driveUrl,
    },
    { sostituisciPrecedenti: chiaveDiSostituzioneAffidabile(proposta) },
  )

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
