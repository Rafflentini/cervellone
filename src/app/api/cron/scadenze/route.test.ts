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
// La chat Telegram dell'Ingegnere: 0 = non configurata.
let chatConfigurata = 12345
// Esito dichiarato da Telegram: false = accettato ma non consegnato.
let telegramConsegna = true
// Se vero, la scrittura del segno sulla riga fallisce.
let updateFallisce = false

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
    if (update) {
      const esito = updateFallisce ? { data: null, error: { message: 'RLS: permission denied' } } : { data: null, error: null }
      return Promise.resolve(esito).then(resolve)
    }
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

vi.mock('@/lib/telegram-helpers', () => ({
  // La route usa la variante VERIFICATA. `sendTelegramMessage` e "fire and
  // forget": non rigetta mai, quindi un mock costruito su di essa non potrebbe
  // far morire nessun test — sarebbe verde qualunque cosa succeda davvero.
  sendTelegramMessageChecked: vi.fn(async () => telegramConsegna),
  chatAdmin: () => chatConfigurata,
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
  // Stessa ragione: senza, il test che spegne Telegram lo lascerebbe spento
  // per tutti quelli dopo, e i loro controlli positivi diventerebbero finti.
  chatConfigurata = 12345
  telegramConsegna = true
  updateFallisce = false
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
    // Il segno porta anche la SOGLIA, non solo la data: dal 5 set 2026 i
    // promemoria sono tre e senza la soglia non si saprebbe quale e' partito.
    // (reminder_days 5 → soglie [5, 0]; mancano 3 giorni → scatta quella da 5.)
    expect((marcatura!.payload as { reminders_sent: string[] }).reminders_sent)
      .toEqual([`5:${todayRomeISO()}`])
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

// ── Promemoria ripetuti + Telegram (5 settembre 2026) ────────────────────────
// Prima ne partiva UNO SOLO, e solo per mail. Per una scadenza annuale voleva
// dire una mail sola, dodici mesi dopo, in una casella da centinaia di messaggi
// al mese: se quel giorno l'Ingegnere e in cantiere, la scadenza muore in
// silenzio. E esattamente cio che era successo col token GitHub scaduto il
// 5 giugno, di cui nessuno si e accorto per tre mesi.

/** Scadenza con preavviso lungo: e il caso del token GitHub (30 giorni). */
function rigaLunga(id: string, fraGiorni: number, giaMandati: string[] = []) {
  return {
    id, soggetto: `Soggetto ${id}`, categoria: 'sistema',
    tipo_documento: 'Token di accesso', data_scadenza: traGiorni(fraGiorni),
    reminder_days: 30, recipients: ['tizio@restruktura.it'], drive_url: null,
    reminders_sent: giaMandati,
  }
}

describe('cron scadenze — tre promemoria, non uno', () => {
  it('CONTROLLO POSITIVO: a 30 giorni parte il primo avviso', async () => {
    pagine = [[rigaLunga('token', 30)]]
    const { GET } = await import('./route')
    const body = await (await GET(cronRequest())).json()

    expect(body.reminded).toBe(1)
    expect(body.details[0].soglia).toBe(30)
  })

  it('il giorno dopo NON riparte: uno per soglia, non uno al mattino', async () => {
    // Se diventasse quotidiano, verrebbe ignorato proprio quando conta.
    pagine = [[rigaLunga('token', 29, [`30:${todayRomeISO()}`])]]
    const { GET } = await import('./route')
    const body = await (await GET(cronRequest())).json()

    expect(body.reminded).toBe(0)
  })

  it('a una settimana parte il RICHIAMO, che prima non esisteva', async () => {
    pagine = [[rigaLunga('token', 7, ['30:2026-08-06'])]]
    const { GET } = await import('./route')
    const body = await (await GET(cronRequest())).json()

    expect(body.reminded).toBe(1)
    expect(body.details[0].soglia).toBe(7)
  })

  it('il giorno della scadenza parte l ULTIMO avviso', async () => {
    pagine = [[rigaLunga('token', 0, ['30:2026-08-06', '7:2026-08-29'])]]
    const { GET } = await import('./route')
    const body = await (await GET(cronRequest())).json()

    expect(body.reminded).toBe(1)
    expect(body.details[0].soglia).toBe(0)
    expect(body.details[0].days_until).toBe(0)
  })

  it('una riga col formato VECCHIO non rimanda l avviso gia dato, ma i richiami restano vivi', async () => {
    // Le righe scritte prima di oggi contengono solo la data secca.
    pagine = [[rigaLunga('storica', 25, ['2026-06-04'])]]
    const { GET } = await import('./route')
    const body = await (await GET(cronRequest())).json()

    // A 25 giorni la soglia da 30 e gia chiusa dalla riga vecchia: niente.
    expect(body.reminded).toBe(0)
  })
})

describe('cron scadenze — anche su Telegram', () => {
  it('CONTROLLO POSITIVO: il promemoria arriva anche su Telegram, non solo per mail', async () => {
    const { sendTelegramMessageChecked } = await import('@/lib/telegram-helpers')
    pagine = [[rigaInScadenza('avviso', 3)]]
    const { GET } = await import('./route')
    const body = await (await GET(cronRequest())).json()

    expect(sendTelegramMessageChecked).toHaveBeenCalledTimes(1)
    const [chat, testo] = (sendTelegramMessageChecked as unknown as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(chat).toBe(12345)
    expect(String(testo)).toContain('Scadenza fra 3 giorni')
    expect(body.details[0].telegram.inviato).toBe(true)
  })

  it('se la chat Telegram non e configurata lo DICE, invece di tacere', async () => {
    // Il cron delle fatture estere leggeva una variabile inesistente e per
    // quattro mesi non ha mandato niente: l assenza di un messaggio non fa
    // rumore da sola, quindi il rumore lo deve fare la risposta.
    chatConfigurata = 0
    pagine = [[rigaInScadenza('muto', 3)]]
    const { GET } = await import('./route')
    const body = await (await GET(cronRequest())).json()

    expect(body.telegram_non_partito).toHaveLength(1)
    expect(body.telegram_non_partito[0].motivo).toContain('non configurata')
    // La mail e partita lo stesso: un canale giu non ferma l altro.
    expect(body.details[0].consegnato).toBe(true)
  })

  it('con Telegram muto e mail muta la scadenza resta DA AVVISARE e non viene marcata', async () => {
    const { sendEmailInternal } = await import('@/v19/tools/email/send-email')
    ;(sendEmailInternal as unknown as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ status: 'pending', uuid: 'u1' })
    chatConfigurata = 0
    pagine = [[rigaInScadenza('scoperta', 3)]]
    const { GET } = await import('./route')
    const body = await (await GET(cronRequest())).json()

    expect(body.details[0].consegnato).toBe(false)
    expect(body.non_consegnati).toHaveLength(1)
    // Non marcata: domani si riprova, invece di dare per avvisata una cosa che
    // non e mai arrivata a nessuno.
    expect(updateCalls).toHaveLength(0)
  })
})

describe('cron scadenze — i buchi trovati dall audit', () => {
  it('CONTROLLO POSITIVO: Telegram consegnato DA SOLO basta a marcare la riga', async () => {
    // Mutazione sopravvissuta al primo giro: togliendo `|| telegram.inviato`
    // da route.ts restavano tutti verdi. Senza questo test, il canale Telegram
    // poteva smettere di contare e nessuno se ne sarebbe accorto.
    const { sendEmailInternal } = await import('@/v19/tools/email/send-email')
    ;(sendEmailInternal as unknown as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ status: 'pending', uuid: 'u1' })
    pagine = [[rigaInScadenza('solo-telegram', 3)]]

    const { GET } = await import('./route')
    const body = await (await GET(cronRequest())).json()

    expect(body.details[0].recipients[0].status).toBe('pending')
    expect(body.details[0].telegram.inviato).toBe(true)
    expect(body.details[0].consegnato).toBe(true)
    // Marcata: altrimenti domani ripartirebbe un avviso gia ricevuto.
    expect(updateCalls).toHaveLength(1)
  })

  it('un Telegram accettato ma NON consegnato non vale come avviso dato', async () => {
    // `sendTelegramMessage` non rigetta mai: senza la variante verificata,
    // "inviato" sarebbe true anche senza token, la riga verrebbe marcata e quel
    // promemoria sarebbe perso per sempre.
    const { sendEmailInternal } = await import('@/v19/tools/email/send-email')
    ;(sendEmailInternal as unknown as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ status: 'pending', uuid: 'u1' })
    telegramConsegna = false
    pagine = [[rigaInScadenza('non-consegnato', 3)]]

    const { GET } = await import('./route')
    const body = await (await GET(cronRequest())).json()

    expect(body.details[0].telegram.inviato).toBe(false)
    expect(body.details[0].telegram.motivo).toContain('non ha confermato')
    expect(body.details[0].consegnato).toBe(false)
    expect(updateCalls).toHaveLength(0)
  })

  it('una scadenza che va in errore non lascia le ALTRE senza promemoria', async () => {
    // Prima l errore risaliva in cima: le scadenze successive non ricevevano
    // niente e il giro finiva in 500. Su dieci documenti in scadenza lo stesso
    // giorno, nove restavano scoperti per colpa del primo.
    updateFallisce = true
    pagine = [[rigaInScadenza('prima', 3), rigaInScadenza('seconda', 3)]]

    const { GET } = await import('./route')
    const res = await GET(cronRequest())
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.falliti).toHaveLength(2)
    expect(body.falliti.map((f: { id: string }) => f.id)).toEqual(['prima', 'seconda'])
    // Entrambe hanno provato: la seconda non e stata saltata per colpa della prima.
    expect(updateCalls).toHaveLength(2)
  })

  it('CONTROPROVA: senza errori non c e nessun fallito da dichiarare', async () => {
    pagine = [[rigaInScadenza('serena', 3)]]

    const { GET } = await import('./route')
    const body = await (await GET(cronRequest())).json()

    expect(body.falliti).toEqual([])
    expect(body.reminded).toBe(1)
  })
})
