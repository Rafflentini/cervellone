import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../tools/email/read-email', () => ({ readEmail: vi.fn() }))
vi.mock('../tools/email/forward-email', () => ({ forwardEmail: vi.fn() }))
vi.mock('../tools/email/mark-email', () => ({ markEmail: vi.fn() }))
vi.mock('../tools/email/send-email', () => ({ sendEmailInternal: vi.fn() }))
vi.mock('@/lib/gmail-tools', () => ({
  searchGmail: vi.fn(),
  readMessage: vi.fn(),
  scaricaAllegato: vi.fn(),
}))

// ATTENZIONE — qui stava il difetto che ha tenuto verdi i test per quattro mesi:
// il mock precedente era su '@/lib/supabase', ma la routine importa
// getSupabaseServer da '@/lib/supabase-server'. Il mock era MORTO: i test
// parlavano con un client vero verso localhost, l'errore di rete restituiva
// data:null, e il controllo "gia inoltrata" rispondeva "no" per guasto, non per
// logica. Un mock sul modulo sbagliato non fallisce: tace.
const righeWhitelist: Array<{ email: string }> = []
let insertFallisce = false
let letturaRegistroFallisce = false
const righeLog: unknown[] = []

vi.mock('@/lib/supabase-server', () => ({
  getSupabaseServer: () => ({
    from: (tabella: string) => {
      if (tabella === 'cervellone_email_senders') {
        const q = {
          select: () => q,
          eq: () => q,
          then: (risolvi: (v: { data: Array<{ email: string }> }) => unknown) => risolvi({ data: righeWhitelist }),
        }
        return q
      }
      const q2 = {
        select: () => q2,
        eq: () => q2,
        maybeSingle: async () =>
          letturaRegistroFallisce
            ? { data: null, error: { message: 'schema cache stantia' } }
            : { data: null, error: null },
        insert: async (riga: unknown) => {
          if (insertFallisce) return { error: { message: 'RLS: permission denied' } }
          righeLog.push(riga)
          return { error: null }
        },
      }
      return q2
    },
  }),
}))

import {
  runMonthlyForeignInvoices,
  caselleStandard,
  casellaImap,
  casellaGmail,
  estraiIndirizzo,
  type Casella,
  type MessaggioCasella,
} from '../routines/monthly-foreign-invoices'
import { readEmail } from '../tools/email/read-email'
import { forwardEmail } from '../tools/email/forward-email'
import { sendEmailInternal } from '../tools/email/send-email'
import { searchGmail, readMessage, scaricaAllegato } from '@/lib/gmail-tools'

const leggiImap = readEmail as unknown as ReturnType<typeof vi.fn>
const inoltraImap = forwardEmail as unknown as ReturnType<typeof vi.fn>
const spedisci = sendEmailInternal as unknown as ReturnType<typeof vi.fn>
const cercaGmail = searchGmail as unknown as ReturnType<typeof vi.fn>
const leggiGmail = readMessage as unknown as ReturnType<typeof vi.fn>
const allegatoGmail = scaricaAllegato as unknown as ReturnType<typeof vi.fn>

// I mittenti VERI, letti dalle caselle il 5 settembre 2026.
// Non inventati: se un giorno cambiano, questi test devono morire.
const ANTHROPIC_US = 'invoice+statements@mail.anthropic.com'
const VERCEL = 'invoice+statements@vercel.com'
const ANTHROPIC_IE = 'invoice+statements+acct_1reyrsbnuncszfs9@stripe.com'

function m(over: Partial<MessaggioCasella> = {}): MessaggioCasella {
  return { chiave: '1', from: 'x@y.com', subject: '', date: '2026-08-15T10:00:00Z', has_attachments: true, ...over }
}

/** Casella finta: il motore non deve sapere da dove arrivano i messaggi. */
function casellaFinta(nome: string, messaggi: MessaggioCasella[], extra: Partial<{ troncato: boolean; totale: number; esitoInoltro: { stato: string; message_id?: string }; esplode: string }> = {}): Casella {
  return {
    nome,
    async leggi() {
      if (extra.esplode) throw new Error(extra.esplode)
      return { messaggi, totale: extra.totale ?? messaggi.length, troncato: !!extra.troncato }
    },
    async inoltra() {
      return extra.esitoInoltro ?? { stato: 'sent', message_id: `<fwd-${nome}>` }
    },
  }
}

