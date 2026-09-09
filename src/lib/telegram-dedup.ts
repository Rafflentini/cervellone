/**
 * src/lib/telegram-dedup.ts — la riconsegna dello stesso messaggio non si
 * lavora due volte.
 *
 * Telegram rimanda lo stesso `message_id` quando la risposta HTTP tarda o
 * fallisce. La deduplica esisteva e in sei mesi ha retto — zero domande
 * duplicate su Telegram, contro 85 sul web — ma era scritta nella forma
 * LEGGI-POI-SCRIVI, con due difetti dentro:
 *
 * 1. **Nessuna atomicita' fra la lettura e la scrittura.** Due consegne
 *    simultanee leggono entrambe "non visto" e passano entrambe: turno intero
 *    duplicato, con i costi e le AZIONI che comporta — una mail inviata due
 *    volte non si annulla.
 * 2. **Falliva aperta.** Il fallback di `safeSupabase` era `[]`, che significa
 *    "non visto". Con Supabase in difficolta' la guardia non si limitava a non
 *    funzionare: diceva ATTIVAMENTE di procedere, e non lo distingueva da una
 *    risposta vera.
 *
 * La tabella ha gia' `PRIMARY KEY (chat_id, message_id)`: l'atomicita' era li'
 * dentro, bastava usarla. Si scrive PRIMA e si guarda l'esito. Un 23505 vuol
 * dire "gia' visto", e lo dice il database — non una lettura che puo' mentire.
 *
 * Sul comportamento col database in difficolta' la scelta resta la stessa di
 * prima, ma esplicita e a log: **si prosegue**. Perdere un messaggio
 * dell'Ingegnere e' peggio che rischiarne uno doppio, e in questo progetto una
 * perdita muta e' il difetto che paghiamo piu' caro. La differenza e' che
 * adesso lo si dice.
 */
import { supabase } from '@/lib/supabase'

/**
 * Segna il messaggio come preso in carico e dice se era GIA' stato visto.
 *
 * `true`  → riconsegna: il chiamante deve fermarsi.
 * `false` → messaggio nuovo (o database in difficolta'): si lavora.
 */
export async function messaggioGiaVisto(chatId: number, messageId: number): Promise<boolean> {
  try {
    const { error } = await supabase
      .from('telegram_dedup')
      .insert({ chat_id: chatId, message_id: messageId })

    if (!error) return false

    // 23505 = unique_violation sulla PRIMARY KEY: qualcuno l'ha gia' preso.
    if (error.code === '23505') return true

    console.warn(
      `[telegram] deduplica non disponibile (${error.message}): il messaggio ${messageId} viene lavorato lo stesso, potrebbe essere un doppione`,
    )
    return false
  } catch (err) {
    console.warn(
      `[telegram] deduplica non disponibile (${err instanceof Error ? err.message : 'errore'}): il messaggio ${messageId} viene lavorato lo stesso, potrebbe essere un doppione`,
    )
    return false
  }
}
