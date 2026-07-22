/**
 * lib/calendar-tools.ts — Integrazione Google Calendar R+W per Cervellone.
 *
 * Riusa lo stesso OAuth Google già autenticato (refresh_token in
 * google_oauth_credentials) usato da Drive/Sheets/Gmail — stesso account
 * restruktura.drive@gmail.com.
 *
 * ⚠️ Scope richiesto: https://www.googleapis.com/auth/calendar
 *   Aggiunto in google-oauth.ts SCOPES. Il refresh_token salvato NON ha
 *   questo scope finché l'Ingegnere non rifà il consent flow (un clic su
 *   /api/auth/google). Fino ad allora ogni chiamata Calendar → 403.
 *
 * Pattern: identico a gmail-tools.ts (getAuthorizedClient → google.calendar).
 */

import { google } from 'googleapis'
import type { calendar_v3 } from 'googleapis'
import type { OAuth2Client } from 'google-auth-library'

interface ToolDefinition {
  name: string
  description: string
  input_schema: Record<string, unknown>
}

const TIME_ZONE = 'Europe/Rome'
// Google Calendar: minuti max per un reminder override = 40320 (28 giorni)
const MAX_REMINDER_MINUTES = 40320

// ── Auth (stesso pattern di gmail-tools.ts) ──

async function getCalendarClient(): Promise<calendar_v3.Calendar> {
  const { getAuthorizedClient } = await import('./google-oauth')
  const oauthClient: OAuth2Client | null = await getAuthorizedClient()
  if (!oauthClient) {
    throw new Error(
      'OAuth Google non autenticato. L\'Ingegnere deve completare il consent flow su /api/auth/google (con lo scope Calendar aggiunto).',
    )
  }
  return google.calendar({ version: 'v3', auth: oauthClient })
}

// ── Helpers ──

