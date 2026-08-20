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

// Cattura le righe realmente inserite (plurale: serve a smascherare i duplicati)
let righeInserite: Record<string, unknown>[] = []
// Riga gia presente che la ricerca anti-duplicato deve trovare, se impostata
let duplicatoEsistente: { id: string } | null = null

vi.mock('@/lib/supabase', () => ({
  supabase: {
    from: (tabella: string) => ({
      insert: (row: Record<string, unknown>) => {
        righeInserite.push(row)
        return {
          select: () => ({
            single: async () => ({ data: { id: 'msg-1', ...row }, error: null }),
          }),
        }
      },
      update: () => ({ eq: async () => ({ data: null, error: null }) }),
      select: () => {
        if (tabella === 'messages') {
          // catena della ricerca anti-duplicato: .eq().eq().eq().gte().limit().maybeSingle()
          const b: Record<string, unknown> = {}
          b.eq = () => b
          b.gte = () => b
          b.limit = () => b
          b.maybeSingle = async () => ({ data: duplicatoEsistente, error: null })
          return b
        }
        // la route, per i messaggi 'user', rilegge il titolo della conversazione
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

describe('POST /api/conversations/[id]/messages', () => {
  beforeEach(() => {
    righeInserite = []
    duplicatoEsistente = null
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

    expect(righeInserite).toHaveLength(1)
    const salvato = String(righeInserite[0].content)
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
    expect(righeInserite).toHaveLength(0)
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

/**
 * Il browser, quando la pagina muore a meta risposta, invia con sendBeacon il
 * testo gia ricevuto. Ma il salvataggio normale potrebbe essere gia partito:
 * senza una difesa qui si ricreerebbe il doppio salvataggio appena eliminato.
 * La difesa sta sul SERVER, perche e l'unico punto che vede tutte le scritture.
 */
describe('POST — difesa contro il doppio salvataggio', () => {
  beforeEach(() => {
    righeInserite = []
    duplicatoEsistente = null
    saveEmbeddingOnlyMock.mockClear()
  })

  it('scarta il salvataggio d emergenza se quel testo e gia stato salvato', async () => {
    duplicatoEsistente = { id: 'msg-gia-salvato' }

    const { POST } = await import('./route')
    const res = await POST(
      req({ role: 'assistant', content: 'Contenzioso Blasi: la controreplica poggia sull articolo 5.1.', emergenza: true }, getAuthToken()),
      params
    )

    expect(res.status).toBe(200)
    expect(righeInserite).toHaveLength(0)
    expect(saveEmbeddingOnlyMock).not.toHaveBeenCalled()
  })

  // Questo e il test che mancava, e la sua assenza nascondeva un difetto vero:
  // una difesa basata sul confronto del contenuto, applicata a TUTTI i messaggi,
  // scarterebbe un "ok" o un "procedi" scritti due volte in cinque minuti.
  // Sarebbe una perdita muta di dati legittimi dentro il lavoro che elimina le
  // perdite mute. La difesa vale SOLO per i salvataggi d emergenza.
  it('NON scarta un messaggio normale ripetuto, anche se identico e recente', async () => {
    duplicatoEsistente = { id: 'msg-ok-precedente' }

    const { POST } = await import('./route')
    await POST(req({ role: 'user', content: 'ok' }, getAuthToken()), params)
    expect(righeInserite).toHaveLength(1)

    await POST(req({ role: 'user', content: 'ok' }, getAuthToken()), params)
    expect(righeInserite).toHaveLength(2)
  })

  it('NON scarta una risposta breve ripetuta del bot su un altro argomento', async () => {
    duplicatoEsistente = { id: 'msg-fatto-precedente' }

    const { POST } = await import('./route')
    await POST(req({ role: 'assistant', content: 'Fatto.' }, getAuthToken()), params)

    expect(righeInserite).toHaveLength(1)
  })

  it('un contenuto diverso viene invece salvato normalmente', async () => {
    duplicatoEsistente = null

    const { POST } = await import('./route')
    await POST(
      req({ role: 'assistant', content: 'Un testo completamente diverso dal precedente, abbastanza lungo.' }, getAuthToken()),
      params
    )

    expect(righeInserite).toHaveLength(1)
  })
})
