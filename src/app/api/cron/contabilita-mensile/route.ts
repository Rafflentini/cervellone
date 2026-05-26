import { NextRequest, NextResponse } from 'next/server'
import { executeRiconciliazioneTool } from '@/lib/riconciliazione-tools'
import { executePrimaNotaTool } from '@/lib/prima-nota-tools'
import { sendTelegramMessage } from '@/lib/telegram-helpers'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

const CONTABILITA_FOLDER_ID = process.env.CONTABILITA_FOLDER_ID || '1mFgmx_BtCxvPk0IAy7ysDdQKsaFP9mBl'
type ToolResult = Record<string, unknown>

function getAdminChatId(): number | null {
  const admin = parseInt(process.env.ADMIN_CHAT_ID || '0', 10)
  if (admin) return admin
  const firstAllowed = (process.env.TELEGRAM_ALLOWED_IDS || '').split(',')[0]?.trim()
  const fallback = parseInt(firstAllowed || '0', 10)
  return fallback || null
}

function previousMonthRome(now = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Europe/Rome',
    year: 'numeric',
    month: '2-digit',
  }).formatToParts(now)
  const year = Number(parts.find(p => p.type === 'year')?.value)
  const month = Number(parts.find(p => p.type === 'month')?.value)
  const prevMonth = month === 1 ? 12 : month - 1
  const prevYear = month === 1 ? year - 1 : year
  return `${prevYear}-${String(prevMonth).padStart(2, '0')}`
}

function parseToolJson(raw: string | null): ToolResult {
  if (!raw) return { ok: false, error: 'tool non disponibile' }
  try {
    return JSON.parse(raw)
  } catch {
    return { ok: false, error: raw }
  }
}

async function notifyAdmin(message: string): Promise<boolean> {
  const adminChatId = getAdminChatId()
  if (!adminChatId) return false
  await sendTelegramMessage(adminChatId, message)
  return true
}

export async function GET(req: NextRequest) {
  const auth = req.headers.get('authorization')
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 })
  }

  const periodo = previousMonthRome()

  let riconciliazione: ToolResult = { ok: false, error: 'non eseguita' }
  try {
    riconciliazione = parseToolJson(await executeRiconciliazioneTool('riconcilia_automatico', { periodo }))
  } catch (err) {
    riconciliazione = { ok: false, error: err instanceof Error ? err.message : String(err) }
  }

  let primaNota: ToolResult = { ok: false, error: 'non eseguita' }
  try {
    primaNota = parseToolJson(await executePrimaNotaTool('genera_prima_nota', {
      periodo,
      folder_id: CONTABILITA_FOLDER_ID,
    }))
  } catch (err) {
    primaNota = { ok: false, error: err instanceof Error ? err.message : String(err) }
  }

  const adminMessage = buildNotification(periodo, riconciliazione, primaNota)
  let notified = false
  try {
    notified = await notifyAdmin(adminMessage)
  } catch (err) {
    console.error('[CRON contabilita-mensile] telegram failed:', err)
  }

  return NextResponse.json({
    ok: Boolean(primaNota.ok),
    periodo,
    riconciliazione,
    prima_nota: primaNota,
    notified,
  })
}

function buildNotification(
  periodo: string,
  riconciliazione: ToolResult,
  primaNota: ToolResult,
): string {
  const primaNotaError = typeof primaNota.error === 'string' ? primaNota.error : ''
  if (!primaNota.ok && primaNotaError.includes('nessun movimento')) {
    return `Contabilita ${periodo}: nessun movimento trovato. Carichi gli estratti conto di ${periodo} in Contabilita, poi rigenero la Prima Nota.`
  }

  if (!primaNota.ok) {
    return `Contabilita ${periodo}: Prima Nota non generata. Errore: ${primaNotaError || 'sconosciuto'}`
  }

  const residui = riconciliazione.residui && typeof riconciliazione.residui === 'object'
    ? riconciliazione.residui as Record<string, unknown>
    : {}
  const abbinatiAuto = Number(riconciliazione.abbinati_auto || 0)
  const daRiconciliare = Number(residui.movimenti_totali || 0)
  return [
    `Contabilita ${periodo}: Prima Nota generata.`,
    `Movimenti: ${primaNota.movimenti ?? 0}`,
    `Entrate: ${primaNota.entrate ?? 0}`,
    `Uscite: ${primaNota.uscite ?? 0}`,
    `Saldo finale: ${primaNota.saldo_finale ?? 0}`,
    `Link Prima Nota: ${primaNota.url}`,
    `Abbinati auto: ${abbinatiAuto}, da riconciliare a mano: ${daRiconciliare} (scrivimi per sistemarli, poi rigenero).`,
  ].join('\n')
}
