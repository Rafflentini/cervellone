/**
 * route.consegna.test.ts
 *
 * Il self-audit gira ogni lunedi, calcola le anomalie e salva un rapporto
 * completo in `cervellone_audit_runs.report_text` — ma per sei settimane
 * consecutive (W32→W37) quel rapporto non e' mai arrivato a nessuno. Il
 * meccanismo di invio o non c'era, o usava una variante "fire and forget" che
 * non rigetta MAI (`sendTelegramMessage`), quindi un invio fallito passava per
 * riuscito.
 *
 * Qui si verifica che la consegna:
 * - parta SEMPRE, anche a zero anomalie (battito positivo — vedi
 *   [[feedback_controllo_positivo]]);
 * - vada su ENTRAMBI i canali — Telegram e chat web — perche' sono
 *   equipollenti: un avviso che arriva solo su uno e' un avviso che meta'
 *   delle volte non arriva ([[feedback_due_canali_equipollenti]]);
 * - dichiari l'esito di ciascun canale separatamente, invece di un `ok`
 *   generale che nasconde meta' del fatto;
 * - non lasci muto un canale fallito: se Telegram cade, il web deve
 *   comunque ricevere il rapporto (CONTROLLO POSITIVO — un test che non
 *   distingue "mandato" da "fallito" non misura niente);
 * - tronchi il rapporto oltre i 4096 caratteri di Telegram, dicendolo.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { NextRequest } from 'next/server'

// ── Mock supabase (silent check, last-run-week check, update) ──────────────

let ultimoAggiornamento: { table: string; payload: unknown } | null = null

vi.mock('@/lib/supabase', () => ({
  supabase: {
    from: (table: string) => {
      const b: Record<string, unknown> = {}
      b.select = () => b
      b.eq = () => b
      b.maybeSingle = () => Promise.resolve({ data: null, error: null })
      b.update = (payload: unknown) => {
        ultimoAggiornamento = { table, payload }
        const u: Record<string, unknown> = {}
        u.eq = () => Promise.resolve({ error: null })
        return u
      }
      return b
    },
  },
}))

// ── Mock audit-runner: il "dato" e gia pronto, qui si testa solo la consegna ──

const mockRunAudit = vi.fn()
const mockGetISOWeek = vi.fn()

vi.mock('@/lib/audit-runner', () => ({
  runAudit: (...a: unknown[]) => mockRunAudit(...a),
  getISOWeek: (...a: unknown[]) => mockGetISOWeek(...a),
}))

// ── Mock telegram-helpers ────────────────────────────────────────────────────

const mockSendTelegramMessageChecked = vi.fn()
const mockChatAdmin = vi.fn()

vi.mock('@/lib/telegram-helpers', () => ({
  sendTelegramMessage: vi.fn(),
  sendTelegramMessageChecked: (...a: unknown[]) => mockSendTelegramMessageChecked(...a),
  chatAdmin: (...a: unknown[]) => mockChatAdmin(...a),
}))

// ── Mock avviso-web ───────────────────────────────────────────────────────────

const mockAvvisaConversazioniWeb = vi.fn()

vi.mock('@/lib/avviso-web', () => ({
  avvisaConversazioniWeb: (...a: unknown[]) => mockAvvisaConversazioniWeb(...a),
}))

function cronRequest(): NextRequest {
  return {
    headers: { get: (name: string) => (name === 'authorization' ? `Bearer ${process.env.CRON_SECRET}` : null) },
  } as unknown as NextRequest
}

const REPORT_BREVE = '*🧠 Self-audit Cervellone — settimana 2026-W37*\n\n📊 *Sintesi*\nSettimana stabile.\n\n⚠️ *Anomalie rilevate (0)*\nNessuna anomalia rilevata.'
const REPORT_CON_ANOMALIE = '*🧠 Self-audit Cervellone — settimana 2026-W37*\n\n⚠️ *Anomalie rilevate (4)*\n1. *[alta]* MODEL_ERROR_HIGH: errori sopra soglia'

beforeEach(() => {
  vi.clearAllMocks()
  ultimoAggiornamento = null
  process.env.CRON_SECRET = 'test-secret'

  mockGetISOWeek.mockReturnValue('2026-W37')
  mockChatAdmin.mockReturnValue(12345678)
  mockSendTelegramMessageChecked.mockResolvedValue(true)
  mockAvvisaConversazioniWeb.mockResolvedValue(true)
})

describe('self-audit — consegna con anomalie', () => {
  it('il rapporto parte su ENTRAMBI i canali', async () => {
    mockRunAudit.mockResolvedValue({
      ok: true,
      run_id: 'run-1',
      anomalies_count: 4,
      iso_week: '2026-W37',
      report_text: REPORT_CON_ANOMALIE,
    })

    const { GET } = await import('./route')
    const res = await GET(cronRequest())
    const body = await res.json()

    expect(mockSendTelegramMessageChecked).toHaveBeenCalledTimes(1)
    expect(mockSendTelegramMessageChecked.mock.calls[0][0]).toBe(12345678)
    expect(mockSendTelegramMessageChecked.mock.calls[0][1]).toContain('MODEL_ERROR_HIGH')

    expect(mockAvvisaConversazioniWeb).toHaveBeenCalledTimes(1)
    expect(mockAvvisaConversazioniWeb.mock.calls[0][0]).toContain('MODEL_ERROR_HIGH')

    expect(body.consegna).toEqual({ telegram: true, web: true })
  })
})

describe('self-audit — battito positivo a zero anomalie', () => {
  it('il rapporto parte LO STESSO, in forma breve — il silenzio non deve voler dire "tutto ok"', async () => {
    mockRunAudit.mockResolvedValue({
      ok: true,
      run_id: 'run-2',
      anomalies_count: 0,
      iso_week: '2026-W37',
      report_text: REPORT_BREVE,
    })

    const { GET } = await import('./route')
    const res = await GET(cronRequest())
    const body = await res.json()

    expect(mockSendTelegramMessageChecked).toHaveBeenCalledTimes(1)
    expect(mockSendTelegramMessageChecked.mock.calls[0][1]).toContain('Nessuna anomalia rilevata')
    expect(mockAvvisaConversazioniWeb).toHaveBeenCalledTimes(1)
    expect(body.consegna).toEqual({ telegram: true, web: true })
  })
})

describe('self-audit — CONTROLLO POSITIVO: Telegram fallisce', () => {
  it('il web riceve comunque il rapporto, e la route lo dichiara nella risposta', async () => {
    mockRunAudit.mockResolvedValue({
      ok: true,
      run_id: 'run-3',
      anomalies_count: 2,
      iso_week: '2026-W37',
      report_text: REPORT_CON_ANOMALIE,
    })
    mockSendTelegramMessageChecked.mockResolvedValue(false)

    const { GET } = await import('./route')
    const res = await GET(cronRequest())
    const body = await res.json()

    // (a) il web riceve comunque
    expect(mockAvvisaConversazioniWeb).toHaveBeenCalledTimes(1)
    expect(mockAvvisaConversazioniWeb.mock.calls[0][0]).toContain('MODEL_ERROR_HIGH')

    // (b) la route lo dichiara: due campi distinti, non un ok generale
    expect(body.consegna).toEqual({ telegram: false, web: true })
    expect(body.ok).toBe(true) // l'audit resta salvato: la consegna non lo fa fallire
  })

  it('un Telegram che LANCIA non impedisce il web ne fa fallire la route', async () => {
    mockRunAudit.mockResolvedValue({
      ok: true,
      run_id: 'run-4',
      anomalies_count: 1,
      iso_week: '2026-W37',
      report_text: REPORT_CON_ANOMALIE,
    })
    mockSendTelegramMessageChecked.mockRejectedValue(new Error('rete giu'))

    const { GET } = await import('./route')
    const res = await GET(cronRequest())
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(mockAvvisaConversazioniWeb).toHaveBeenCalledTimes(1)
    expect(body.consegna).toEqual({ telegram: false, web: true })
  })

  it('CONTROLLO NEGATIVO inverso: se Telegram va a buon fine viene dichiarato true, non solo "non false"', async () => {
    // Senza questo, un codice che marca sempre telegram:false passerebbe lo
    // stesso il test sopra.
    mockRunAudit.mockResolvedValue({
      ok: true,
      run_id: 'run-5',
      anomalies_count: 1,
      iso_week: '2026-W37',
      report_text: REPORT_CON_ANOMALIE,
    })
    mockSendTelegramMessageChecked.mockResolvedValue(true)

    const { GET } = await import('./route')
    const res = await GET(cronRequest())
    const body = await res.json()

    expect(body.consegna.telegram).toBe(true)
  })
})

describe('self-audit — entrambi i canali falliscono', () => {
  it('la route resta ok:true (il dato e gia salvato) ma dichiara consegna:{telegram:false,web:false}', async () => {
    mockRunAudit.mockResolvedValue({
      ok: true,
      run_id: 'run-6',
      anomalies_count: 1,
      iso_week: '2026-W37',
      report_text: REPORT_CON_ANOMALIE,
    })
    mockSendTelegramMessageChecked.mockResolvedValue(false)
    mockAvvisaConversazioniWeb.mockResolvedValue(false)

    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const { GET } = await import('./route')
    const res = await GET(cronRequest())
    const body = await res.json()

    expect(body.ok).toBe(true)
    expect(body.consegna).toEqual({ telegram: false, web: false })
    expect(errSpy.mock.calls.some(c => String(c[0]).includes('CONSEGNA FALLITA'))).toBe(true)

    errSpy.mockRestore()
  })
})

describe('self-audit — troncamento Telegram oltre 4096 caratteri', () => {
  it('il testo mandato a Telegram viene tagliato E il troncamento e dichiarato; il web riceve il rapporto intero', async () => {
    const rapportoLungo = REPORT_CON_ANOMALIE + '\n' + 'x'.repeat(6000)
    expect(rapportoLungo.length).toBeGreaterThan(4096)

    mockRunAudit.mockResolvedValue({
      ok: true,
      run_id: 'run-7',
      anomalies_count: 3,
      iso_week: '2026-W37',
      report_text: rapportoLungo,
    })

    const { GET } = await import('./route')
    await GET(cronRequest())

    const testoTelegram = mockSendTelegramMessageChecked.mock.calls[0][1] as string
    expect(testoTelegram.length).toBeLessThanOrEqual(4096)
    expect(testoTelegram).toContain('troncato')
    expect(testoTelegram).toContain('cervellone_audit_runs')
    expect(testoTelegram).toContain('2026-W37')

    // Il web non ha il limite di Telegram: riceve il rapporto per intero.
    const testoWeb = mockAvvisaConversazioniWeb.mock.calls[0][0] as string
    expect(testoWeb).toBe(rapportoLungo)
  })
})

describe('self-audit — nessun run nuovo (skip) non tenta consegna', () => {
  it('audit gia eseguito questa settimana: nessuna chiamata ai canali', async () => {
    mockGetISOWeek.mockReturnValue('2026-W37')
    // Il primo giro (silent) e il secondo (last-run-week) leggono via
    // maybeSingle — qui simuliamo "gia eseguito" sovrascrivendo il mock
    // supabase per questo test soltanto non serve: usiamo runAudit non
    // chiamato come prova indiretta e verifichiamo che senza un run nuovo i
    // canali restino muti.
    mockRunAudit.mockResolvedValue({ ok: false, error: 'non dovrebbe essere chiamato' })

    // Con il supabase mock di default (maybeSingle → data:null) la route
    // procede comunque a runAudit: questo test copre solo che, a runAudit
    // fallito, la consegna non parte.
    const { GET } = await import('./route')
    const res = await GET(cronRequest())
    const body = await res.json()

    expect(body.ok).toBe(false)
    expect(mockSendTelegramMessageChecked).not.toHaveBeenCalled()
    expect(mockAvvisaConversazioniWeb).not.toHaveBeenCalled()
  })
})

describe('self-audit — autenticazione invariata', () => {
  it('senza il Bearer giusto: 401, nessuna chiamata a runAudit ne ai canali', async () => {
    const { GET } = await import('./route')
    const res = await GET({ headers: { get: () => 'Bearer sbagliato' } } as unknown as NextRequest)

    expect(res.status).toBe(401)
    expect(mockRunAudit).not.toHaveBeenCalled()
    expect(mockSendTelegramMessageChecked).not.toHaveBeenCalled()
    expect(mockAvvisaConversazioniWeb).not.toHaveBeenCalled()
  })
})