const treRicevuteVere = [
  m({ chiave: '101', from: ANTHROPIC_US, subject: 'Your receipt from Anthropic, PBC #2725-1616-0828' }),
  m({ chiave: '102', from: VERCEL, subject: 'Your receipt from Vercel Inc. #2536-3620' }),
  m({ chiave: '103', from: ANTHROPIC_IE, subject: 'Your receipt from Anthropic Ireland, Limited #2709-7495' }),
]

beforeEach(() => {
  vi.clearAllMocks()
  righeWhitelist.length = 0
  righeLog.length = 0
  insertFallisce = false
  letturaRegistroFallisce = false
})

describe('fatture estere — controlli positivi sui mittenti VERI', () => {
  it('CONTROLLO POSITIVO: le tre ricevute vere vengono inoltrate tutte e tre', async () => {
    // Questo e il test che mancava. Con la whitelist vecchia
    // (billing@anthropic.com, invoice@vercel.com) e il confronto esatto il
    // risultato era ZERO — esattamente cio che e successo in produzione da
    // giugno a settembre 2026.
    righeWhitelist.push(
      { email: 'invoice@mail.anthropic.com' },
      { email: 'invoice@vercel.com' },
      { email: 'invoice@stripe.com' },
    )

    const r = await runMonthlyForeignInvoices({
      month_ref: '2026-08',
      pausa_ms: 0,
      caselle: [casellaFinta('raffaele', treRicevuteVere)],
    })

    expect(r.forwarded.length).toBe(3)
    expect(r.nessun_risultato).toBe(false)
  })

  it('la whitelist arriva DAVVERO dalla banca dati, non solo dal parametro di test', async () => {
    // I vecchi test passavano sempre `senders`, quindi la lettura della
    // whitelist non era coperta da nulla.
    righeWhitelist.push({ email: 'invoice@vercel.com' })

    const r = await runMonthlyForeignInvoices({
      month_ref: '2026-08',
      pausa_ms: 0,
      caselle: [casellaFinta('raffaele', treRicevuteVere)],
    })

    expect(r.forwarded.map((f) => f.chiave)).toEqual(['102'])
  })

  it('il tag +acct_... di Stripe non impedisce il riconoscimento', async () => {
    // Anthropic fattura da DUE soggetti: PBC (USA) e Ireland Ltd, che passa da
    // Stripe con un indirizzo diverso a ogni account. Il confronto per
    // uguaglianza esatta non lo prendera mai.
    righeWhitelist.push({ email: 'invoice@stripe.com' })

    const r = await runMonthlyForeignInvoices({
      month_ref: '2026-08',
      pausa_ms: 0,
      caselle: [casellaFinta('raffaele', [m({ chiave: '103', from: ANTHROPIC_IE, subject: 'Your receipt' })])],
    })

    expect(r.forwarded.length).toBe(1)
  })

  it('una voce di whitelist per dominio prende qualsiasi mittente di quel dominio', async () => {
    righeWhitelist.push({ email: '@mail.anthropic.com' })

    const r = await runMonthlyForeignInvoices({
      month_ref: '2026-08',
      pausa_ms: 0,
      caselle: [casellaFinta('raffaele', [m({ chiave: '101', from: ANTHROPIC_US, subject: 'Your receipt' })])],
    })

    expect(r.forwarded.length).toBe(1)
  })

  it("riconosce il mittente anche quando arriva col nome davanti, come lo consegna Gmail", async () => {
    righeWhitelist.push({ email: 'invoice@vercel.com' })

    const r = await runMonthlyForeignInvoices({
      month_ref: '2026-08',
      pausa_ms: 0,
      caselle: [casellaFinta('gmail', [m({ chiave: 'abc', from: `"Vercel Inc." <${VERCEL}>`, subject: 'Your receipt' })])],
    })

    expect(r.forwarded.length).toBe(1)
  })

  it('CONTROLLO NEGATIVO: un mittente estraneo non passa solo perche ha un allegato', async () => {
    righeWhitelist.push({ email: 'invoice@vercel.com' })

    const r = await runMonthlyForeignInvoices({
      month_ref: '2026-08',
      pausa_ms: 0,
      caselle: [casellaFinta('raffaele', [m({ chiave: '500', from: 'sconosciuto@spam.com', subject: 'Invoice per te' })])],
    })

    expect(r.forwarded.length).toBe(0)
    expect(r.fallback_warnings.length).toBe(1)
  })
})

