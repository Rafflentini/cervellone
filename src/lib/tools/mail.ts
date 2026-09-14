import { supabase } from '../supabase'
import type { ToolDefinition } from './types'
import {
  listInbox, searchGmail, readMessage, readThread,
  createDraft, listDrafts, showDraft, deleteDraft, sendDraft,
  applyLabel, removeLabel, listLabels, markAsRead, archive, trash,
  type GmailMessageMeta, type GmailMessage, type GmailAttachmentMeta,
} from '../gmail-tools'
import { buildDailySummary } from '../gmail-summary'
import { MAIL_TOOL_EXECUTORS } from '@/v19/tools/email'
import { recordSentMail } from '@/lib/sent-mail'
import type { ChiaveCasella } from '../caselle'
import {
  leggiSuTutteLeGoogle, casellaPerScrittura, TOOL_GMAIL_CHE_SCRIVONO,
  type EsitoLettura,
} from '../politica-caselle'

/** Le sole caselle indicate dal modello (se valide), o `undefined` = tutte. */
function caselleRichieste(input: Record<string, unknown>): ChiaveCasella[] | undefined {
  const raw = input.caselle
  if (!Array.isArray(raw)) return undefined
  const valide = raw.filter((c): c is ChiaveCasella => c === 'drive' || c === 'larealestate')
  return valide.length > 0 ? valide : undefined
}

/** Il testo che avverte il modello delle caselle su cui NON si è potuto guardare. */
function formatCaselleFallite(caselleFallite: EsitoLettura<unknown>['caselleFallite']): string {
  if (caselleFallite.length === 0) return ''
  return '\n\n' + caselleFallite
    .map((f) => `⚠️ NON ho potuto guardare in ${f.casella}: ${f.errore}`)
    .join('\n')
}

/**
 * True se l'errore e' un 404 "non trovato" dell'API Google — MAI indovinato
 * su una stringa a caso nel messaggio (vedi il monito in `leggiSuTutteLeGoogle`):
 * guarda lo status HTTP vero, nei tre punti dove gaxios/googleapis lo mettono
 * (`.status`, `.response.status`, `.code` numerico — stesso schema gia'
 * provato in `google-token-health.ts`). Un 401/403/500 non torna mai true da
 * qui: restano fallimenti.
 */
function e404Gmail(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false
  const rec = err as Record<string, unknown>
  if (rec.status === 404) return true
  if (rec.code === 404) return true
  const response = rec.response
  if (typeof response === 'object' && response !== null) {
    if ((response as Record<string, unknown>).status === 404) return true
  }
  return false
}

/**
 * Formatta l'esito di una lettura per ID (messaggio/thread/bozza): a
 * differenza di una lista o una ricerca, zero risultati e zero fallimenti qui
 * e' un DATO ("quell'ID non sta in nessuna delle caselle guardate"), non un
 * buco — e va detto cosi', non con l'avviso di guasto.
 */
function formatGmailPerIdMulti(cosa: string, esito: EsitoLettura<GmailMessage>): string {
  if (esito.risultati.length === 0 && esito.caselleFallite.length === 0) {
    return `${cosa} non trovato in nessuna casella.`
  }
  const corpo = esito.risultati.length === 0
    ? 'Nessun messaggio trovato.'
    : esito.risultati.map(formatGmailMessage).join('\n\n---\n\n')
  return corpo + formatCaselleFallite(esito.caselleFallite)
}

const SCHEMA_CASELLE = {
  type: 'array' as const,
  items: { type: 'string' as const, enum: ['drive', 'larealestate'] },
  description: 'Quali caselle Google guardare. Se non lo dici, le guarda TUTTE e ti dice da quale viene ogni risultato.',
}

// Per la SCRITTURA (bozza, invio, label, archivia, cestina) non c'e' un
// default: a differenza di SCHEMA_CASELLE, qui il parametro e' OBBLIGATORIO —
// vedi `casellaPerScrittura` in `politica-caselle.ts`, che rifiuta se manca.
const SCHEMA_CASELLA_SCRITTURA = {
  type: 'string' as const,
  enum: ['drive', 'larealestate'],
  description: 'OBBLIGATORIA: da quale casella. Non viene dedotta.',
}

// 2026-05-24 V19 Mail (TopHost IMAP/SMTP per info@/raffaele.lentini@):
// 5 tool — read_email, get_email_body, send_email, forward_email, mark_email
// Tool d'invio: il loro successo (status='sent') deve essere registrato come
// "mail già inviata" così il bot non la re-invia senza richiesta esplicita.
const MAIL_SEND_TOOLS = new Set([
  'send_email',
  'send_email_with_attachments',
  'forward_email',
  'pack_emails_and_send',
])

