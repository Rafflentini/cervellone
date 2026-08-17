import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { NextRequest } from 'next/server'

/**
 * BUG B-bis — il cron promemoria leggeva le scadenze con una select SENZA
 * `.limit()` e SENZA paginazione: oltre il row-cap di PostgREST le scadenze in
 * coda non ricevevano MAI il promemoria e il JSON di risposta riportava
 * `checked` = conteggio della pagina troncata, come se fosse il totale.
 *
 * Qui la paginazione e preferibile al "limite + avviso" di lista_scadenze:
 * nessun umano legge l'output del cron, quindi non basta segnalare il
 * troncamento, vanno processate tutte.
 */

// Range richiesti dal codice sotto test, nell'ordine.
const rangeCalls: Array<[number, number]> = []
// Pagine che il "server" restituisce.
let pagine: unknown[][] = []
// Se valorizzata, il "server" restituisce SEMPRE questa pagina piena: simula
// un server che non smette mai di avere righe (o un range che non avanza).
let paginaInfinita: unknown[] | null = null

function makeBuilder() {
  let ranged = false
  const builder: Record<string, unknown> = {}
  const self = () => builder
  for (const m of ['select', 'eq', 'gte', 'order']) builder[m] = self
  builder.range = (from: number, to: number) => {
    rangeCalls.push([from, to])
    ranged = true
    return builder
  }
  builder.then = (resolve: (v: unknown) => void) => {
    if (paginaInfinita) {
      return Promise.resolve({ data: paginaInfinita, error: null }).then(resolve)
    }
    // Senza .range() si simula il row-cap di PostgREST: solo la prima pagina.
    const idx = ranged ? rangeCalls.length - 1 : 0
    return Promise.resolve({ data: pagine[idx] ?? [], error: null }).then(resolve)
  }
  return builder
}

vi.mock('@/lib/supabase', () => ({
  supabase: { from: () => makeBuilder() },
}))

vi.mock('@/v19/tools/email/send-email', () => ({
  sendEmailInternal: vi.fn(async () => ({ ok: true, messageId: 'x' })),
}))

function cronRequest(): NextRequest {
  return {
    headers: { get: (name: string) => (name === 'authorization' ? `Bearer ${process.env.CRON_SECRET}` : null) },
  } as unknown as NextRequest
}

// Scadenze lontane: nessun promemoria parte, il test guarda solo la lettura.
function riga(i: number) {
  return {
    id: `s-${i}`, soggetto: `Soggetto ${i}`, categoria: 'personale',
    tipo_documento: 'attestato', data_scadenza: '2030-01-01', reminder_days: 5,
    recipients: [], drive_url: null, reminders_sent: [],
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  rangeCalls.length = 0
  paginaInfinita = null
  process.env.CRON_SECRET = 'test-secret'
})

describe('cron scadenze', () => {
  it('pagina le scadenze invece di fermarsi alla prima pagina', async () => {
    pagine = [
      Array.from({ length: 500 }, (_, i) => riga(i)),        // pagina piena
      Array.from({ length: 200 }, (_, i) => riga(500 + i)),  // pagina parziale -> stop
    ]

    const { GET } = await import('./route')
    const res = await GET(cronRequest())
    const body = await res.json()

    expect(body.ok).toBe(true)
    expect(rangeCalls).toEqual([[0, 499], [500, 999]])
    expect(body.checked).toBe(700)
  })

  it('si ferma alla prima pagina quando non e piena (controprova)', async () => {
    pagine = [Array.from({ length: 3 }, (_, i) => riga(i))]

    const { GET } = await import('./route')
    const res = await GET(cronRequest())
    const body = await res.json()

    expect(rangeCalls).toEqual([[0, 499]])
    expect(body.checked).toBe(3)
  })

  it('non gira all infinito se le pagine non finiscono mai, e lo dichiara', async () => {
    // Server che restituisce sempre una pagina piena: senza tetto il loop
    // interroga il DB indefinitamente dentro una route con maxDuration 120.
    paginaInfinita = Array.from({ length: 500 }, (_, i) => riga(i))

    const { GET } = await import('./route')
    const res = await GET(cronRequest())
    const body = await res.json()

    expect(body.ok).toBe(true)
    expect(rangeCalls.length).toBe(40)
    expect(rangeCalls[39]).toEqual([19500, 19999])
    // Il tetto e comunque un troncamento: va dichiarato, non subito in silenzio.
    expect(body.troncato).toBe(true)
  })

  it('non dichiara troncamento quando le pagine finiscono (controprova)', async () => {
    pagine = [Array.from({ length: 3 }, (_, i) => riga(i))]

    const { GET } = await import('./route')
    const res = await GET(cronRequest())
    const body = await res.json()

    expect(body.troncato).toBe(false)
  })

  it('rifiuta la richiesta senza il CRON_SECRET giusto', async () => {
    pagine = []
    const { GET } = await import('./route')
    const res = await GET({
      headers: { get: () => 'Bearer sbagliato' },
    } as unknown as NextRequest)

    expect(res.status).toBe(401)
    // e non ha nemmeno provato a leggere il DB
    expect(rangeCalls).toEqual([])
  })
})