describe('fatture estere — le tre caselle', () => {
  it('LE CASELLE COLLEGATE SONO TRE: info, raffaele, gmail', async () => {
    // La causa numero uno del guasto era che ne veniva letta UNA sola. Questo
    // test guarda l'elenco vero, non il motore: un motore che sa gestire N
    // caselle non serve a nulla se gliene passiamo una.
    // [[feedback_testare_gli_adattatori_non_il_motore]]
    expect(caselleStandard().map((c) => c.nome)).toEqual(['info', 'raffaele', 'gmail'])
  })

  it('le fatture vengono raccolte da tutte le caselle, non solo dalla prima', async () => {
    righeWhitelist.push({ email: 'invoice@vercel.com' }, { email: 'invoice@mail.anthropic.com' })

    const r = await runMonthlyForeignInvoices({
      month_ref: '2026-08',
      pausa_ms: 0,
      caselle: [
        casellaFinta('info', [m({ chiave: '1', from: VERCEL, subject: 'receipt' })]),
        casellaFinta('raffaele', [m({ chiave: '2', from: ANTHROPIC_US, subject: 'receipt' })]),
        casellaFinta('gmail', [m({ chiave: 'g1', from: VERCEL, subject: 'receipt' })]),
      ],
    })

    expect(r.forwarded.map((f) => f.casella).sort()).toEqual(['gmail', 'info', 'raffaele'])
  })

  it('il risultato dice DA QUALE casella arriva ogni fattura', async () => {
    righeWhitelist.push({ email: 'invoice@vercel.com' })

    const r = await runMonthlyForeignInvoices({
      month_ref: '2026-08',
      pausa_ms: 0,
      caselle: [
        casellaFinta('info', []),
        casellaFinta('raffaele', [m({ chiave: '2', from: VERCEL, subject: 'receipt' })]),
      ],
    })

    expect(r.per_casella).toEqual([
      { casella: 'info', esaminati: 0, riconosciute: 0, inoltrate: 0 },
      { casella: 'raffaele', esaminati: 1, riconosciute: 1, inoltrate: 1 },
    ])
  })

  it('una casella che non si apre non ferma le altre, e viene dichiarata', async () => {
    // Un guasto su una casella NON e' "zero fatture": se restasse muto,
    // tornerebbe la stessa forma di silenzio che ha nascosto il guasto per
    // quattro mesi.
    righeWhitelist.push({ email: 'invoice@vercel.com' })

    const r = await runMonthlyForeignInvoices({
      month_ref: '2026-08',
      pausa_ms: 0,
      caselle: [
        casellaFinta('info', [], { esplode: 'IMAP timeout' }),
        casellaFinta('raffaele', [m({ chiave: '2', from: VERCEL, subject: 'receipt' })]),
      ],
    })

    expect(r.caselle_fallite).toEqual([{ casella: 'info', errore: 'IMAP timeout' }])
    expect(r.forwarded.length).toBe(1)
  })
})