/** Estrae il destinatario (to) in forma stringa dall'input eterogeneo dei tool d'invio. */
function extractMailTo(input: Record<string, unknown>): string {
  const raw = input.to ?? input.to_address ?? ''
  if (Array.isArray(raw)) return raw.map((x) => String(x)).join(', ')
  return String(raw)
}

/** Estrae l'oggetto (subject) in forma stringa dall'input dei tool d'invio. */
function extractMailSubject(input: Record<string, unknown>): string {
  const raw = input.subject ?? input.oggetto ?? input.new_subject_prefix ?? ''
  return String(raw)
}

/**
 * True se il risultato (stringa JSON dei tool d'invio) indica un invio EFFETTIVO.
 * I tool ritornano JSON.stringify({ ok:true, status:'sent'|'pending', ... }).
 * Solo status='sent' = mail davvero partita; 'pending' = in attesa di conferma utente.
 */
function mailWasActuallySent(out: string): boolean {
  try {
    const parsed = JSON.parse(out) as { ok?: unknown; status?: unknown }
    return parsed?.ok === true && parsed?.status === 'sent'
  } catch {
    return false
  }
}

/**
 * Se il risultato di un tool d'invio indica un PENDING (destinatario esterno, in
 * attesa di conferma utente via Telegram), estrae l'uuid della riga pending.
 * Ritorna null se non è un pending o non c'è uuid.
 */
function extractPendingUuid(out: string): string | null {
  try {
    const parsed = JSON.parse(out) as { ok?: unknown; status?: unknown; uuid?: unknown }
    if (parsed?.ok === true && parsed?.status === 'pending' && typeof parsed.uuid === 'string') {
      return parsed.uuid
    }
    return null
  } catch {
    return null
  }
}

/**
 * Aggancia la conversazione alla riga pending: l'invio REALE verso destinatari esterni
 * avviene alla conferma utente (confirmPendingSend), percorso che NON passa da qui.
 * Salvando conversation_id sulla riga pending, la conferma sa in quale conversazione
 * registrare la mail come "già inviata" (recordSentMail). Best-effort: non blocca, non lancia.
 */
async function attachConversationToPending(uuid: string, conversationId: string): Promise<void> {
  try {
    await supabase
      .from('cervellone_email_pending_send')
      .update({ conversation_id: conversationId })
      .eq('uuid', uuid)
  } catch {
    /* best-effort */
  }
}

export async function executeMailWrapper(
  name: string,
  input: Record<string, unknown>,
  conversationId?: string,
): Promise<string | null> {
  const executor = MAIL_TOOL_EXECUTORS[name]
  if (!executor) return null
  try {
    const out = await executor(input)
    // Consapevolezza mail inviate: registra solo gli invii EFFETTIVI (status='sent'),
    // non i 'pending' (in attesa di conferma utente). Best-effort, non blocca il ritorno.
    if (conversationId && MAIL_SEND_TOOLS.has(name) && mailWasActuallySent(out)) {
      void recordSentMail(conversationId, {
        to: extractMailTo(input),
        subject: extractMailSubject(input),
      }).catch(() => {})
    }
    // Invio ESTERNO: il tool ritorna status='pending' + uuid e l'invio reale avviene
    // alla conferma utente (confirmPendingSend), fuori da questo wrapper. Agganciamo qui
    // la conversazione alla riga pending così che la conferma possa registrare la mail.
    if (conversationId && MAIL_SEND_TOOLS.has(name)) {
      const pendingUuid = extractPendingUuid(out)
      if (pendingUuid) {
        void attachConversationToPending(pendingUuid, conversationId).catch(() => {})
      }
    }
    return out
  } catch (err) {
    return `Errore mail (${name}): ${err instanceof Error ? err.message : String(err)}`
  }
}

