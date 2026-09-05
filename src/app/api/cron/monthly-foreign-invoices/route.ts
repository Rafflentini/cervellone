/**
 * Cron mensile fatture estere.
 *
 * Auth: Bearer ${CRON_SECRET} (pattern condiviso con altri cron Cervellone).
 * Idempotency: lock per (month_ref) via cervellone_config key
 *   monthly_foreign_invoices_last_run::YYYY-MM.
 *
 * Query string:
 *   ?month=YYYY-MM  override del mese (default = mese precedente UTC)
 *   ?dry=1          dry-run, NON inoltra, NON setta lock
 */
import { NextRequest, NextResponse } from 'next/server'
import { supabase } from '@/lib/supabase'
import { runMonthlyForeignInvoices } from '@/v19/routines/monthly-foreign-invoices'
import { sendTelegramMessage, chatAdmin } from '@/lib/telegram-helpers'

export const maxDuration = 300

function previousMonthRef(now = new Date()): string {
  const y = now.getUTCFullYear()
  const m = now.getUTCMonth() // 0..11 (current month)
  const prev = new Date(Date.UTC(y, m - 1, 1))
  return `${prev.getUTCFullYear()}-${String(prev.getUTCMonth() + 1).padStart(2, '0')}`
}

export async function GET(req: NextRequest) {
  // ATTENZIONE: Vercel UI "Run now" NON inietta Authorization: Bearer ${CRON_SECRET}.
  // Smoke test SOLO via:
  //   curl -H "Authorization: Bearer $CRON_SECRET" https://.../api/cron/monthly-foreign-invoices?dry=1
  // oppure aspettando lo scheduler reale alle 08:00 UTC del 1° del mese.
  const auth = req.headers.get('authorization')
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 })
  }
  // Risolta QUI e non a caricamento del modulo: le variabili d'ambiente di una
  // funzione serverless vanno lette quando serve, non una volta per sempre.
  const RAFFAELE_CHAT_ID = chatAdmin() || null
  if (!RAFFAELE_CHAT_ID) {
    console.error('[cron/fatture-estere] chat Telegram non configurata: il resoconto NON partira')
  }
  const monthRef = req.nextUrl.searchParams.get('month') ?? previousMonthRef()
  const dry = req.nextUrl.searchParams.get('dry') === '1'

  const idemKey = `monthly_foreign_invoices_last_run::${monthRef}`
  const { data: lastRow } = await supabase
    .from('cervellone_config')
    .select('value')
    .eq('key', idemKey)
    .maybeSingle()
  if (lastRow?.value && !dry) {
    return NextResponse.json({ ok: true, skipped: 'already_run', last: lastRow.value })
  }

  try {
    const result = await runMonthlyForeignInvoices({ month_ref: monthRef, dry_run: dry })

    // Un giro e' SOSPETTO quando la casella non era vuota ma non e' uscito
    // nulla, quando la lettura non ha coperto tutto il mese, o quando non
    // c'era nemmeno un mittente configurato. Sono le tre forme che ha preso il
    // guasto rimasto muto da giugno a settembre 2026.
    const sospetto =
      result.nessun_risultato ||
      result.troncato ||
      result.whitelist_vuota ||
      result.caselle_fallite.length > 0 ||
      result.non_inoltrate.length > 0 ||
      result.errori_messaggio.length > 0 ||
      result.tempo_scaduto

    // Il lock si scrive solo se il giro e' andato a buon fine. Prima veniva
    // scritto SEMPRE, anche con zero inoltri: cosi' ogni mese si chiudeva su se
    // stesso e non si poteva piu' ritentare dopo aver corretto la
    // configurazione. La protezione dai doppioni resta comunque, perche' ogni
    // singola mail e' deduplicata per uid in cervellone_email_invoices_log.
    if (!dry && !sospetto) {
      await supabase
        .from('cervellone_config')
        .upsert({ key: idemKey, value: new Date().toISOString() })
    }
    if (RAFFAELE_CHAT_ID) {
      const senders = [...new Set(result.forwarded.map((f) => f.from))]
      const lines = [
        `✉️ Fatture estere Restruktura ${monthRef}${dry ? ' (PROVA)' : ''}: ${result.forwarded.length} inoltrate su ${result.esaminati} messaggi esaminati.`,
        result.forwarded.length > 0 ? `Mittenti: ${senders.join(', ')}` : '',
        // LO ZERO DEVE FARE RUMORE. Per quattro mesi il messaggio diceva
        // "0 inoltrate" e sembrava un mese senza fatture.
        result.nessun_risultato
          ? `🚨 ZERO fatture riconosciute su ${result.esaminati} messaggi del mese. Non e' normale: di solito ce ne sono. Probabile whitelist mittenti da aggiornare (cervellone_email_senders).`
          : '',
        result.whitelist_vuota
          ? '🚨 Nessun mittente configurato in cervellone_email_senders: il filtro non poteva far passare nulla.'
          : '',
        result.troncato
          ? `⚠️ Lettura parziale: ${result.totale_in_casella} messaggi nel mese, oltre il limite di lettura. Alcune fatture potrebbero non essere state viste.`
          : '',
        result.caselle_fallite.length > 0
          ? `🚨 Casella non raggiungibile: ${result.caselle_fallite.map((c) => `${c.casella} (${c.errore})`).join(' · ')}. Le fatture che c'erano lì NON sono state raccolte.`
          : '',
        result.tempo_scaduto
          ? '⚠️ Tempo esaurito: il giro si è chiuso prima di aver guardato tutto. Le fatture mancanti verranno riprese al prossimo tentativo (il mese resta aperto).'
          : '',
        result.scartate_senza_allegato.length > 0
          ? `⚠️ ${result.scartate_senza_allegato.length} mail da fornitori NOTI ma senza allegato: ${[...new Set(result.scartate_senza_allegato.map((s) => s.from))].join(', ')}. Forse ora mandano un link invece del PDF: da guardare a mano.`
          : '',
        result.errori_messaggio.length > 0
          ? `⚠️ ${result.errori_messaggio.length} messaggi finiti in errore: ${result.errori_messaggio.map((e) => `${e.casella}/${e.chiave} (${e.errore})`).join(' · ')}.`
          : '',
        result.non_inoltrate.length > 0
          ? `⚠️ ${result.non_inoltrate.length} fatture riconosciute ma NON inoltrate: ${result.non_inoltrate.map((f) => `${f.casella}/${f.chiave}`).join(', ')}.`
          : '',
        result.errori_registro.length > 0
          ? `⚠️ ${result.errori_registro.length} inoltri riusciti ma non registrati: il mese prossimo potrebbero ripartire doppi (${result.errori_registro.map((e) => `${e.casella}/${e.chiave}`).join(', ')}).`
          : '',
        result.fallback_warnings.length > 0
          ? `⚠️ ${result.fallback_warnings.length} mail con allegato e parola "fattura" ma mittente NON riconosciuto: ${[...new Set(result.fallback_warnings.map((f) => f.from))].slice(0, 6).join(', ')}. Aggiungili a cervellone_email_senders se è il caso.`
          : '',
        result.skipped_already_done.length > 0
          ? `Già fatte in un giro precedente: ${result.skipped_already_done.length}`
          : '',
        // Il dettaglio per casella: "3 inoltrate" non dice se una delle tre
        // caselle e' rimasta muta perche' vuota o perche' rotta.
        `Per casella — ${result.per_casella.map((c) => `${c.casella}: ${c.inoltrate}/${c.riconosciute} su ${c.esaminati} esaminati`).join(' · ')}`,
        sospetto && !dry ? 'Il mese resta aperto: si puo\' ritentare dopo aver corretto.' : '',
      ]
        .filter(Boolean)
        .join('\n')
      await sendTelegramMessage(Number(RAFFAELE_CHAT_ID), lines)
    }
    return NextResponse.json({ ok: true, sospetto, telegram_configurato: !!RAFFAELE_CHAT_ID, ...result })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (RAFFAELE_CHAT_ID) {
      await sendTelegramMessage(
        Number(RAFFAELE_CHAT_ID),
        `❌ Routine fatture estere ${monthRef} fallita: ${message}`,
      )
    }
    return NextResponse.json({ ok: false, error: message }, { status: 500 })
  }
}