describe('fatture estere — lo zero deve fare rumore', () => {
  it('zero inoltri su caselle NON vuote viene dichiarato, non taciuto', async () => {
    righeWhitelist.push({ email: 'invoice@vercel.com' })

    const r = await runMonthlyForeignInvoices({
      month_ref: '2026-08',
      pausa_ms: 0,
      caselle: [casellaFinta('raffaele', [m({ chiave: '1', from: 'tizio@example.com', subject: 'ciao', has_attachments: false })])],
    })

    expect(r.esaminati).toBe(1)
    expect(r.nessun_risultato).toBe(true)
  })

  it('caselle davvero vuote non sono un allarme', async () => {
    // Controllo positivo del controllo: se alzassimo l'allarme anche a casella
    // vuota, l'allarme diventerebbe rumore e verrebbe ignorato.
    righeWhitelist.push({ email: 'invoice@vercel.com' })

    const r = await runMonthlyForeignInvoices({ month_ref: '2026-08', pausa_ms: 0, caselle: [casellaFinta('raffaele', [])] })

    expect(r.esaminati).toBe(0)
    expect(r.nessun_risultato).toBe(false)
  })

  it('il troncamento della lettura viene riportato invece di essere scartato', async () => {
    righeWhitelist.push({ email: 'invoice@vercel.com' })

    const r = await runMonthlyForeignInvoices({
      month_ref: '2026-08',
      pausa_ms: 0,
      caselle: [casellaFinta('raffaele', treRicevuteVere, { troncato: true, totale: 400 })],
    })

    expect(r.troncato).toBe(true)
    expect(r.totale_in_casella).toBe(400)
  })

  it('la whitelist vuota viene dichiarata: il filtro non poteva far passare nulla', async () => {
    const r = await runMonthlyForeignInvoices({ month_ref: '2026-08', pausa_ms: 0, caselle: [casellaFinta('raffaele', treRicevuteVere)] })

    expect(r.whitelist_vuota).toBe(true)
  })

  it('un inoltro non riuscito viene contato, non ingoiato', async () => {
    righeWhitelist.push({ email: 'invoice@vercel.com' })

    const r = await runMonthlyForeignInvoices({
      month_ref: '2026-08',
      pausa_ms: 0,
      caselle: [casellaFinta('raffaele', [m({ chiave: '102', from: VERCEL, subject: 'receipt' })], { esitoInoltro: { stato: 'pending' } })],
    })

    expect(r.forwarded.length).toBe(0)
    expect(r.non_inoltrate.length).toBe(1)
  })

  it("se la scrittura sul registro fallisce la routine lo dice, invece di dichiarare l'inoltro fatto", async () => {
    // Senza questo controllo la mail parte, il registro resta vuoto, e il mese
    // dopo la stessa fattura viene inoltrata di nuovo: doppione silenzioso.
    righeWhitelist.push({ email: 'invoice@vercel.com' })
    insertFallisce = true

    const r = await runMonthlyForeignInvoices({
      month_ref: '2026-08',
      pausa_ms: 0,
      caselle: [casellaFinta('raffaele', [m({ chiave: '102', from: VERCEL, subject: 'receipt' })])],
    })

    expect(r.errori_registro.length).toBe(1)
  })
})

describe('fatture estere — nessun anello di ritorno', () => {
  it('gli inoltri mandati da Cervellone stesso non rientrano nel giro il mese dopo', async () => {
    // La casella di arrivo e' fra quelle che leggiamo: senza questa esclusione,
    // ogni mese gli inoltri del mese prima (PDF + "Fatture estere" nell'oggetto)
    // verrebbero risegnalati come mittente sconosciuto, per sempre.
    righeWhitelist.push({ email: 'invoice@vercel.com' })

    const r = await runMonthlyForeignInvoices({
      month_ref: '2026-08',
      pausa_ms: 0,
      caselle: [casellaFinta('raffaele', [
        m({ chiave: '200', from: 'raffaele.lentini@restruktura.it', subject: 'Fatture estere Restruktura agosto 2026 — Your receipt' }),
        m({ chiave: '201', from: 'info@restruktura.it', subject: 'Fatture estere Restruktura agosto 2026 — Your receipt' }),
      ])],
    })

    expect(r.forwarded.length).toBe(0)
    expect(r.fallback_warnings.length).toBe(0)
  })
})