// 2026-05-05 Gmail R+W: 16 tool per gestione email (read/draft/send/labels/archive/trash + summary)
export const GMAIL_TOOLS: ToolDefinition[] = [
  {
    name: 'gmail_list_inbox',
    description: 'Elenca le mail in inbox. Guarda TUTTE le caselle Google (drive, larealestate) salvo diversa indicazione. Default 20 mail più recenti, filtri opzionali.',
    input_schema: {
      type: 'object' as const,
      properties: {
        max_results: { type: 'string', description: 'Max risultati (default 20, max 100)' },
        only_unread: { type: 'string', description: '"true" per solo non lette' },
        since_days: { type: 'string', description: 'Solo ultimi N giorni' },
        caselle: SCHEMA_CASELLE,
      },
    },
  },
  {
    name: 'gmail_search',
    description: 'Cerca mail con sintassi Gmail nativa (es. "from:rossi after:2026-04-01", "subject:DURC", "has:attachment"). Guarda TUTTE le caselle Google salvo diversa indicazione.',
    input_schema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'Query Gmail (sintassi nativa)' },
        max_results: { type: 'string', description: 'Max risultati (default 20)' },
        caselle: SCHEMA_CASELLE,
      },
      required: ['query'],
    },
  },
  {
    name: 'gmail_read_message',
    description: 'Legge il contenuto completo di una singola mail (corpo, headers, lista allegati). Se non sai in quale casella sta, prova TUTTE.',
    input_schema: {
      type: 'object' as const,
      properties: {
        message_id: { type: 'string', description: 'Gmail message ID' },
        caselle: SCHEMA_CASELLE,
      },
      required: ['message_id'],
    },
  },
  {
    name: 'gmail_read_thread',
    description: 'Legge tutti i messaggi di un thread (conversazione email completa). Se non sai in quale casella sta, prova TUTTE.',
    input_schema: {
      type: 'object' as const,
      properties: {
        thread_id: { type: 'string', description: 'Gmail thread ID' },
        caselle: SCHEMA_CASELLE,
      },
      required: ['thread_id'],
    },
  },
  {
    name: 'gmail_create_draft',
    description: 'Crea una bozza di mail. Mostrala SEMPRE all\'utente per conferma prima di inviare. Per rispondere a un thread esistente passa in_reply_to e thread_id.',
    input_schema: {
      type: 'object' as const,
      properties: {
        to: { type: 'string', description: 'Destinatario (email)' },
        subject: { type: 'string', description: 'Oggetto' },
        body: { type: 'string', description: 'Corpo testo (italiano formale per Restruktura)' },
        in_reply_to: { type: 'string', description: 'Message-ID a cui rispondere' },
        thread_id: { type: 'string', description: 'Thread ID per risposta in catena' },
        casella: SCHEMA_CASELLA_SCRITTURA,
      },
      required: ['to', 'subject', 'body', 'casella'],
    },
  },
  {
    name: 'gmail_list_drafts',
    description: 'Lista bozze pendenti (max 10). Guarda TUTTE le caselle Google salvo diversa indicazione.',
    input_schema: {
      type: 'object' as const,
      properties: { caselle: SCHEMA_CASELLE },
    },
  },
  {
    name: 'gmail_show_draft',
    description: 'Mostra contenuto completo di una bozza per anteprima. Se non sai in quale casella sta, prova TUTTE.',
    input_schema: {
      type: 'object' as const,
      properties: {
        draft_id: { type: 'string' },
        caselle: SCHEMA_CASELLE,
      },
      required: ['draft_id'],
    },
  },
  {
    name: 'gmail_send_draft',
    description: 'INVIA UNA BOZZA. Usa SOLO dopo conferma esplicita dell\'utente (es. "/conferma", "manda", "invia"). Mai senza approvazione esplicita. Anti-loop: rifiuta se thread ha già una recente reply del bot.',
    input_schema: {
      type: 'object' as const,
      properties: { draft_id: { type: 'string' }, casella: SCHEMA_CASELLA_SCRITTURA },
      required: ['draft_id', 'casella'],
    },
  },
  {
    name: 'gmail_delete_draft',
    description: 'Cancella una bozza non inviata (utente ha detto /annulla).',
    input_schema: {
      type: 'object' as const,
      properties: { draft_id: { type: 'string' }, casella: SCHEMA_CASELLA_SCRITTURA },
      required: ['draft_id', 'casella'],
    },
  },
  {
    name: 'gmail_apply_label',
    description: 'Aggiunge una label a una mail (la crea se non esiste).',
    input_schema: {
      type: 'object' as const,
      properties: {
        message_id: { type: 'string' },
        label_name: { type: 'string', description: 'Nome label es. "Cliente Rossi" o "Urgente"' },
        casella: SCHEMA_CASELLA_SCRITTURA,
      },
      required: ['message_id', 'label_name', 'casella'],
    },
  },
  {
    name: 'gmail_remove_label',
    description: 'Rimuove una label da una mail.',
    input_schema: {
      type: 'object' as const,
      properties: {
        message_id: { type: 'string' },
        label_name: { type: 'string' },
        casella: SCHEMA_CASELLA_SCRITTURA,
      },
      required: ['message_id', 'label_name', 'casella'],
    },
  },
  {
    name: 'gmail_list_labels',
    description: 'Elenca tutte le label disponibili nell\'inbox. Guarda TUTTE le caselle Google salvo diversa indicazione.',
    input_schema: {
      type: 'object' as const,
      properties: { caselle: SCHEMA_CASELLE },
    },
  },
  {
    name: 'gmail_mark_read',
    description: 'Segna una mail come letta (rimuove label UNREAD).',
    input_schema: {
      type: 'object' as const,
      properties: { message_id: { type: 'string' }, casella: SCHEMA_CASELLA_SCRITTURA },
      required: ['message_id', 'casella'],
    },
  },
  {
    name: 'gmail_archive',
    description: 'Archivia una mail (rimuove dall\'inbox, recuperabile via search). NIENTE delete permanente.',
    input_schema: {
      type: 'object' as const,
      properties: { message_id: { type: 'string' }, casella: SCHEMA_CASELLA_SCRITTURA },
      required: ['message_id', 'casella'],
    },
  },
  {
    name: 'gmail_trash',
    description: 'Sposta una mail nel cestino Gmail (recuperabile 30 giorni). Chiedi conferma esplicita all\'utente prima di chiamare.',
    input_schema: {
      type: 'object' as const,
      properties: { message_id: { type: 'string' }, casella: SCHEMA_CASELLA_SCRITTURA },
      required: ['message_id', 'casella'],
    },
  },
  {
    name: 'gmail_summary_inbox',
    description: 'Riassunto delle mail non lette degli ultimi N giorni (default 1) — categorizzate, con highlight degli urgenti. Guarda TUTTE le caselle Google salvo diversa indicazione.',
    input_schema: {
      type: 'object' as const,
      properties: {
        since_days: { type: 'string', description: 'Numero giorni indietro (default 1)' },
        caselle: SCHEMA_CASELLE,
      },
    },
  },
]

