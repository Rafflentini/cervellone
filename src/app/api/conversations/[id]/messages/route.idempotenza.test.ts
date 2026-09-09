/**
 * src/app/api/conversations/[id]/messages/route.idempotenza.test.ts
 *
 * Telegram deduplica gli invii su `(chat_id, message_id)` — `telegram_dedup`,
 * con una PRIMARY KEY, quindi atomica. Il web non aveva NIENTE: ne' vincolo,
 * ne' chiave, ne' confronto. E' una divergenza fra i due canali, e nel dato si
 * vedeva: 85 domande dell'Ingegnere scritte due volte, contro 0 su Telegram.
 *
 * La dedup giusta NON e' sul contenuto — quella scarterebbe un "ok" ripetuto
 * legittimamente, ed e' la perdita muta che `route.ts` vieta a ragione. E'
 * sulla CHIAVE D'INVIO: il client conia un id per ogni invio, e un id gia'
 * visto non entra due volte.
 *
 * ⭐ Il mock qui sotto fa rispettare il vincolo VERO (indice unico parziale,
 * violazione 23505 di Postgres). Un mock che accetta tutto direbbe verde su un
 * codice senza difesa.
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest'
import { getAuthToken } from '@/lib/doc-access'

beforeAll(() => { process.env.AUTH_SECRET = 'test-secret' })

let righeInserite: Record<string, unknown>[] = []

/** Riproduce `uniq_messages_client_msg_id`: (conversation_id, client_msg_id). */
function violaIndiceUnico(row: Record<string, unknown>): boolean {
  if (!row.client_msg_id) return false // l'indice e' PARZIALE: senza chiave non vincola
  return righeInserite.some(
    r => r.conversation_id === row.conversation_id && r.client_msg_id === row.client_msg_id,
  )
}

vi.mock('@/lib/supabase', () => ({
  supabase: {
    from: (tabella: string) => ({
      insert: (row: Record<string, unknown>) => {
        const duplicata = violaIndiceUnico(row)
        if (!duplicata) righeInserite.push(row)
        return {
          select: () => ({
            single: async () =>
              duplicata
                ? {
                    data: null,
                    // Postgres non lancia attraverso supabase-js: l'errore torna qui.
                    error: {
                      code: '23505',
                      message:
                        'duplicate key value violates unique constraint "uniq_messages_client_msg_id"',
                    },
                  }
                : { data: { id: 'msg-1', ...row }, error: null },
          }),
        }
      },
      update: () => ({ eq: async () => ({ data: null, error: null }) }),
      select: () => {
        if (tabella === 'messages') {
          const b: Record<string, unknown> = {}
          b.eq = () => b
          b.gte = () => b
          b.limit = () => b
          b.maybeSingle = async () => ({ data: null, error: null })
          return b
        }
        return {
          eq: () => ({ single: async () => ({ data: { title: 'Nuova conversazione' }, error: null }) }),
        }
      },
    }),
  },
}))

const saveEmbeddingOnlyMock = vi.fn().mockResolvedValue(undefined)
vi.mock('@/lib/memory', () => ({
  saveEmbeddingOnly: (...args: unknown[]) => saveEmbeddingOnlyMock(...args),
}))

function req(body: unknown, cookie?: string) {
  return {
    cookies: { get: () => (cookie ? { value: cookie } : undefined) },
    json: async () => body,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any
}

const params = { params: Promise.resolve({ id: 'conv-1' }) }

describe('POST — la chiave d invio rende il salvataggio idempotente', () => {
  beforeEach(() => {
    righeInserite = []
    saveEmbeddingOnlyMock.mockClear()
  })

  it('lo stesso invio ripetuto scrive UNA riga sola', async () => {
    const { POST } = await import('./route')
    const invio = { role: 'user', content: 'Fammi il SAL 1 della C2026-008', clientMsgId: 'invio-abc' }

    await POST(req(invio, getAuthToken()), params)
    await POST(req(invio, getAuthToken()), params)

    expect(righeInserite).toHaveLength(1)
  })

  it('il secondo invio NON e un errore per chi lo manda', async () => {
    // Se il browser ritenta e riceve un 500, mostra un guasto che non c'e':
    // la domanda e' salvata. Un doppione respinto e' un successo, non un errore.
    const { POST } = await import('./route')
    const invio = { role: 'user', content: 'Fammi il SAL 1 della C2026-008', clientMsgId: 'invio-abc' }

    await POST(req(invio, getAuthToken()), params)
    const seconda = await POST(req(invio, getAuthToken()), params)

    expect(seconda.status).toBe(200)
  })

  it('CONTROLLO POSITIVO: due invii DIVERSI con lo stesso testo restano due righe', async () => {
    // E' il caso legittimo che una dedup sul contenuto distruggerebbe:
    // l'Ingegnere che scrive "ok" due volte davvero.
    const { POST } = await import('./route')

    await POST(req({ role: 'user', content: 'ok', clientMsgId: 'invio-1' }, getAuthToken()), params)
    await POST(req({ role: 'user', content: 'ok', clientMsgId: 'invio-2' }, getAuthToken()), params)

    expect(righeInserite).toHaveLength(2)
  })

  it('una scheda vecchia, che non manda la chiave, viene salvata lo stesso', async () => {
    // Nessuna modifica al client raggiunge una scheda gia' aperta: e' la
    // lezione dell'8 set 2026. Senza chiave si scrive come prima — l'indice e'
    // PARZIALE proprio per questo.
    const { POST } = await import('./route')

    await POST(req({ role: 'user', content: 'domanda da un bundle vecchio' }, getAuthToken()), params)
    await POST(req({ role: 'user', content: 'un altra domanda vecchia' }, getAuthToken()), params)

    expect(righeInserite).toHaveLength(2)
  })
})