describe('fatture estere — oggetto e prova a vuoto', () => {
  it('dry_run elenca i candidati senza inviare nulla', async () => {
    righeWhitelist.push({ email: 'invoice@mail.anthropic.com' })
    const casella = casellaFinta('raffaele', [m({ chiave: '101', from: ANTHROPIC_US, subject: 'Your receipt' })])
    const spia = vi.spyOn(casella, 'inoltra')

    const r = await runMonthlyForeignInvoices({ month_ref: '2026-08', dry_run: true, caselle: [casella] })

    expect(r.candidates.length).toBe(1)
    expect(spia).not.toHaveBeenCalled()
  })

  it("l'oggetto dice Fatture estere Restruktura, col mese in lettere e l'anno", async () => {
    righeWhitelist.push({ email: 'invoice@vercel.com' })
    const casella = casellaFinta('raffaele', [m({ chiave: '102', from: VERCEL, subject: 'receipt' })])
    const spia = vi.spyOn(casella, 'inoltra')

    await runMonthlyForeignInvoices({ month_ref: '2026-08', pausa_ms: 0, caselle: [casella] })

    expect(spia.mock.calls[0][1]).toContain('Fatture estere Restruktura agosto 2026')
  })

  it('il mese nell oggetto e quello di riferimento, non quello di oggi', async () => {
    // Il cron gira il 1° del mese DOPO: se prendesse la data corrente,
    // le fatture di dicembre arriverebbero etichettate gennaio.
    righeWhitelist.push({ email: 'invoice@vercel.com' })
    const casella = casellaFinta('raffaele', [m({ chiave: '102', from: VERCEL, subject: 'receipt', date: '2026-12-10T10:00:00Z' })])
    const spia = vi.spyOn(casella, 'inoltra')

    await runMonthlyForeignInvoices({ month_ref: '2026-12', pausa_ms: 0, caselle: [casella] })

    expect(spia.mock.calls[0][1]).toContain('dicembre 2026')
  })
})

// ── Gli adattatori, uno per uno ──────────────────────────────────────────────
// Un motore condiviso NON rende equipollenti le caselle: questi test guardano
// il pezzo che parla davvero con ciascuna. [[feedback_testare_gli_adattatori_non_il_motore]]

describe('adattatore IMAP', () => {
  it('legge la casella giusta, limitata al mese, con un tetto capiente', async () => {
    leggiImap.mockResolvedValue({ folder: 'INBOX', messages: [], truncated: false, total_matched: 0 })

    await casellaImap('raffaele').leggi('2026-08-01', '2026-09-01')

    const arg = leggiImap.mock.calls[0][0]
    expect(arg.account).toBe('raffaele')
    expect(arg.since).toBe('2026-08-01')
    // Senza `before` la ricerca prende tutto fino a oggi e il taglio premia i
    // giorni recenti, buttando via l'inizio del mese: le fatture.
    expect(arg.before).toBe('2026-09-01')
    // Le caselle ricevono 230-290 messaggi al mese: 100 non bastava.
    expect(arg.limit).toBeGreaterThanOrEqual(300)
  })

  it('riporta il troncamento che read-email dichiara', async () => {
    leggiImap.mockResolvedValue({ folder: 'INBOX', messages: [], truncated: true, total_matched: 900 })

    const l = await casellaImap('info').leggi('2026-08-01', '2026-09-01')

    expect(l.troncato).toBe(true)
    expect(l.totale).toBe(900)
  })

  it('inoltra dalla stessa casella da cui ha letto', async () => {
    inoltraImap.mockResolvedValue({ status: 'sent', message_id: '<x>' })

    await casellaImap('info').inoltra(m({ chiave: '77' }), 'Oggetto — ', 'testo')

    expect(inoltraImap.mock.calls[0][0].from_account).toBe('info')
    expect(inoltraImap.mock.calls[0][0].source_uid).toBe(77)
  })
})