function formatGmailList(messages: Array<GmailMessageMeta & { casella: ChiaveCasella }>): string {
  if (messages.length === 0) return 'Nessun messaggio trovato.'
  return messages.map(m =>
    `📧 [${m.casella}] [${m.id}] ${m.date.slice(0, 16)} | ${m.from.slice(0, 40)} | ${m.subject.slice(0, 60)}\n   ${m.snippet.slice(0, 100)}`
  ).join('\n\n')
}

function formatGmailListMulti(esito: EsitoLettura<GmailMessageMeta>): string {
  return formatGmailList(esito.risultati) + formatCaselleFallite(esito.caselleFallite)
}

function formatGmailMessage(m: GmailMessage & { casella?: ChiaveCasella }): string {
  const lines = [
    ...(m.casella ? [`Casella: ${m.casella}`] : []),
    `Da: ${m.from}`,
    `A: ${m.to}`,
    `Data: ${m.date}`,
    `Oggetto: ${m.subject}`,
  ]
  if (m.attachments.length > 0) {
    lines.push(`Allegati: ${m.attachments.map((a: GmailAttachmentMeta) => `${a.filename} (${Math.round(a.sizeBytes/1024)}KB)`).join(', ')}`)
  }
  lines.push('', m.bodyText.slice(0, 5000))
  return lines.join('\n')
}

