import { NextRequest, NextResponse } from 'next/server'
import { supabase } from '@/lib/supabase'
import { runAudit, getISOWeek } from '@/lib/audit-runner'
import { sendTelegramMessageChecked, chatAdmin } from '@/lib/telegram-helpers'
import { avvisaConversazioniWeb } from '@/lib/avviso-web'

export const maxDuration = 120

// Telegram accetta fino a 4096 caratteri per messaggio. Il taglio si ferma
// molto prima per lasciare spazio alla riga che dichiara il troncamento —
// altrimenti la nota stessa spingerebbe il messaggio oltre il limite.
const TELEGRAM_LIMITE = 4096
const TELEGRAM_TAGLIO = 3500

/**
 * Se il rapporto supera il limite di Telegram, lo taglia e lo dice in coda.
 * Un rapporto tagliato che sembra completo e' peggio di un rapporto corto: chi
 * lo legge non saprebbe che manca qualcosa. Il rapporto intero resta comunque
 * in `cervellone_audit_runs.report_text`, indicizzato per settimana ISO.
 */
export function truncaPerTelegram(testo: string, isoWeek: string): string {
  if (testo.length <= TELEGRAM_LIMITE) return testo
  const nota = `\n\n⚠️ _Rapporto troncato — il testo completo e' in \`cervellone_audit_runs\`, settimana \`${isoWeek}\`._`
  return testo.slice(0, TELEGRAM_TAGLIO) + nota
}

export interface ConsegnaEsito {
  telegram: boolean
  web: boolean
}

/**
 * Consegna il rapporto self-audit su ENTRAMBI i canali — Telegram e chat web
 * — SEMPRE, anche a zero anomalie: e' il battito positivo della sentinella.
 * Se il silenzio potesse voler dire sia "tutto ok" sia "la sentinella e'
 * morta", non sarebbe una rete di sicurezza.
 *
 * I due canali sono indipendenti: uno che fallisce non deve impedire
 * all'altro di partire, e questa funzione non lancia mai — un rapporto
 * gia' salvato in `cervellone_audit_runs` non deve poter far fallire il cron
 * solo perche' il recapito e' andato storto.
 */
export async function consegnaReportAudit(reportText: string, isoWeek: string): Promise<ConsegnaEsito> {
  const esito: ConsegnaEsito = { telegram: false, web: false }

  try {
    const chat = chatAdmin()
    if (chat) {
      // sendTelegramMessageChecked, NON sendTelegramMessage: la seconda e'
      // "fire and forget" e non rigetta MAI — e' esattamente il motivo per
      // cui sei settimane di rapporti sono stati scritti e mai consegnati
      // senza che nessuno se ne accorgesse.
      esito.telegram = await sendTelegramMessageChecked(chat, truncaPerTelegram(reportText, isoWeek))
    } else {
      console.error('[CRON self-audit] Telegram non consegnato: chat admin non configurata (ADMIN_CHAT_ID / TELEGRAM_ALLOWED_IDS)')
    }
  } catch (err) {
    console.error('[CRON self-audit] invio Telegram fallito:', err instanceof Error ? err.message : err)
  }

  try {
    esito.web = await avvisaConversazioniWeb(reportText)
  } catch (err) {
    console.error('[CRON self-audit] invio web fallito:', err instanceof Error ? err.message : err)
  }

  if (!esito.telegram && !esito.web) {
    console.error(`[CRON self-audit] CONSEGNA FALLITA su entrambi i canali — settimana ${isoWeek}: il rapporto resta solo in cervellone_audit_runs`)
  }

  return esito
}

export async function GET(req: NextRequest) {
  const auth = req.headers.get('authorization')
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 })
  }

  // Silent mode check
  const { data: silentRow } = await supabase
    .from('cervellone_config')
    .select('value')
    .eq('key', 'audit_silent_until')
    .maybeSingle()
  const silentValue = silentRow?.value
  if (silentValue && silentValue !== 'null' && silentValue !== null) {
    const silentUntil = new Date(typeof silentValue === 'string' ? silentValue.replace(/"/g, '') : silentValue)
    if (Date.now() < silentUntil.getTime()) {
      console.log(`[CRON self-audit] silent until ${silentUntil.toISOString()}, skip`)
      return NextResponse.json({ ok: true, skipped: 'silent' })
    }
  }

  // Idempotency week-aware: skip se già run questa settimana ISO
  const currentWeek = getISOWeek(new Date())
  const { data: lastRow } = await supabase
    .from('cervellone_config')
    .select('value')
    .eq('key', 'audit_last_run_week')
    .maybeSingle()
  const lastValue = lastRow?.value
  if (lastValue && lastValue !== 'null' && lastValue !== null) {
    const lastWeek = typeof lastValue === 'string' ? lastValue.replace(/"/g, '') : String(lastValue)
    if (lastWeek === currentWeek) {
      console.log(`[CRON self-audit] already ran for ${currentWeek}, skip`)
      return NextResponse.json({ ok: true, skipped: 'already_ran_this_week', week: currentWeek })
    }
  }

  let result
  try {
    result = await runAudit()
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[CRON self-audit] runAudit failed:', msg)
    return NextResponse.json({ ok: false, error: msg }, { status: 500 })
  }

  if (!result.ok) {
    return NextResponse.json({ ok: false, error: result.error }, { status: 500 })
  }

  // Aggiorna last_run_week
  await supabase
    .from('cervellone_config')
    .update({ value: currentWeek })
    .eq('key', 'audit_last_run_week')

  // Il rapporto e' gia' salvato (runAudit lo ha scritto in
  // cervellone_audit_runs prima di tornare): la consegna e' un passo in piu',
  // non una condizione per il successo del cron. Se fallisce entrambi i
  // canali, il rapporto resta comunque recuperabile dal database — ma l'esito
  // va DETTO, non ingoiato in un `ok` generale che nasconderebbe meta' del
  // fatto.
  const consegna = await consegnaReportAudit(result.report_text ?? '', currentWeek)

  console.log(
    `[CRON self-audit] done week=${currentWeek} run_id=${result.run_id} anomalies=${result.anomalies_count} ` +
    `consegna=telegram:${consegna.telegram},web:${consegna.web}`,
  )

  return NextResponse.json({
    ok: true,
    week: currentWeek,
    run_id: result.run_id,
    anomalies_count: result.anomalies_count,
    consegna,
  })
}