describe('adattatore Gmail', () => {
  it('chiede a Gmail solo il mese richiesto e solo i messaggi con allegato', async () => {
    cercaGmail.mockResolvedValue([])

    await casellaGmail().leggi('2026-08-01', '2026-09-01')

    const q = cercaGmail.mock.calls[0][0] as string
    expect(q).toContain('after:2026/08/01')
    expect(q).toContain('before:2026/09/01')
    expect(q).toContain('has:attachment')
  })

  it('non chiede la posta che il bot ha spedito lui stesso, ne il cestino', async () => {
    cercaGmail.mockResolvedValue([])

    await casellaGmail().leggi('2026-08-01', '2026-09-01')

    const q = cercaGmail.mock.calls[0][0] as string
    expect(q).toContain('-in:sent')
    expect(q).toContain('-in:trash')
  })

  it('traduce i messaggi Gmail nella forma comune, data compresa', async () => {
    cercaGmail.mockResolvedValue([
      { id: 'a1b2', from: `"Vercel Inc." <${VERCEL}>`, subject: 'Your receipt', date: 'Wed, 05 Aug 2026 10:00:00 +0000', hasAttachments: false },
    ])

    const l = await casellaGmail().leggi('2026-08-01', '2026-09-01')

    expect(l.messaggi[0].chiave).toBe('a1b2')
    expect(l.messaggi[0].date).toBe('2026-08-05T10:00:00.000Z')
  })

  it("CONTROLLO POSITIVO: l'allegato Gmail vale true anche se la ricerca dice false", async () => {
    // Questo test nasce da un audit che ha bocciato la mia prima versione.
    // `searchGmail` chiede a Gmail il formato 'metadata', che NON restituisce le
    // parti MIME: `hasAttachments` e' SEMPRE false, per costruzione. Copiandolo,
    // ogni messaggio Gmail sarebbe morto al controllo allegati senza finire in
    // nessun contatore — lo zero silenzioso rifatto sulla terza casella.
    // La verita' sta nella query, che contiene `has:attachment`.
    cercaGmail.mockResolvedValue([
      { id: 'a1b2', from: VERCEL, subject: 'Your receipt', date: '2026-08-05T10:00:00Z', hasAttachments: false },
    ])

    const l = await casellaGmail().leggi('2026-08-01', '2026-09-01')

    expect(l.messaggi[0].has_attachments).toBe(true)
  })

  it('una data storta non fa risultare rotta tutta la casella', async () => {
    cercaGmail.mockResolvedValue([
      { id: 'a1b2', from: VERCEL, subject: 'Your receipt', date: 'non-e-una-data', hasAttachments: false },
    ])

    const l = await casellaGmail().leggi('2026-08-01', '2026-09-01')

    expect(l.messaggi[0].date).toBeNull()
  })

  it('CONTROLLO POSITIVO: la fattura trovata su Gmail viene RISPEDITA con i PDF, non solo segnalata', async () => {
    // Segnalare e' lasciare il lavoro all'Ingegnere. Un'automazione che lascia
    // lavoro non e' un'automazione.
    leggiGmail.mockResolvedValue({
      attachments: [
        { attachmentId: 'att1', filename: 'Invoice-0001.pdf', mimeType: 'application/pdf', sizeBytes: 100 },
        { attachmentId: 'att2', filename: 'Receipt-0001.pdf', mimeType: 'application/pdf', sizeBytes: 100 },
      ],
    })
    allegatoGmail.mockResolvedValue('QkFTRTY0')
    spedisci.mockResolvedValue({ status: 'sent', message_id: '<g1>' })

    const esito = await casellaGmail().inoltra(m({ chiave: 'a1b2', subject: 'Your receipt' }), 'Fatture estere Restruktura agosto 2026 — ', 'testo')

    const inviata = spedisci.mock.calls[0][0]
    expect(inviata.attachments).toHaveLength(2)
    expect(inviata.attachments[0].filename).toBe('Invoice-0001.pdf')
    expect(inviata.attachments[0].content_base64).toBe('QkFTRTY0')
    expect(inviata.subject).toContain('Fatture estere Restruktura agosto 2026')
    expect(esito.stato).toBe('sent')
    // I nomi dei file finiscono nel registro: prima era sempre una lista vuota,
    // e la colonna che doveva dire COSA e' stato inoltrato non diceva niente.
    expect(esito.filenames).toEqual(['Invoice-0001.pdf', 'Receipt-0001.pdf'])
  })

  it('una spedizione rimasta in sospeso non viene spacciata per inviata', async () => {
    leggiGmail.mockResolvedValue({ attachments: [] })
    spedisci.mockResolvedValue({ status: 'pending', uuid: 'u1' })

    const esito = await casellaGmail().inoltra(m({ chiave: 'a1b2' }), 'Oggetto — ', 'testo')

    expect(esito.stato).toBe('pending')
    expect(esito.message_id).toBeUndefined()
  })
})

describe('estrazione indirizzo', () => {
  it('prende l indirizzo dentro le parentesi angolari', () => {
    expect(estraiIndirizzo('"Anthropic, PBC" <invoice+statements@mail.anthropic.com>')).toBe('invoice+statements@mail.anthropic.com')
  })

  it('lascia intatto un indirizzo gia nudo, come lo consegna IMAP', () => {
    expect(estraiIndirizzo('invoice+statements@vercel.com')).toBe('invoice+statements@vercel.com')
  })
})