export async function executeGmailWrapper(
  name: string,
  input: Record<string, unknown>,
): Promise<string | null> {
  if (!name.startsWith('gmail_')) return null

  const get = (k: string) => (typeof input[k] === 'string' ? (input[k] as string) : '')
  const caselle = caselleRichieste(input)

  // 🚨 La difesa sta QUI, nel codice, PRIMA di chiamare qualunque funzione di
  // gmail-tools — non in una regola di prompt che tiene solo se il modello la
  // legge bene. Per la scrittura non c'e' predefinito, nemmeno la casella
  // dove si e' letto: chi chiama deve DIRLA, sempre (vedi casellaPerScrittura).
  let casellaScrittura: ChiaveCasella | undefined
  if (TOOL_GMAIL_CHE_SCRIVONO.includes(name)) {
    const esito = casellaPerScrittura(input)
    if (!esito.ok) return esito.messaggio
    casellaScrittura = esito.casella
  }
  // Se questo scatta, non e' un input dell'Ingegnere da rifiutare con
  // garbo: e' un `case` dello switch qui sotto uscito da TOOL_GMAIL_CHE_SCRIVONO
  // senza portarsi dietro la guardia — un bug nel codice, non nell'uso.
  const casellaObbligata = (): ChiaveCasella => {
    if (!casellaScrittura) throw new Error(`bug: "${name}" scrive senza essere passato da casellaPerScrittura`)
    return casellaScrittura
  }

  try {
    switch (name) {
      case 'gmail_list_inbox': {
        const esito = await leggiSuTutteLeGoogle(caselle, (c) => listInbox(c, {
          maxResults: parseInt(get('max_results') || '20', 10),
          onlyUnread: get('only_unread') === 'true',
          sinceDays: parseInt(get('since_days') || '0', 10) || undefined,
        }))
        return formatGmailListMulti(esito)
      }
      case 'gmail_search': {
        const esito = await leggiSuTutteLeGoogle(caselle, (c) =>
          searchGmail(c, get('query'), parseInt(get('max_results') || '20', 10)))
        return formatGmailListMulti(esito)
      }
      case 'gmail_read_message': {
        const esito = await leggiSuTutteLeGoogle(caselle, (c) =>
          readMessage(c, get('message_id')).then((m) => [m]), { nonTrovato: e404Gmail })
        return formatGmailPerIdMulti('Messaggio', esito)
      }
      case 'gmail_read_thread': {
        const esito = await leggiSuTutteLeGoogle(caselle, (c) =>
          readThread(c, get('thread_id')), { nonTrovato: e404Gmail })
        return formatGmailPerIdMulti('Thread', esito)
      }
      case 'gmail_create_draft': {
        const res = await createDraft(casellaObbligata(), {
          to: get('to'),
          subject: get('subject'),
          body: get('body'),
          inReplyTo: get('in_reply_to') || undefined,
          threadId: get('thread_id') || undefined,
        })
        return `✅ Bozza creata. draft_id=${res.draftId}\nUsa gmail_show_draft per anteprima, poi gmail_send_draft DOPO conferma utente.`
      }
      case 'gmail_list_drafts': {
        const esito = await leggiSuTutteLeGoogle(caselle, (c) => listDrafts(c, 20))
        const corpo = esito.risultati.length === 0
          ? 'Nessuna bozza pendente.'
          : esito.risultati.map(d => `📝 [${d.casella}] ${d.draftId}: A: ${d.to} | Oggetto: ${d.subject}`).join('\n')
        return corpo + formatCaselleFallite(esito.caselleFallite)
      }
      case 'gmail_show_draft': {
        const esito = await leggiSuTutteLeGoogle(caselle, (c) =>
          showDraft(c, get('draft_id')).then((d) => [d]), { nonTrovato: e404Gmail })
        return formatGmailPerIdMulti('Bozza', esito)
      }
      case 'gmail_send_draft': {
        const res = await sendDraft(casellaObbligata(), get('draft_id'))
        return `📤 Inviata. message_id=${res.messageId} thread_id=${res.threadId}`
      }
      case 'gmail_delete_draft': {
        await deleteDraft(casellaObbligata(), get('draft_id'))
        return `🗑 Bozza cancellata.`
      }
      case 'gmail_apply_label': {
        await applyLabel(casellaObbligata(), get('message_id'), get('label_name'))
        return `🏷 Label "${get('label_name')}" applicata.`
      }
      case 'gmail_remove_label': {
        await removeLabel(casellaObbligata(), get('message_id'), get('label_name'))
        return `🏷 Label rimossa.`
      }
      case 'gmail_list_labels': {
        const esito = await leggiSuTutteLeGoogle(caselle, (c) => listLabels(c))
        const corpo = esito.risultati.length === 0
          ? 'Nessuna label trovata.'
          : esito.risultati.map(l => `- [${l.casella}] ${l.name} (id=${l.id})`).join('\n')
        return corpo + formatCaselleFallite(esito.caselleFallite)
      }
      case 'gmail_mark_read': {
        await markAsRead(casellaObbligata(), get('message_id'))
        return `✓ Segnata come letta.`
      }
      case 'gmail_archive': {
        await archive(casellaObbligata(), get('message_id'))
        return `📦 Archiviata.`
      }
      case 'gmail_trash': {
        await trash(casellaObbligata(), get('message_id'))
        return `🗑 Spostata nel cestino (recuperabile 30 giorni).`
      }
      case 'gmail_summary_inbox': {
        const esito = await leggiSuTutteLeGoogle(caselle, (c) =>
          buildDailySummary(c, parseInt(get('since_days') || '1', 10)).then((s) => [s]))
        const corpo = esito.risultati.length === 0
          ? 'Nessuna casella disponibile per il riassunto.'
          : esito.risultati.map(s => `--- ${s.casella} ---\n${s.digest}`).join('\n\n')
        return corpo + formatCaselleFallite(esito.caselleFallite)
      }
      default:
        return `Tool gmail "${name}" non riconosciuto.`
    }
  } catch (err) {
    return `Errore Gmail: ${err instanceof Error ? err.message : err}`
  }
}
