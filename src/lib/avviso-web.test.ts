/**
 * src/lib/avviso-web.test.ts
 *
 * Due punti del codice annunciano qualcosa scrivendo direttamente nelle ultime
 * 5 conversazioni web: `notifyModelChange` (tools/self.ts) e `notifyAdmin` del
 * circuit breaker. Nessuno dei due passava dalla rotta protetta dal 409, e
 * nessuno dei due aveva una difesa efficace contro il doppio invio:
 *
 * - il throttle del breaker e' un `let lastNotifyAt` in memoria di modulo, e su
 *   Vercel ogni istanza serverless ha il suo — per giunta tutti i chiamanti lo
 *   scavalcano con `force = true`;
 * - `notifyModelChange` non ha throttle di nessun tipo.
 *
 * Due lambda concorrenti scrivono quindi lo stesso avviso due volte, nelle
 * stesse 5 conversazioni. Non e' ancora successo nei dati, ma la strada e'
 * aperta.
 *
 * La cura usa la chiave d'invio del 9 set 2026: l'avviso porta una chiave
 * DETERMINISTICA, e l'indice unico parziale `uniq_messages_client_msg_id`
 * respinge il gemello. La regola sta qui, in un modulo solo, perche' i due
 * chiamanti sono due e una regola scritta due volte prima o poi diverge.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

let righeInserite: Record<string, unknown>[] = []
let conversazioni: { id: string }[] = []

function violaIndiceUnico(row: Record<string, unknown>): boolean {
  if (!row.client_msg_id) return false
  return righeInserite.some(
    r => r.conversation_id === row.conversation_id && r.client_msg_id === row.client_msg_id,
  )
}

vi.mock('@/lib/supabase', () => ({
  supabase: {
    from: (tabella: string) => {
      if (tabella === 'conversations') {
        const b: Record<string, unknown> = {}
        b.select = () => b
        b.neq = () => b
        b.order = () => b
        b.limit = async () => ({ data: conversazioni, error: null })
        return b
      }
      return {
        insert: async (rows: Record<string, unknown>[]) => {
          const nuove = rows.filter(r => !violaIndiceUnico(r))
          if (nuove.length !== rows.length) {
            // Postgres rifiuta l'INTERO batch se una riga viola il vincolo.
            return {
              data: null,
              error: {
                code: '23505',
                message: 'duplicate key value violates unique constraint "uniq_messages_client_msg_id"',
              },
            }
          }
          righeInserite.push(...rows)
          return { data: null, error: null }
        },
      }
    },
  },
}))

import { avvisaConversazioniWeb, chiaveAvviso } from './avviso-web'

const TESTO = '⚠️ *Rollback automatico* — il modello e stato riportato alla versione precedente perche tre turni di fila sono falliti.'

describe('avviso alle conversazioni web', () => {
  beforeEach(() => {
    righeInserite = []
    conversazioni = [{ id: 'conv-1' }, { id: 'conv-2' }]
  })

  it('scrive l avviso in tutte le conversazioni web recenti', async () => {
    await avvisaConversazioniWeb(TESTO)

    expect(righeInserite).toHaveLength(2)
    expect(righeInserite.map(r => r.conversation_id)).toEqual(['conv-1', 'conv-2'])
  })

  it('lo stesso avviso mandato due volte non si duplica', async () => {
    // Due lambda concorrenti che scattano sullo stesso guasto.
    await avvisaConversazioniWeb(TESTO)
    await avvisaConversazioniWeb(TESTO)

    expect(righeInserite).toHaveLength(2)
  })

  it('CONTROLLO POSITIVO: un avviso DIVERSO passa', async () => {
    // Senza questo, il test sopra passerebbe anche con un codice che non
    // scrive mai niente dopo la prima volta.
    await avvisaConversazioniWeb(TESTO)
    await avvisaConversazioniWeb('🆕 *Cervellone aggiornato* — il modello predefinito e cambiato.')

    expect(righeInserite).toHaveLength(4)
  })

  it('ogni riga porta la chiave, cosi il vincolo del database puo lavorare', async () => {
    await avvisaConversazioniWeb(TESTO)

    for (const riga of righeInserite) {
      expect(riga.client_msg_id).toBeTruthy()
    }
  })

  it('la chiave cambia col passare del tempo, cosi un guasto NUOVO viene annunciato', async () => {
    // Un breaker che scatta di nuovo la settimana dopo e' un fatto nuovo, e va
    // detto. La chiave non puo' essere il solo testo, o l'avviso sarebbe muto
    // per sempre dopo la prima volta.
    const ora = chiaveAvviso(TESTO, new Date('2026-09-09T10:00:00Z'))
    const stessaOra = chiaveAvviso(TESTO, new Date('2026-09-09T10:59:00Z'))
    const oraDopo = chiaveAvviso(TESTO, new Date('2026-09-09T11:00:00Z'))

    expect(ora).toBe(stessaOra)
    expect(ora).not.toBe(oraDopo)
  })

  it('senza conversazioni web non scrive niente e non esplode', async () => {
    conversazioni = []
    await expect(avvisaConversazioniWeb(TESTO)).resolves.not.toThrow()
    expect(righeInserite).toHaveLength(0)
  })
})