// ── Rilievi dell'audit del 5 settembre: ogni scarto deve avere un contatore ──

describe('fatture estere — niente sparisce piu senza contatore', () => {
  it('un mittente RICONOSCIUTO ma senza allegato viene contato, non fatto sparire', async () => {
    // Se un fornitore passa dal PDF allegato al link nel corpo, la fattura
    // smette di arrivare. Prima spariva a un `continue` senza contatore: la
    // stessa forma di guasto che ha nascosto quattro mesi di zero.
    righeWhitelist.push({ email: 'invoice@vercel.com' })

    const r = await runMonthlyForeignInvoices({
      month_ref: '2026-08',
      pausa_ms: 0,
      caselle: [casellaFinta('raffaele', [m({ chiave: '9', from: VERCEL, subject: 'Your receipt', has_attachments: false })])],
    })

    expect(r.scartate_senza_allegato).toHaveLength(1)
    expect(r.forwarded).toHaveLength(0)
  })

  it('un messaggio che esplode non ferma gli altri e viene dichiarato', async () => {
    righeWhitelist.push({ email: 'invoice@vercel.com' })
    const casella: Casella = {
      nome: 'raffaele',
      async leggi() {
        return {
          messaggi: [
            m({ chiave: '1', from: VERCEL, subject: 'receipt' }),
            m({ chiave: '2', from: VERCEL, subject: 'receipt' }),
          ],
          totale: 2,
          troncato: false,
        }
      },
      async inoltra(msg) {
        if (msg.chiave === '1') throw new Error('allegato non scaricabile')
        return { stato: 'sent', message_id: '<ok>' }
      },
    }

    const r = await runMonthlyForeignInvoices({ month_ref: '2026-08', pausa_ms: 0, caselle: [casella] })

    expect(r.errori_messaggio).toHaveLength(1)
    expect(r.errori_messaggio[0].chiave).toBe('1')
    // Il secondo e' passato lo stesso: un messaggio storto non butta giu' il giro.
    expect(r.forwarded.map((f) => f.chiave)).toEqual(['2'])
  })

  it('se il registro non risponde NON si reinvia: ci si ferma e lo si dice', async () => {
    // Fail-open verso il doppione era la direzione sbagliata: una query fallita
    // (schema stantia, RLS, timeout) faceva rispondere "non ancora inoltrata" e
    // avrebbe rispedito tutto.
    righeWhitelist.push({ email: 'invoice@vercel.com' })
    letturaRegistroFallisce = true

    const r = await runMonthlyForeignInvoices({
      month_ref: '2026-08',
      pausa_ms: 0,
      caselle: [casellaFinta('raffaele', [m({ chiave: '102', from: VERCEL, subject: 'receipt' })])],
    })

    expect(r.forwarded).toHaveLength(0)
    expect(r.errori_messaggio).toHaveLength(1)
    expect(r.errori_messaggio[0].errore).toContain('registro non interrogabile')
  })

  it('quando il tempo finisce si chiude dichiarandolo, invece di farsi troncare a meta', async () => {
    // Sforare maxDuration non lascia NIENTE: nessun conteggio, nessun avviso,
    // e un 504 assomiglia a "non e' partita". Un altro silenzio.
    righeWhitelist.push({ email: 'invoice@vercel.com' })

    const r = await runMonthlyForeignInvoices({
      month_ref: '2026-08',
      pausa_ms: 0,
      budget_ms: -1,
      caselle: [casellaFinta('raffaele', treRicevuteVere)],
    })

    expect(r.tempo_scaduto).toBe(true)
    expect(r.forwarded).toHaveLength(0)
  })

  it('CONTROLLO POSITIVO del tetto di tempo: con tempo a sufficienza non scatta', async () => {
    righeWhitelist.push({ email: 'invoice@vercel.com' })

    const r = await runMonthlyForeignInvoices({
      month_ref: '2026-08',
      pausa_ms: 0,
      caselle: [casellaFinta('raffaele', treRicevuteVere)],
    })

    expect(r.tempo_scaduto).toBe(false)
  })
})
