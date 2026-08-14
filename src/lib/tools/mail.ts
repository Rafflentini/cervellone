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
    description: 'Elenca le mail in inbox della casella restruktura.drive@gmail.com. Default 20 mail più recenti, filtri opzionali.',
    input_schema: {
      type: 'object' as const,
      properties: {
        max_results: { type: 'string', description: 'Max risultati (default 20, max 100)' },
        only_unread: { type: 'string', description: '"true" per solo non lette' },
        since_days: { type: 'string', description: 'Solo ultimi N giorni' },
      },
    },
  },
  {
    name: 'gmail_search',
    description: 'Cerca mail con sintassi Gmail nativa (es. "from:rossi after:2026-04-01", "subject:DURC", "has:attachment").',
    input_schema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'Query Gmail (sintassi nativa)' },
        max_results: { type: 'string', description: 'Max risultati (default 20)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'gmail_read_message',
    description: 'Legge il contenuto completo di una singola mail (corpo, headers, lista allegati).',
    input_schema: {
      type: 'object' as const,
      properties: { message_id: { type: 'string', description: 'Gmail message ID' } },
      required: ['message_id'],
    },
  },
  {
    name: 'gmail_read_thread',
    description: 'Legge tutti i messaggi di un thread (conversazione email completa).',
    input_schema: {
      type: 'object' as const,
      properties: { thread_id: { type: 'string', description: 'Gmail thread ID' } },
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
      },
      required: ['to', 'subject', 'body'],
    },
  },
  {
    name: 'gmail_list_drafts',
    description: 'Lista bozze pendenti (max 10).',
    input_schema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'gmail_show_draft',
    description: 'Mostra contenuto completo di una bozza per anteprima.',
    input_schema: {
      type: 'object' as const,
      properties: { draft_id: { type: 'string' } },
      required: ['draft_id'],
    },
  },
  {
    name: 'gmail_send_draft',
    description: 'INVIA UNA BOZZA. Usa SOLO dopo conferma esplicita dell\'utente (es. "/conferma", "manda", "invia"). Mai senza approvazione esplicita. Anti-loop: rifiuta se thread ha già una recente reply del bot.',
    input_schema: {
      type: 'object' as const,
      properties: { draft_id: { type: 'string' } },
      required: ['draft_id'],
    },
  },
  {
    name: 'gmail_delete_draft',
    description: 'Cancella una bozza non inviata (utente ha detto /annulla).',
    input_schema: {
      type: 'object' as const,
      properties: { draft_id: { type: 'string' } },
      required: ['draft_id'],
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
      },
      required: ['message_id', 'label_name'],
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
      },
      required: ['message_id', 'label_name'],
    },
  },
  {
    name: 'gmail_list_labels',
    description: 'Elenca tutte le label disponibili nell\'inbox.',
    input_schema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'gmail_mark_read',
    description: 'Segna una mail come letta (rimuove label UNREAD).',
    input_schema: {
      type: 'object' as const,
      properties: { message_id: { type: 'string' } },
      required: ['message_id'],
    },
  },
  {
    name: 'gmail_archive',
    description: 'Archivia una mail (rimuove dall\'inbox, recuperabile via search). NIENTE delete permanente.',
    input_schema: {
      type: 'object' as const,
      properties: { message_id: { type: 'string' } },
      required: ['message_id'],
    },
  },
  {
    name: 'gmail_trash',
    description: 'Sposta una mail nel cestino Gmail (recuperabile 30 giorni). Chiedi conferma esplicita all\'utente prima di chiamare.',
    input_schema: {
      type: 'object' as const,
      properties: { message_id: { type: 'string' } },
      required: ['message_id'],
    },
  },
  {
    name: 'gmail_summary_inbox',
    description: 'Riassunto delle mail non lette degli ultimi N giorni (default 1) — categorizzate, con highlight degli urgenti.',
    input_schema: {
      type: 'object' as const,
      properties: { since_days: { type: 'string', description: 'Numero giorni indietro (default 1)' } },
    },
  },
]

function formatGmailList(messages: GmailMessageMeta[]): string {
  if (messages.length === 0) return 'Nessun messaggio trovato.'
  return messages.map(m =>
    `📧 [${m.id}] ${m.date.slice(0, 16)} | ${m.from.slice(0, 40)} | ${m.subject.slice(0, 60)}\n   ${m.snippet.slice(0, 100)}`
  ).join('\n\n')
}

function formatGmailMessage(m: GmailMessage): string {
  const lines = [
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

  try {
    switch (name) {
      case 'gmail_list_inbox': {
        const res = await listInbox({
          maxResults: parseInt(get('max_results') || '20', 10),
          onlyUnread: get('only_unread') === 'true',
          sinceDays: parseInt(get('since_days') || '0', 10) || undefined,
        })
        return formatGmailList(res)
      }
      case 'gmail_search': {
        const res = await searchGmail(get('query'), parseInt(get('max_results') || '20', 10))
        return formatGmailList(res)
      }
      case 'gmail_read_message': {
        const m = await readMessage(get('message_id'))
        return formatGmailMessage(m)
      }
      case 'gmail_read_thread': {
        const t = await readThread(get('thread_id'))
        return t.map(formatGmailMessage).join('\n\n---\n\n')
      }
      case 'gmail_create_draft': {
        const res = await createDraft({
          to: get('to'),
          subject: get('subject'),
          body: get('body'),
          inReplyTo: get('in_reply_to') || undefined,
          threadId: get('thread_id') || undefined,
        })
        return `✅ Bozza creata. draft_id=${res.draftId}\nUsa gmail_show_draft per anteprima, poi gmail_send_draft DOPO conferma utente.`
      }
      case 'gmail_list_drafts': {
        const drafts = await listDrafts(20)
        if (drafts.length === 0) return 'Nessuna bozza pendente.'
        return drafts.map(d => `📝 ${d.draftId}: A: ${d.to} | Oggetto: ${d.subject}`).join('\n')
      }
      case 'gmail_show_draft': {
        const d = await showDraft(get('draft_id'))
        return formatGmailMessage(d)
      }
      case 'gmail_send_draft': {
        const res = await sendDraft(get('draft_id'))
        return `📤 Inviata. message_id=${res.messageId} thread_id=${res.threadId}`
      }
      case 'gmail_delete_draft': {
        await deleteDraft(get('draft_id'))
        return `🗑 Bozza cancellata.`
      }
      case 'gmail_apply_label': {
        await applyLabel(get('message_id'), get('label_name'))
        return `🏷 Label "${get('label_name')}" applicata.`
      }
      case 'gmail_remove_label': {
        await removeLabel(get('message_id'), get('label_name'))
        return `🏷 Label rimossa.`
      }
      case 'gmail_list_labels': {
        const labels = await listLabels()
        return labels.map(l => `- ${l.name} (id=${l.id})`).join('\n')
      }
      case 'gmail_mark_read': {
        await markAsRead(get('message_id'))
        return `✓ Segnata come letta.`
      }
      case 'gmail_archive': {
        await archive(get('message_id'))
        return `📦 Archiviata.`
      }
      case 'gmail_trash': {
        await trash(get('message_id'))
        return `🗑 Spostata nel cestino (recuperabile 30 giorni).`
      }
      case 'gmail_summary_inbox': {
        const summary = await buildDailySummary(parseInt(get('since_days') || '1', 10))
        return summary.digest
      }
      default:
        return `Tool gmail "${name}" non riconosciuto.`
    }
  } catch (err) {
    return `Errore Gmail: ${err instanceof Error ? err.message : err}`
  }
}