function get(input: Record<string, unknown>, k: string): string {
  return typeof input[k] === 'string' ? (input[k] as string).trim() : ''
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/

/**
 * Costruisce start/end per l'API Calendar.
 * - data pura YYYY-MM-DD → evento all-day (end esclusivo = +1 giorno se non dato)
 * - datetime ISO (con 'T') → evento con orario, timeZone Europe/Rome
 */
function buildStartEnd(
  startRaw: string,
  endRaw: string,
): { start: calendar_v3.Schema$EventDateTime; end: calendar_v3.Schema$EventDateTime } {
  if (DATE_ONLY.test(startRaw)) {
    // All-day: end.date è esclusivo. Se non dato, +1 giorno.
    let endDate = endRaw && DATE_ONLY.test(endRaw) ? endRaw : ''
    if (!endDate) {
      const d = new Date(`${startRaw}T00:00:00Z`)
      d.setUTCDate(d.getUTCDate() + 1)
      endDate = d.toISOString().slice(0, 10)
    }
    return { start: { date: startRaw }, end: { date: endDate } }
  }
  // Timed
  let endDt = endRaw
  if (!endDt) {
    const d = new Date(startRaw)
    if (isNaN(d.getTime())) throw new Error(`Data/ora inizio non valida: "${startRaw}"`)
    d.setTime(d.getTime() + 60 * 60 * 1000) // +1h default
    endDt = d.toISOString()
  }
  return {
    start: { dateTime: startRaw, timeZone: TIME_ZONE },
    end: { dateTime: endDt, timeZone: TIME_ZONE },
  }
}

function buildReminders(reminderDaysRaw: string): calendar_v3.Schema$Event['reminders'] | undefined {
  const days = parseInt(reminderDaysRaw || '0', 10)
  if (!days || days <= 0) return undefined
  const minutes = Math.min(days * 24 * 60, MAX_REMINDER_MINUTES)
  return {
    useDefault: false,
    overrides: [
      { method: 'email', minutes },
      { method: 'popup', minutes },
    ],
  }
}

function formatEvent(e: calendar_v3.Schema$Event): string {
  const when = e.start?.date || e.start?.dateTime || '?'
  const parts = [`📅 ${e.summary || '(senza titolo)'} — ${when}`]
  if (e.location) parts.push(`  📍 ${e.location}`)
  parts.push(`  id=${e.id}`)
  if (e.htmlLink) parts.push(`  ${e.htmlLink}`)
  return parts.join('\n')
}

// ── Operations ──

async function createEvent(input: Record<string, unknown>): Promise<string> {
  const summary = get(input, 'summary') || get(input, 'titolo')
  if (!summary) return '⚠️ Manca il titolo (summary) dell\'evento.'
  const startRaw = get(input, 'start_date') || get(input, 'start_datetime') || get(input, 'data')
  if (!startRaw) return '⚠️ Manca la data/ora di inizio (start_date YYYY-MM-DD oppure start_datetime ISO).'
  const endRaw = get(input, 'end_date') || get(input, 'end_datetime')

  const calendar = await getCalendarClient()
  const { start, end } = buildStartEnd(startRaw, endRaw)
  const reminders = buildReminders(get(input, 'reminder_days_before'))

  const requestBody: calendar_v3.Schema$Event = {
    summary,
    start,
    end,
  }
  const description = get(input, 'description') || get(input, 'note')
  if (description) requestBody.description = description
  const location = get(input, 'location') || get(input, 'luogo')
  if (location) requestBody.location = location
  if (reminders) requestBody.reminders = reminders

  const calendarId = get(input, 'calendar_id') || 'primary'
  const res = await calendar.events.insert({ calendarId, requestBody })
  const ev = res.data
  console.log(`[CALENDAR] createEvent "${summary.slice(0, 40)}" ${startRaw} id=${ev.id}`)
  return `✅ Evento creato sul Google Calendar (${calendarId}).\n${formatEvent(ev)}`
}

async function listEvents(input: Record<string, unknown>): Promise<string> {
  const calendar = await getCalendarClient()
  const calendarId = get(input, 'calendar_id') || 'primary'
  const timeMin = get(input, 'time_min')
  const timeMax = get(input, 'time_max')
  const q = get(input, 'query')
  const max = Math.min(parseInt(get(input, 'max_results') || '20', 10) || 20, 100)

  const res = await calendar.events.list({
    calendarId,
    timeMin: timeMin || undefined,
    timeMax: timeMax || undefined,
    q: q || undefined,
    maxResults: max,
    singleEvents: true,
    orderBy: 'startTime',
  })
  const events = res.data.items || []
  if (events.length === 0) return 'Nessun evento trovato nel periodo richiesto.'
  return `${events.length} eventi:\n\n${events.map(formatEvent).join('\n\n')}`
}

async function updateEvent(input: Record<string, unknown>): Promise<string> {
  const eventId = get(input, 'event_id')
  if (!eventId) return '⚠️ Manca event_id.'
  const calendar = await getCalendarClient()
  const calendarId = get(input, 'calendar_id') || 'primary'

  // patch: manda solo i campi forniti
  const patch: calendar_v3.Schema$Event = {}
  const summary = get(input, 'summary') || get(input, 'titolo')
  if (summary) patch.summary = summary
  const description = get(input, 'description') || get(input, 'note')
  if (description) patch.description = description
  const location = get(input, 'location') || get(input, 'luogo')
  if (location) patch.location = location
  const startRaw = get(input, 'start_date') || get(input, 'start_datetime')
  if (startRaw) {
    const endRaw = get(input, 'end_date') || get(input, 'end_datetime')
    const { start, end } = buildStartEnd(startRaw, endRaw)
    patch.start = start
    patch.end = end
  }
  const reminders = buildReminders(get(input, 'reminder_days_before'))
  if (reminders) patch.reminders = reminders

  if (Object.keys(patch).length === 0) return '⚠️ Nessun campo da aggiornare fornito.'

  const res = await calendar.events.patch({ calendarId, eventId, requestBody: patch })
  console.log(`[CALENDAR] updateEvent id=${eventId}`)
  return `✅ Evento aggiornato.\n${formatEvent(res.data)}`
}

async function deleteEvent(input: Record<string, unknown>): Promise<string> {
  const eventId = get(input, 'event_id')
  if (!eventId) return '⚠️ Manca event_id.'
  const calendar = await getCalendarClient()
  const calendarId = get(input, 'calendar_id') || 'primary'
  await calendar.events.delete({ calendarId, eventId })
  console.log(`[CALENDAR] deleteEvent id=${eventId}`)
  return `🗑 Evento ${eventId} eliminato dal calendario.`
}

async function listCalendars(): Promise<string> {
  const calendar = await getCalendarClient()
  const res = await calendar.calendarList.list()
  const cals = res.data.items || []
  if (cals.length === 0) return 'Nessun calendario accessibile.'
  return cals
    .map(c => `- ${c.summary}${c.primary ? ' (primario)' : ''} | id=${c.id}${c.accessRole ? ` | ${c.accessRole}` : ''}`)
    .join('\n')
}

// ── Registry ──

export async function executeCalendarTool(
  name: string,
  input: Record<string, unknown>,
): Promise<string | null> {
  if (!name.startsWith('calendar_')) return null
  try {
    switch (name) {
      case 'calendar_create_event':
        return await createEvent(input)
      case 'calendar_list_events':
        return await listEvents(input)
      case 'calendar_update_event':
        return await updateEvent(input)
      case 'calendar_delete_event':
        return await deleteEvent(input)
      case 'calendar_list_calendars':
        return await listCalendars()
      default:
        return `Tool calendar "${name}" non riconosciuto.`
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    // 403/insufficient scope → messaggio chiaro per l'Ingegnere
    if (/insufficient|scope|403|PERMISSION_DENIED/i.test(msg)) {
      return `❌ Errore Calendar: scope non autorizzato. L'Ingegnere deve rifare il consent flow Google su /api/auth/google per concedere l'accesso al Calendar. Dettaglio: ${msg}`
    }
    return `❌ Errore Calendar: ${msg}`
  }
}

export const CALENDAR_TOOLS: ToolDefinition[] = [
  {
    name: 'calendar_create_event',
    description:
      'Crea un evento sul Google Calendar dell\'account restruktura.drive@gmail.com. Usa start_date (YYYY-MM-DD) per un evento di un giorno intero (es. una scadenza), oppure start_datetime (ISO, es. 2026-06-17T09:00:00) per un evento con orario. reminder_days_before imposta un promemoria email+popup N giorni prima. Ideale per registrare scadenze anche sul calendario, oltre che nello scadenzario.',
    input_schema: {
      type: 'object' as const,
      properties: {
        summary: { type: 'string', description: 'Titolo dell\'evento (obbligatorio)' },
        start_date: { type: 'string', description: 'Giorno intero: YYYY-MM-DD (es. scadenza)' },
        start_datetime: { type: 'string', description: 'Con orario: ISO 8601 (es. 2026-06-17T09:00:00)' },
        end_date: { type: 'string', description: 'Fine (all-day, esclusiva). Opzionale.' },
        end_datetime: { type: 'string', description: 'Fine con orario ISO. Opzionale (default +1h).' },
        description: { type: 'string', description: 'Descrizione/note dell\'evento' },
        location: { type: 'string', description: 'Luogo' },
        reminder_days_before: { type: 'string', description: 'Promemoria N giorni prima (email+popup). Es. "5"' },
        calendar_id: { type: 'string', description: 'ID calendario (default "primary")' },
      },
      required: ['summary'],
    },
  },
  {
    name: 'calendar_list_events',
    description:
      'Elenca gli eventi del Google Calendar in un intervallo di tempo. Usa time_min/time_max (ISO) per il periodo e query per cercare per testo. Utile per verificare cosa c\'è in agenda o evitare duplicati prima di creare un evento.',
    input_schema: {
      type: 'object' as const,
      properties: {
        time_min: { type: 'string', description: 'Inizio periodo (ISO 8601)' },
        time_max: { type: 'string', description: 'Fine periodo (ISO 8601)' },
        query: { type: 'string', description: 'Testo da cercare negli eventi' },
        max_results: { type: 'string', description: 'Max risultati (default 20, max 100)' },
        calendar_id: { type: 'string', description: 'ID calendario (default "primary")' },
      },
    },
  },
  {
    name: 'calendar_update_event',
    description:
      'Aggiorna un evento esistente (identificato da event_id). Invia solo i campi da modificare. Per spostare la data passa start_date o start_datetime.',
    input_schema: {
      type: 'object' as const,
      properties: {
        event_id: { type: 'string', description: 'ID dell\'evento da modificare (obbligatorio)' },
        summary: { type: 'string', description: 'Nuovo titolo' },
        start_date: { type: 'string', description: 'Nuova data (all-day, YYYY-MM-DD)' },
        start_datetime: { type: 'string', description: 'Nuova data/ora (ISO)' },
        end_date: { type: 'string', description: 'Nuova fine (all-day, esclusiva)' },
        end_datetime: { type: 'string', description: 'Nuova fine (ISO)' },
        description: { type: 'string', description: 'Nuova descrizione' },
        location: { type: 'string', description: 'Nuovo luogo' },
        reminder_days_before: { type: 'string', description: 'Nuovo promemoria (giorni prima)' },
        calendar_id: { type: 'string', description: 'ID calendario (default "primary")' },
      },
      required: ['event_id'],
    },
  },
  {
    name: 'calendar_delete_event',
    description: 'Elimina un evento dal Google Calendar (identificato da event_id).',
    input_schema: {
      type: 'object' as const,
      properties: {
        event_id: { type: 'string', description: 'ID dell\'evento da eliminare (obbligatorio)' },
        calendar_id: { type: 'string', description: 'ID calendario (default "primary")' },
      },
      required: ['event_id'],
    },
  },
  {
    name: 'calendar_list_calendars',
    description: 'Elenca i calendari accessibili dall\'account (id e nome), per sapere dove scrivere gli eventi.',
    input_schema: { type: 'object' as const, properties: {} },
  },
]
