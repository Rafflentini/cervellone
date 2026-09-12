// src/v19/__tests__/email-pending-count.spec.ts
/**
 * 🚨 Il test che sarebbe servito il 4 giugno 2026 — e che non c'era.
 *
 * `countValidPendingSends()` chiedeva `count` sulla colonna `id`, che nella
 * tabella `cervellone_email_pending_send` NON ESISTE (la chiave è `uuid`).
 * Postgres rispondeva `42703: column "id" does not exist` a ogni chiamata, e
 * `if (error) return 0` trasformava quell'errore in «non ci sono mail».
 * Risultato: per tre mesi la conferma a linguaggio naturale delle mail ha
 * risposto «non ho una mail pronta da inviare» anche con sei bozze in attesa.
 *
 * Perché nessun test l'ha visto: l'unico riferimento alla funzione era
 * `countValidPendingSends: vi.fn()` — un mock. Il test aveva finto via proprio
 * la funzione rotta, e restava verde qualunque colonna chiedesse.
 *
 * Quindi qui NON si mocka la funzione. Si mocka il DATABASE, e lo si mocka
 * *severo*: lo stub conosce le colonne vere della tabella e rifiuta le altre
 * come fa Postgres. Un test che accetta qualunque nome di colonna non è un
 * test di questo difetto.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * Le colonne vere di `cervellone_email_pending_send`, come da `PendingRow` in
 * `src/v19/tools/email/pending.ts`. `id` NON c'è: è esattamente il punto.
 */
const COLONNE_REALI = new Set([
  'uuid',
  'created_at',
  'expires_at',
  'from_account',
  'to_addrs',
  'cc_addrs',
  'bcc_addrs',
  'subject',
  'body_text',
  'body_html',
  'attachments',
  'in_reply_to',
  'status',
  'sent_message_id',
  'sent_at',
  'conversation_id',
])

type RispostaSupabase = {
  data: unknown
  count: number | null
  error: { message: string; code?: string } | null
}

/**
 * Stub Supabase che si comporta come il database vero su UN punto preciso:
 * se la `select()` nomina una colonna che la tabella non ha, la query FALLISCE
 * con 42703 e il conteggio torna `null`. Nessuna indulgenza.
 */
function makeDbStub(righeValide: number) {
  const colonneChieste: string[] = []
  let errore: { message: string; code?: string } | null = null

  const b = {
    colonneChieste,
    select: vi.fn((cols: string, _opts?: { count?: string; head?: boolean }) => {
      for (const c of cols.split(',').map((s) => s.trim())) {
        colonneChieste.push(c)
        if (c !== '*' && !COLONNE_REALI.has(c)) {
          // Postgres rigetta l'INTERA query, non solo quella colonna.
          errore = { message: `column "${c}" does not exist`, code: '42703' }
        }
      }
      return b
    }),
    eq: vi.fn(() => b),
    gt: vi.fn(() => b),
    then: (resolve: (v: RispostaSupabase) => unknown) =>
      Promise.resolve(
        resolve(
          errore
            ? { data: null, count: null, error: errore }
            : { data: null, count: righeValide, error: null },
        ),
      ),
  }
  return b
}

let dbStub = makeDbStub(0)

vi.mock('@/lib/supabase-server', () => ({
  getSupabaseServer: vi.fn(() => ({ from: () => dbStub })),
}))

import { countValidPendingSends } from '../tools/email/pending'

describe('lo stub del database è tarato (controllo positivo)', () => {
  // «La misura non è il dato»: prima di credere a un verde, provo che lo
  // strumento sappia dire rosso. Senza questo, un test che passa non
  // distinguerebbe «la colonna è giusta» da «lo stub non controlla niente».
  it('una colonna inesistente fa fallire la query con 42703, come Postgres', async () => {
    const s = makeDbStub(6)
    const esito = (await s.select('id', {
      count: 'exact',
      head: true,
    })) as unknown as RispostaSupabase
    expect(esito.error?.code).toBe('42703')
    expect(esito.error?.message).toMatch(/column "id" does not exist/)
    expect(esito.count).toBeNull()
  })

  it('una colonna esistente passa e porta il conteggio', async () => {
    const s = makeDbStub(6)
    const esito = (await s.select('uuid', {
      count: 'exact',
      head: true,
    })) as unknown as RispostaSupabase
    expect(esito.error).toBeNull()
    expect(esito.count).toBe(6)
  })
})

