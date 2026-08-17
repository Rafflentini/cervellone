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
// Order richiesti dal codice sotto test, nell'ordine (chiave + opzioni).
let orderCalls: Array<[string, unknown]> = []
// UPDATE eseguiti dal codice sotto test (payload + filtri).
let updateCalls: Array<{ payload: unknown; filters: Array<[string, unknown[]]> }> = []
// Pagine che il "server" restituisce.
let pagine: unknown[][] = []
// Se valorizzata, il "server" restituisce SEMPRE questa pagina piena: simula
// un server che non smette mai di avere righe (o un range che non avanza).
let paginaInfinita: unknown[] | null = null
// Indice (0-based) della pagina su cui il "server" restituisce un errore.
let erroreAllaPagina: number | null = null

function makeBuilder() {
  let ranged = false
  let update: { payload: unknown; filters: Array<[string, unknown[]]> } | null = null
  const builder: Record<string, unknown> = {}
  const self = () => builder
  for (const m of ['select', 'gte']) builder[m] = self
  builder.eq = (...args: unknown[]) => {
    if (update) update.filters.push(['eq', args])
    return builder
  }
  builder.order = (col: string, opts?: unknown) => {
    orderCalls.push([col, opts])
    return builder
  }
  builder.update = (payload: unknown) => {
    update = { payload, filters: [] }
    updateCalls.push(update)
    return builder
  }
  builder.range = (from: number, to: number) => {
    rangeCalls.push([from, to])
    ranged = true
    return builder
  }
  builder.then = (resolve: (v: unknown) => void) => {
    // Un UPDATE non legge pagine: risponde solo "scritto".
    if (update) return Promise.resolve({ data: null, error: null }).then(resolve)
    // Senza .range() si simula il row-cap di PostgREST: solo la prima pagina.
    const idx = ranged ? rangeCalls.length - 1 : 0
    if (erroreAllaPagina !== null && idx === erroreAllaPagina) {
      return Promise.resolve({ data: null, error: { message: 'PostgREST 500' } }).then(resolve)
    }
    if (paginaInfinita) {
      return Promise.resolve({ data: paginaInfinita, error: null }).then(resolve)
    }
    return Promise.resolve({ data: pagine[idx] ?? [], error: null }).then(resolve)
  }
  return builder
}

vi.mock('@/lib/supabase', () => ({
  supabase: { from: () => makeBuilder() },
}))

