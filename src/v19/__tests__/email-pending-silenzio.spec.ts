// src/v19/__tests__/email-pending-silenzio.spec.ts
/**
 * Un errore non diventa mai un'assenza.
 *
 * Tre letture di `pending.ts` mettevano il guasto del database e la riga
 * inesistente nello stesso cassetto:
 *   - `fetchPending`:          `if (error || !data) return null`
 *   - `getLatestPendingSend`:  `if (error || !data) return null`
 *   - `listValidPendingSends`: `if (error || !data) return []`
 *
 * È la stessa famiglia del difetto del conteggio (`countValidPendingSends`,
 * che chiedeva una colonna inesistente e rispondeva «zero mail» per tre mesi),
 * un gradino più in basso: qui il caso peggiore non è un invio sbagliato, è
 * l'Ingegnere che si ritrova senza NESSUN codice da usare — bloccato, e senza
 * sapere perché.
 *
 * Questi test provano che ogni lettura sappia dire «non lo so», e che ogni
 * chiamante lo riferisca invece di dire «non c'è niente».
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

type Risposta = { data: unknown; error: { message: string } | null }

function makeDbStub(risposta: Risposta) {
  const b = {
    select: vi.fn(() => b),
    eq: vi.fn(() => b),
    gt: vi.fn(() => b),
    order: vi.fn(() => b),
    limit: vi.fn(() => b),
    maybeSingle: vi.fn(() => Promise.resolve(risposta)),
    then: (resolve: (v: Risposta) => unknown) => Promise.resolve(resolve(risposta)),
  }
  return b
}

let dbStub = makeDbStub({ data: null, error: null })

vi.mock('@/lib/supabase-server', () => ({
  getSupabaseServer: vi.fn(() => ({ from: () => dbStub })),
}))

import { fetchPending, getLatestPendingSend, listValidPendingSends } from '../tools/email/pending'

const RIGA_VALIDA = {
  uuid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
  from_account: 'restruktura',
  to_addrs: ['destinataria@esterno.it'],
  cc_addrs: null,
  bcc_addrs: null,
  subject: 'Due contratti',
  body_text: 'in allegato',
  body_html: null,
  attachments: null,
  in_reply_to: null,
  status: 'pending',
  sent_message_id: null,
  sent_at: null,
  created_at: '2026-09-12T08:00:00Z',
  // 30 minuti nel futuro rispetto a qualunque "adesso" del test
  expires_at: new Date(Date.now() + 30 * 60_000).toISOString(),
  conversation_id: null,
}

describe('fetchPending — il guasto non si traveste da «non trovato»', () => {
  beforeEach(() => {
    dbStub = makeDbStub({ data: null, error: null })
  })

  it('CONTROLLO POSITIVO: con una riga valida la ritorna', async () => {
    dbStub = makeDbStub({ data: RIGA_VALIDA, error: null })
    const r = await fetchPending(RIGA_VALIDA.uuid)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.pending.uuid).toBe(RIGA_VALIDA.uuid)
  })

  it('errore del database → motivo "errore", NON un\'assenza', async () => {
    dbStub = makeDbStub({ data: null, error: { message: 'connection refused' } })
    const r = await fetchPending('u1')
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.motivo).toBe('errore')
      // il motivo resta distinguibile: nessuno puo' confonderlo con «assente»
      expect(r.motivo).not.toBe('assente')
      if (r.motivo === 'errore') expect(r.error).toBe('connection refused')
    }
  })

  it('riga inesistente → motivo "assente"', async () => {
    dbStub = makeDbStub({ data: null, error: null })
    const r = await fetchPending('u-mai-esistito')
    expect(r).toEqual({ ok: false, motivo: 'assente' })
  })

  it('riga già processata → motivo "non_piu_pending"', async () => {
    dbStub = makeDbStub({ data: { ...RIGA_VALIDA, status: 'sent' }, error: null })
    const r = await fetchPending('u1')
    expect(r).toEqual({ ok: false, motivo: 'non_piu_pending' })
  })

  it('riga scaduta → motivo "scaduto"', async () => {
    dbStub = makeDbStub({
      data: { ...RIGA_VALIDA, expires_at: new Date(Date.now() - 60_000).toISOString() },
      error: null,
    })
    const r = await fetchPending('u1')
    expect(r).toEqual({ ok: false, motivo: 'scaduto' })
  })
})

describe('getLatestPendingSend — «non lo so» separato da «non c\'è»', () => {
  it('CONTROLLO POSITIVO: con una riga valida la ritorna', async () => {
    dbStub = makeDbStub({ data: RIGA_VALIDA, error: null })
    const r = await getLatestPendingSend()
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.pending?.uuid).toBe(RIGA_VALIDA.uuid)
  })

  it('errore del database → ok:false con il messaggio, mai pending:null', async () => {
    dbStub = makeDbStub({ data: null, error: { message: 'rls denied' } })
    const r = await getLatestPendingSend()
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toBe('rls denied')
    expect(r).not.toEqual({ ok: true, pending: null })
  })

  it('nessuna riga → ok:true con pending:null (assenza vera, dichiarata)', async () => {
    dbStub = makeDbStub({ data: null, error: null })
    expect(await getLatestPendingSend()).toEqual({ ok: true, pending: null })
  })
})

describe('listValidPendingSends — un elenco vuoto per errore lascia senza codici', () => {
  it('CONTROLLO POSITIVO: con due righe le elenca', async () => {
    dbStub = makeDbStub({
      data: [
        { uuid: 'u1', to_addrs: ['a@x.it'], subject: 'Uno' },
        { uuid: 'u2', to_addrs: ['b@x.it'], subject: 'Due' },
      ],
      error: null,
    })
    const r = await listValidPendingSends()
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.pendings).toHaveLength(2)
  })

  it('errore del database → ok:false, NON un elenco vuoto', async () => {
    dbStub = makeDbStub({ data: null, error: { message: 'timeout' } })
    const r = await listValidPendingSends()
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toBe('timeout')
    // il difetto vietato per nome
    expect(r).not.toEqual({ ok: true, pendings: [] })
  })

  it('nessuna riga → ok:true con elenco vuoto (assenza vera)', async () => {
    dbStub = makeDbStub({ data: [], error: null })
    expect(await listValidPendingSends()).toEqual({ ok: true, pendings: [] })
  })
})

describe('i chiamanti riferiscono il guasto invece di dire «non c\'è niente»', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  /** Mock di `pending.ts` con tutte le letture in errore. */
  function mockaLettureRotte(extra: Record<string, unknown> = {}) {
    vi.doMock('../tools/email/pending', () => ({
      fetchPending: vi.fn(async () => ({
        ok: false as const,
        motivo: 'errore' as const,
        error: 'connection refused',
      })),
      getLatestPendingSend: vi.fn(async () => ({ ok: false as const, error: 'connection refused' })),
      listValidPendingSends: vi.fn(async () => ({ ok: false as const, error: 'connection refused' })),
      countValidPendingSends: vi.fn(async () => ({ ok: true as const, count: 1 })),
      markPendingSent: vi.fn(),
      markPendingCancelled: vi.fn(),
      updatePendingMessageId: vi.fn(),
      ...extra,
    }))
    vi.doMock('../tools/email/send-email', () => ({ sendEmailInternal: vi.fn() }))
    vi.doMock('../tools/email/audit', () => ({ logEmail: vi.fn(async () => undefined) }))
    vi.doMock('@/lib/sent-mail', () => ({ recordSentMail: vi.fn() }))
    vi.doMock('@/lib/conferma-fic', () => ({
      confermaFicSenzaSocieta: vi.fn(async () => ({ intercettato: false, message: '' })),
    }))
  }

  it('confirmPendingSend: lettura in errore → NON dice «scaduto o già processato»', async () => {
    mockaLettureRotte()
    const { confirmPendingSend } = await import('../tools/email/telegram-confirm')
    const r = await confirmPendingSend('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee')
    expect(r.ok).toBe(false)
    // la bugia vietata per nome
    expect(r.message).not.toMatch(/Pending non trovato/i)
    expect(r.message).toMatch(/non riesco a leggere/i)
    expect(r.message).toMatch(/connection refused/)
    // e non spaccia il guasto per una scadenza: lo NEGA esplicitamente.
    // (l'assert grezzo `not.toMatch(/scaduto o gi/)` bocciava il messaggio
    // giusto, che quella frase la contiene per smentirla)
    expect(r.message).toMatch(/non e' detto che sia scaduto o gia' processato/i)
  })

  it('cancelPendingSend: lettura in errore → dichiara il guasto, non «non trovato»', async () => {
    mockaLettureRotte()
    const { cancelPendingSend } = await import('../tools/email/telegram-confirm')
    const r = await cancelPendingSend('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee')
    expect(r.ok).toBe(false)
    expect(r.message).not.toMatch(/Pending non trovato/i)
    expect(r.message).toMatch(/non riesco a leggere/i)
  })

  it('confirmPendingSend: pending scaduto → lo dice per quello che è (assenza vera)', async () => {
    // Controllo positivo del ramo opposto: le assenze vere restano dette come
    // assenze. Il punto non e' smettere di dire «scaduto», e' smettere di
    // dirlo quando non lo sappiamo.
    vi.doMock('../tools/email/pending', () => ({
      fetchPending: vi.fn(async () => ({ ok: false as const, motivo: 'scaduto' as const })),
      getLatestPendingSend: vi.fn(),
      listValidPendingSends: vi.fn(),
      countValidPendingSends: vi.fn(),
      markPendingSent: vi.fn(),
      markPendingCancelled: vi.fn(),
      updatePendingMessageId: vi.fn(),
    }))
    vi.doMock('../tools/email/send-email', () => ({ sendEmailInternal: vi.fn() }))
    vi.doMock('../tools/email/audit', () => ({ logEmail: vi.fn(async () => undefined) }))
    vi.doMock('@/lib/sent-mail', () => ({ recordSentMail: vi.fn() }))

    const { confirmPendingSend } = await import('../tools/email/telegram-confirm')
    const r = await confirmPendingSend('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee')
    expect(r.ok).toBe(false)
    expect(r.message).toMatch(/scaduto/i)
    expect(r.message).not.toMatch(/errore nel database/i)
  })

  it('confirmLatestPendingSend: elenco in errore con 2+ bozze → dichiara il guasto', async () => {
    mockaLettureRotte({
      countValidPendingSends: vi.fn(async () => ({ ok: true as const, count: 3 })),
    })
    const { confirmLatestPendingSend } = await import('../tools/email/telegram-confirm')
    const r = await confirmLatestPendingSend()
    expect(r.ok).toBe(false)
    expect(r.message).toMatch(/non riesco a/i)
    expect(r.message).toMatch(/connection refused/)
    expect(r.message).not.toMatch(/Non ho una mail pronta/i)
  })

  it('confirmLatestPendingSend: rilettura in errore con 1 bozza → dichiara il guasto', async () => {
    mockaLettureRotte()
    const { confirmLatestPendingSend } = await import('../tools/email/telegram-confirm')
    const r = await confirmLatestPendingSend()
    expect(r.ok).toBe(false)
    expect(r.message).toMatch(/non riesco a rileggere/i)
    expect(r.message).not.toMatch(/Non ho una mail pronta/i)
  })

  it('confirmLatestPendingSend: elenco VUOTO ma conteggio 2+ → discordanza dichiarata', async () => {
    mockaLettureRotte({
      countValidPendingSends: vi.fn(async () => ({ ok: true as const, count: 2 })),
      listValidPendingSends: vi.fn(async () => ({ ok: true as const, pendings: [] })),
    })
    const { confirmLatestPendingSend } = await import('../tools/email/telegram-confirm')
    const r = await confirmLatestPendingSend()
    expect(r.ok).toBe(false)
    expect(r.message).toMatch(/elenco torna vuoto/i)
  })
})