describe('countValidPendingSends — conta davvero, e non spaccia i guasti per zeri', () => {
  beforeEach(() => {
    dbStub = makeDbStub(0)
  })

  it('(a) con la colonna giusta CONTA: sei bozze in attesa sono sei, non zero', async () => {
    dbStub = makeDbStub(6)
    const res = await countValidPendingSends()
    // Questo è l'assert che muore se si rimette `.select('id', ...)`:
    // lo stub rifiuta `id` e la funzione non può più rispondere ok:true.
    expect(res).toEqual({ ok: true, count: 6 })
  })

  it('(a-bis) chiede al database SOLO colonne che la tabella ha davvero', async () => {
    dbStub = makeDbStub(6)
    await countValidPendingSends()
    expect(dbStub.colonneChieste.length).toBeGreaterThan(0)
    for (const c of dbStub.colonneChieste) {
      expect(COLONNE_REALI.has(c) || c === '*').toBe(true)
    }
    // e il difetto nominato per nome, perché il prossimo che legge lo sappia
    expect(dbStub.colonneChieste).not.toContain('id')
  })

  it('(a-ter) applica i filtri di validità: status=pending e non scaduti', async () => {
    dbStub = makeDbStub(2)
    await countValidPendingSends()
    expect(dbStub.eq).toHaveBeenCalledWith('status', 'pending')
    expect(dbStub.gt).toHaveBeenCalledWith('expires_at', expect.any(String))
  })

  it('zero pending resta zero: ok:true con count 0 (assenza vera, dichiarata)', async () => {
    dbStub = makeDbStub(0)
    expect(await countValidPendingSends()).toEqual({ ok: true, count: 0 })
  })

  it('(b) con una colonna sbagliata NON risponde 0: segnala il guasto', async () => {
    // Ricreo a mano la query rotta di tre mesi: lo stub la rifiuta e la
    // funzione deve dire «non lo so», mai «non ci sono mail».
    const rotto = makeDbStub(6)
    await rotto.select('id', { count: 'exact', head: true })
    dbStub = rotto

    const res = await countValidPendingSends()
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toMatch(/does not exist/)
    // il cuore della faccenda: l'esito NON è confondibile con un conteggio a zero
    expect(res).not.toEqual({ ok: true, count: 0 })
    expect(res).not.toBe(0)
  })
})