vi.mock('@/v19/tools/email/send-email', () => ({
  // Forma REALE della risposta: la route guarda `status`, non `ok`. Con un mock
  // che non lo espone il ramo "reminder marcato" non verrebbe mai eseguito.
  sendEmailInternal: vi.fn(async () => ({ status: 'sent', message_id: 'msg-1' })),
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

// Stesso calcolo della route (`todayISO`): le date NON vanno hardcodate o il
// test scade col tempo — una scadenza "fra 3 giorni" scritta a mano diventa
// passata, `days < 0`, e il ramo che manda le mail smette di essere esercitato.
function todayRomeISO(): string {
  return new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Rome' })
}

function traGiorni(n: number): string {
  const [y, m, d] = todayRomeISO().split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10)
}

// Scadenza DENTRO la finestra reminder: questa fa partire davvero la mail.
function rigaInScadenza(id: string, fraGiorni = 3) {
  return {
    id, soggetto: `Soggetto ${id}`, categoria: 'personale',
    tipo_documento: 'attestato', data_scadenza: traGiorni(fraGiorni), reminder_days: 5,
    recipients: ['tizio@restruktura.it'], drive_url: null, reminders_sent: [],
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  rangeCalls.length = 0
  orderCalls = []
  updateCalls = []
  // Senza questo reset la configurazione del "server" resta quella del test
  // precedente: un test che non imposta `pagine` leggerebbe le righe altrui.
  pagine = []
  paginaInfinita = null
  erroreAllaPagina = null
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

  // ── Il ramo che manda DAVVERO le mail ────────────────────────────────────
  // Tutti i test sopra usano scadenze al 2030: `days > reminder_days` → il loop
  // fa `continue` su OGNI riga e il ramo di invio non viene MAI eseguito.
  // Provano che le righe sono LETTE, non che siano PROCESSATE: la tesi del
  // commit ("oltre il row-cap le scadenze in coda non ricevono MAI il
  // promemoria") resta senza test finche una riga di PAGINA 2 non riceve la mail.

  it('manda il promemoria a una scadenza che sta in PAGINA 2 (tesi del commit)', async () => {
    const { sendEmailInternal } = await import('@/v19/tools/email/send-email')
    pagine = [
      Array.from({ length: 500 }, (_, i) => riga(i)),  // pagina piena, tutte lontane
      [rigaInScadenza('oltre-il-cap', 3)],             // pagina 2: unica riga in finestra
    ]

    const { GET } = await import('./route')
    const res = await GET(cronRequest())
    const body = await res.json()

    expect(body.ok).toBe(true)
    expect(rangeCalls).toEqual([[0, 499], [500, 999]])
    // Senza paginazione questa riga non sarebbe mai stata nemmeno letta.
    expect(body.reminded).toBe(1)
    expect(sendEmailInternal).toHaveBeenCalledTimes(1)
    expect(body.details.map((d: { id: string }) => d.id)).toEqual(['oltre-il-cap'])
    expect(body.details[0].days_until).toBe(3)
    expect(body.details[0].recipients[0]).toMatchObject({ to: 'tizio@restruktura.it', status: 'sent' })
    // Invio riuscito → la riga viene marcata, o domani ripartirebbe la stessa mail.
    const marcatura = updateCalls.find(u =>
      u.filters.some(([m, args]) => m === 'eq' && args[1] === 'oltre-il-cap'))
    expect(marcatura).toBeDefined()
    expect((marcatura!.payload as { reminders_sent: string[] }).reminders_sent)
      .toEqual([todayRomeISO()])
  })

  it('non manda nulla a una scadenza fuori dalla finestra reminder (controprova)', async () => {
    const { sendEmailInternal } = await import('@/v19/tools/email/send-email')
    // reminder_days 5, scadenza fra 30 giorni → nessun invio.
    pagine = [[{ ...rigaInScadenza('lontana'), data_scadenza: traGiorni(30) }]]

    const { GET } = await import('./route')
    const body = await (await GET(cronRequest())).json()

    expect(body.checked).toBe(1)
    expect(body.reminded).toBe(0)
    expect(sendEmailInternal).not.toHaveBeenCalled()
  })

  // Questo test NON imposta `pagine`: e rosso se il reset in beforeEach manca,
  // perche eredita le 501 righe del test precedente.
  it('senza righe nel DB non manda nulla (e non eredita le pagine del test prima)', async () => {
    const { GET } = await import('./route')
    const body = await (await GET(cronRequest())).json()

    expect(body.ok).toBe(true)
    expect(body.checked).toBe(0)
    expect(body.reminded).toBe(0)
    expect(rangeCalls).toEqual([[0, 499]])
  })

  // COMPORTAMENTO ATTUALE PINNATO, non approvato: dal branch in corso il
  // `return 500` sta DENTRO il loop di paginazione, quindi un errore a pagina 2
  // aborta l'intero cron e le scadenze GIA LETTE a pagina 1 — comprese quelle
  // in finestra — restano senza promemoria fino al giorno dopo.
  it('un errore a PAGINA 2 aborta tutto: le scadenze di pagina 1 restano senza promemoria', async () => {
    const { sendEmailInternal } = await import('@/v19/tools/email/send-email')
    pagine = [
      // pagina piena, con dentro una scadenza che AVREBBE dovuto ricevere la mail
      [rigaInScadenza('pagina-1-in-scadenza', 2), ...Array.from({ length: 499 }, (_, i) => riga(i))],
    ]
    erroreAllaPagina = 1

    const { GET } = await import('./route')
    const res = await GET(cronRequest())
    const body = await res.json()

    expect(res.status).toBe(500)
    expect(body.ok).toBe(false)
    expect(body.error).toBe('PostgREST 500')
    // Il costo del comportamento attuale: nessuna mail, nemmeno per pagina 1.
    expect(sendEmailInternal).not.toHaveBeenCalled()
    expect(body.details).toBeUndefined()
  })

  // FIX 5 — `.range()` non ha isolamento fra pagine e `data_scadenza` non e una
  // chiave d'ordinamento unica (un rinnovo di squadra ne mette dieci sullo
  // stesso giorno): due pari-merito a cavallo dell'offset possono arrivare due
  // volte (doppia mail) o zero volte (nessuna mail). Test strutturale: il
  // tiebreaker deterministico e una proprieta della QUERY, non un
  // comportamento osservabile da un mock che non simula un vero planner.
  it('ordina per data_scadenza E per id: senza tiebreaker la paginazione perde righe (FIX 5)', async () => {
    pagine = [Array.from({ length: 3 }, (_, i) => riga(i))]

    const { GET } = await import('./route')
    await GET(cronRequest())

    expect(orderCalls).toEqual([
      ['data_scadenza', { ascending: true }],
      ['id', { ascending: true }],
    ])
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
