/**
 * Test della POST che salva un messaggio dal browser.
 *
 * Da quando il server non scrive piu la sua riga, questa route e l'UNICO punto
 * in cui il turno web entra nel database: qui devono avvenire la sanitizzazione
 * dei dati sensibili e la generazione dell'embedding. Se salta la prima, chiavi
 * API e carte di credito finiscono in chiaro nello storico.
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest'
import { getAuthToken } from '@/lib/doc-access'

beforeAll(() => { process.env.AUTH_SECRET = 'test-secret' })

// Cattura la riga realmente inserita
let rigaInserita: Record<string, unknown> | null = null

vi.mock('@/lib/supabase', () => ({
  supabase: {
    from: () => ({
      insert: (row: Record<string, unknown>) => {
        rigaInserita = row
        return {
          select: () => ({
            single: async () => ({ data: { id: 'msg-1', ...row }, error: null }),
          }),
        }
      },
      update: () => ({ eq: async () => ({ data: null, error: null }) }),
      // la route, per i messaggi 'user', rilegge il titolo della conversazione
      select: () => ({
        eq: () => ({ single: async () => ({ data: { title: 'Nuova conversazione' }, error: null }) }),
      }),
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

describe('POST /api/conversations/[id]/messages', () => {
  beforeEach(() => {
    rigaInserita = null
    saveEmbeddingOnlyMock.mockClear()
  })

  it('401 senza autenticazione', async () => {
    const { POST } = await import('./route')
    const res = await POST(req({ role: 'user', content: 'ciao' }), params)
    expect(res.status).toBe(401)
  })

  it('sanitizza il contenuto prima di scriverlo nel database', async () => {
    const { POST } = await import('./route')
    await POST(
      req({ role: 'user', content: 'la chiave e sk-ant-api03-abcdefghij1234567890xyz ok' }, getAuthToken()),
      params
    )

    expect(rigaInserita).not.toBeNull()
    const salvato = String(rigaInserita!.content)
    expect(salvato).toContain('[REDACTED]')
    expect(salvato).not.toContain('sk-ant-api03-abcdefghij1234567890xyz')
  })

  it('rifiuta un contenuto che non e una stringa invece di scriverlo grezzo', async () => {
    const { POST } = await import('./route')
    const res = await POST(
      req({ role: 'user', content: { testo: 'sk-ant-api03-abcdefghij1234567890xyz' } }, getAuthToken()),
      params
    )

    expect(res.status).toBe(400)
    expect(rigaInserita).toBeNull()
  })

  it('genera l embedding del testo sanitizzato', async () => {
    const { POST } = await import('./route')
    await POST(
      req({ role: 'assistant', content: 'Contenzioso Blasi: la controreplica poggia sull articolo 5.1 del contratto.' }, getAuthToken()),
      params
    )

    expect(saveEmbeddingOnlyMock).toHaveBeenCalledTimes(1)
    const [convId, role, testo] = saveEmbeddingOnlyMock.mock.calls[0]
    expect(convId).toBe('conv-1')
    expect(role).toBe('assistant')
    expect(String(testo)).toContain('Blasi')
  })
})
