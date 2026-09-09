/**
 * src/lib/telegram-dedup.test.ts
 *
 * Telegram riconsegna lo stesso `message_id` quando la risposta HTTP tarda o
 * fallisce. La deduplica c'era e in sei mesi ha retto — zero domande duplicate
 * su Telegram, contro 85 sul web — ma era scritta nella forma LEGGI-POI-SCRIVI:
 *
 *     const existing = await safeSupabase(() => supabase.from('telegram_dedup')
 *       .select('message_id').eq('chat_id', chatId).eq('message_id', msgId), [])
 *     if (existing.length > 0) return ok
 *     await safeSupabase(() => supabase.from('telegram_dedup').insert(...))
 *
 * Due difetti in quelle quattro righe:
 *
 * 1. Fra la lettura e la scrittura non c'e' atomicita': due consegne simultanee
 *    leggono entrambe "non visto" e passano entrambe — turno intero duplicato,
 *    con i costi e le azioni che comporta (una mail inviata due volte).
 * 2. Il fallback di `safeSupabase` e' `[]`, che significa "non visto". Con
 *    Supabase in difficolta' la guardia non si limita a non funzionare: dice
 *    ATTIVAMENTE di procedere. E' una guardia che fallisce aperta.
 *
 * La tabella ha gia' `PRIMARY KEY (chat_id, message_id)`: l'atomicita' e' li',
 * bastava usarla. Si scrive PRIMA e si guarda l'esito — un 23505 vuol dire
 * "gia' visto", e lo dice il database, non una lettura che puo' mentire.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

let righeDedup: { chat_id: number; message_id: number }[] = []
/** Se impostato, ogni insert fallisce cosi: simula Supabase in difficolta'. */
let guastoDb: { code?: string; message: string } | null = null

vi.mock('@/lib/supabase', () => ({
  supabase: {
    from: () => ({
      insert: async (row: { chat_id: number; message_id: number }) => {
        if (guastoDb) return { data: null, error: guastoDb }
        const gia = righeDedup.some(
          r => r.chat_id === row.chat_id && r.message_id === row.message_id,
        )
        if (gia) {
          // La PRIMARY KEY (chat_id, message_id) parla: Postgres non lancia
          // attraverso supabase-js, l'errore torna qui.
          return {
            data: null,
            error: {
              code: '23505',
              message: 'duplicate key value violates unique constraint "telegram_dedup_pkey"',
            },
          }
        }
        righeDedup.push(row)
        return { data: null, error: null }
      },
    }),
  },
}))

import { messaggioGiaVisto } from './telegram-dedup'

describe('deduplica delle riconsegne di Telegram', () => {
  beforeEach(() => {
    righeDedup = []
    guastoDb = null
    vi.clearAllMocks()
  })

  it('un messaggio nuovo non risulta gia visto', async () => {
    expect(await messaggioGiaVisto(111, 5001)).toBe(false)
  })

  it('la RICONSEGNA dello stesso messaggio risulta gia vista', async () => {
    await messaggioGiaVisto(111, 5001)
    expect(await messaggioGiaVisto(111, 5001)).toBe(true)
  })

  it('due consegne SIMULTANEE: una sola passa', async () => {
    // E' il caso che la forma leggi-poi-scrivi lasciava passare: entrambe
    // leggevano "non visto" prima che l'altra scrivesse.
    const [a, b] = await Promise.all([
      messaggioGiaVisto(111, 5001),
      messaggioGiaVisto(111, 5001),
    ])

    expect([a, b].filter(visto => visto === false)).toHaveLength(1)
  })

  it('CONTROLLO POSITIVO: messaggi diversi passano tutti', async () => {
    // Senza questo, i test sopra passerebbero anche con un codice che
    // risponde sempre "gia visto" e blocca ogni messaggio.
    expect(await messaggioGiaVisto(111, 5001)).toBe(false)
    expect(await messaggioGiaVisto(111, 5002)).toBe(false)
    expect(await messaggioGiaVisto(222, 5001)).toBe(false)
  })

  it('con il database in difficolta il messaggio passa, ma lo si DICE', async () => {
    // Scelta esplicita: perdere un messaggio dell'Ingegnere e' peggio che
    // rischiarne uno doppio. Ma non deve piu' accadere in silenzio: prima il
    // fallback `[]` diceva "non visto" senza distinguerlo da una risposta vera.
    const avvisi = vi.spyOn(console, 'warn').mockImplementation(() => {})
    guastoDb = { message: 'Supabase unreachable' }

    expect(await messaggioGiaVisto(111, 5001)).toBe(false)
    expect(avvisi).toHaveBeenCalled()

    avvisi.mockRestore()
  })
})