describe('confirmLatestPendingSend — davanti a un «non lo so» non dice «non ho niente»', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it('conteggio in errore: NON invia, NON dice «non ho una mail pronta», dà /invia_', async () => {
    const sendEmailInternalMock = vi.fn()
    vi.doMock('../tools/email/pending', () => ({
      fetchPending: vi.fn(),
      getLatestPendingSend: vi.fn(),
      countValidPendingSends: vi.fn(async () => ({
        ok: false as const,
        error: 'column "id" does not exist',
      })),
      listValidPendingSends: vi.fn(),
      markPendingSent: vi.fn(),
      markPendingCancelled: vi.fn(),
      updatePendingMessageId: vi.fn(),
    }))
    vi.doMock('../tools/email/send-email', () => ({ sendEmailInternal: sendEmailInternalMock }))
    vi.doMock('../tools/email/audit', () => ({ logEmail: vi.fn(async () => undefined) }))
    vi.doMock('@/lib/sent-mail', () => ({ recordSentMail: vi.fn() }))
    vi.doMock('@/lib/conferma-fic', () => ({
      confermaFicSenzaSocieta: vi.fn(async () => ({ intercettato: false, message: '' })),
    }))

    const { confirmLatestPendingSend } = await import('../tools/email/telegram-confirm')
    const r = await confirmLatestPendingSend()

    expect(r.ok).toBe(false)
    // la bugia di tre mesi, vietata per nome
    expect(r.message).not.toMatch(/Non ho una mail pronta/i)
    // dice che è un guasto…
    expect(r.message).toMatch(/non riesco a controllare/i)
    // …e dà la via d'uscita che non dipende dal conteggio
    expect(r.message).toMatch(/\/invia_/)
    // e soprattutto non manda niente a nessuno
    expect(sendEmailInternalMock).not.toHaveBeenCalled()
  })

  it('conteggio 1 ma rilettura vuota: discordanza dichiarata, non «non ho niente»', async () => {
    const sendEmailInternalMock = vi.fn()
    vi.doMock('../tools/email/pending', () => ({
      fetchPending: vi.fn(),
      getLatestPendingSend: vi.fn(async () => null),
      countValidPendingSends: vi.fn(async () => ({ ok: true as const, count: 1 })),
      listValidPendingSends: vi.fn(),
      markPendingSent: vi.fn(),
      markPendingCancelled: vi.fn(),
      updatePendingMessageId: vi.fn(),
    }))
    vi.doMock('../tools/email/send-email', () => ({ sendEmailInternal: sendEmailInternalMock }))
    vi.doMock('../tools/email/audit', () => ({ logEmail: vi.fn(async () => undefined) }))
    vi.doMock('@/lib/sent-mail', () => ({ recordSentMail: vi.fn() }))
    vi.doMock('@/lib/conferma-fic', () => ({
      confermaFicSenzaSocieta: vi.fn(async () => ({ intercettato: false, message: '' })),
    }))

    const { confirmLatestPendingSend } = await import('../tools/email/telegram-confirm')
    const r = await confirmLatestPendingSend()

    expect(r.ok).toBe(false)
    expect(r.message).not.toMatch(/Non ho una mail pronta/i)
    expect(r.message).toMatch(/\/invia_/)
    expect(sendEmailInternalMock).not.toHaveBeenCalled()
  })

  it('controllo positivo: con UN pending valido la mail parte davvero', async () => {
    // Senza questo, i due test sopra proverebbero solo che la funzione non
    // invia MAI. Qui si prova che invierebbe, se le condizioni ci sono.
    const sendEmailInternalMock = vi.fn(async () => ({
      status: 'sent',
      message_id: '<vero@x>',
      sent_folder: 'INBOX.Sent',
      sent_uid: 1,
      append_failed: false,
    }))
    const riga = {
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
      expires_at: '2026-09-12T08:30:00Z',
      conversation_id: null,
    }
    vi.doMock('../tools/email/pending', () => ({
      fetchPending: vi.fn(async () => riga),
      getLatestPendingSend: vi.fn(async () => riga),
      countValidPendingSends: vi.fn(async () => ({ ok: true as const, count: 1 })),
      listValidPendingSends: vi.fn(),
      markPendingSent: vi.fn(async () => ({ ok: true })),
      markPendingCancelled: vi.fn(),
      updatePendingMessageId: vi.fn(async () => ({ ok: true })),
    }))
    vi.doMock('../tools/email/send-email', () => ({ sendEmailInternal: sendEmailInternalMock }))
    vi.doMock('../tools/email/audit', () => ({ logEmail: vi.fn(async () => undefined) }))
    vi.doMock('@/lib/sent-mail', () => ({ recordSentMail: vi.fn() }))
    vi.doMock('@/lib/conferma-fic', () => ({
      confermaFicSenzaSocieta: vi.fn(async () => ({ intercettato: false, message: '' })),
    }))

    const { confirmLatestPendingSend } = await import('../tools/email/telegram-confirm')
    const r = await confirmLatestPendingSend()

    expect(r.ok).toBe(true)
    expect(sendEmailInternalMock).toHaveBeenCalledTimes(1)
  })
})
