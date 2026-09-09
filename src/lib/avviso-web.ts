/**
 * src/lib/avviso-web.ts — un avviso di sistema nelle conversazioni web.
 *
 * Due punti annunciano qualcosa scrivendo `role='assistant'` nelle ultime 5
 * conversazioni web: il cambio di modello (`tools/self.ts`) e il rollback del
 * circuit breaker (`circuit-breaker.ts`). Non passano dalla rotta protetta dal
 * 409 — quella guardia vale per il browser, non per il codice del server — e
 * nessuno dei due aveva una difesa efficace contro il doppio invio:
 *
 * - il throttle del breaker e' un `let` in memoria di modulo, e su Vercel ogni
 *   istanza serverless ha il suo; per giunta tutti i chiamanti lo scavalcano
 *   con `force = true`;
 * - il cambio modello non ha throttle di nessun tipo.
 *
 * Due esecuzioni concorrenti scrivevano percio' lo stesso avviso due volte
 * nelle stesse conversazioni. Nei dati non e' ancora successo, ma la strada era
 * aperta e il 9 set 2026 abbiamo appena finito di ripulire 151 righe nate da
 * strade come questa.
 *
 * La difesa e' la stessa della chat web: una CHIAVE D'INVIO, che l'indice unico
 * parziale `uniq_messages_client_msg_id` fa valere nel database. Qui la chiave
 * non puo' essere coniata a caso — due lambda diverse devono arrivare alla
 * STESSA chiave per lo stesso avviso — quindi si deriva dal testo.
 *
 * La regola sta in questo modulo, una volta sola: i chiamanti sono due, e in
 * questo repo una regola scritta due volte e' finita per divergere ogni volta.
 */
import crypto from 'crypto'
import { supabase } from '@/lib/supabase'

/**
 * Chiave deterministica per un avviso: impronta del testo + l'ORA in cui cade.
 *
 * Il solo testo non basta: un breaker che scatta di nuovo la settimana dopo e'
 * un fatto NUOVO e va detto, mentre una chiave fatta col solo contenuto
 * renderebbe l'avviso muto per sempre dopo la prima volta. La finestra di
 * un'ora tiene insieme le due esigenze — due istanze che scattano sullo stesso
 * guasto cadono nella stessa ora, un guasto nuovo no.
 */
export function chiaveAvviso(testo: string, adesso: Date = new Date()): string {
  const impronta = crypto.createHash('md5').update(testo).digest('hex').slice(0, 16)
  const ora = adesso.toISOString().slice(0, 13) // YYYY-MM-DDTHH
  return `avviso:${impronta}:${ora}`
}

/**
 * Scrive `testo` come messaggio dell'assistente nelle ultime 5 conversazioni
 * web. Non lancia mai: un avviso e' un di piu', e non deve poter far cadere il
 * lavoro che lo ha generato.
 */
export async function avvisaConversazioniWeb(testo: string, adesso?: Date): Promise<void> {
  try {
    const { data } = await supabase
      .from('conversations')
      .select('id')
      .neq('title', '💬 Telegram')
      .order('created_at', { ascending: false })
      .limit(5)

    if (!data || data.length === 0) return

    const chiave = chiaveAvviso(testo, adesso)
    const { error } = await supabase.from('messages').insert(
      data.map((c: { id: string }) => ({
        conversation_id: c.id,
        role: 'assistant',
        content: testo,
        client_msg_id: chiave,
      })),
    )

    // 23505 = l'avviso c'e' gia'. Non e' un guasto: e' esattamente il lavoro
    // che questo modulo deve fare.
    if (error && error.code !== '23505') {
      console.error('[avviso-web] scrittura fallita:', error.message)
    }
  } catch (err) {
    console.error('[avviso-web] scrittura fallita:', err)
  }
}
