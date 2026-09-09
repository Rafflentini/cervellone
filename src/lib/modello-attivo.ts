/**
 * src/lib/modello-attivo.ts — quale modello sta usando il bot, e come cambiarlo.
 *
 * Il valore e' GLOBALE: sta in `cervellone_config`, uno per tutto il sistema.
 * Ma si poteva vedere e cambiare SOLO da Telegram, con `/opus`, `/sonnet` e
 * `/modello`. Chi lavorava dalla chat web subiva in silenzio il modello scelto
 * sull'altro canale, senza modo di sapere quale fosse ne' di riportarlo su
 * Sonnet quando l'ora di Opus era finita.
 *
 * Qui la logica sta una volta sola, e sopra ci sta un TOOL: `getToolDefinitions()`
 * non conosce i canali, quindi nasce equipollente per costruzione.
 */
import { supabase } from './supabase'
import { OPUS_MODEL, SONNET_MODEL, computeOpusUntil } from './opus-ttl'

export type SceltaModello = 'opus' | 'sonnet'

function oraDiRoma(iso: string): string {
  return new Date(iso).toLocaleTimeString('it-IT', {
    hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Rome',
  })
}

/** Il modello attivo, e fino a quando se e' un'ora di Opus ancora in corso. */
export async function leggiModelloAttivo(): Promise<string> {
  const { data } = await supabase
    .from('cervellone_config')
    .select('key, value')
    .in('key', ['model_default', 'opus_until'])

  let modello = 'sconosciuto'
  let fino: string | undefined
  for (const riga of (data ?? []) as Array<{ key: string; value: string }>) {
    const v = String(riga.value).replace(/"/g, '')
    if (riga.key === 'model_default') modello = v
    else if (riga.key === 'opus_until') fino = v
  }

  let testo = `🧠 Modello attivo: ${modello}`
  // Un'ora di Opus GIA' SCADUTA non si annuncia come in corso: il cron la
  // riporta su Sonnet, e dire il contrario e' peggio che non dire niente.
  if (fino && modello.includes('opus')) {
    const quando = new Date(fino)
    if (!Number.isNaN(quando.getTime()) && quando > new Date()) {
      testo += ` (Opus fino alle ${oraDiRoma(fino)})`
    }
  }
  return testo
}

/**
 * Cambia il modello per TUTTI e due i canali. `minuti` vale solo per Opus:
 * scaduti quelli, il cron riporta su Sonnet da solo.
 */
export async function impostaModello(scelta: SceltaModello, minuti = 60): Promise<string> {
  if (scelta !== 'opus' && scelta !== 'sonnet') {
    return '⛔ Modello non riconosciuto. I due possibili sono "opus" e "sonnet".'
  }

  const modello = scelta === 'opus' ? OPUS_MODEL : SONNET_MODEL
  const daChi = 'tool imposta_modello'

  await supabase.from('cervellone_config').update({ value: modello, updated_by: daChi }).eq('key', 'model_default')
  await supabase.from('cervellone_config').update({ value: modello, updated_by: daChi }).eq('key', 'model_active')

  if (scelta === 'opus') {
    const fino = computeOpusUntil(new Date(), minuti)
    await supabase.from('cervellone_config').upsert({ key: 'opus_until', value: fino, updated_by: daChi }, { onConflict: 'key' })
    await svuotaLeCache()
    return `🧠 Modello: Opus (massima potenza) per ${minuti} min — fino alle ${oraDiRoma(fino)}, poi torno su Sonnet da solo.`
  }

  await supabase.from('cervellone_config').delete().eq('key', 'opus_until')
  await svuotaLeCache()
  return '⚡ Modello: Sonnet (veloce).'
}

/**
 * Senza questo il cambio non ha effetto fino alla scadenza delle cache: il
 * modello resterebbe quello vecchio mentre il database dice il contrario.
 */
async function svuotaLeCache(): Promise<void> {
  const { invalidateConfigCache } = await import('./claude')
  invalidateConfigCache()
  const { invalidateCache } = await import('./circuit-breaker')
  invalidateCache()
}
