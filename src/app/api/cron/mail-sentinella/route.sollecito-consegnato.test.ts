/**
 * route.sollecito-consegnato.test.ts
 *
 * Il contatore dei solleciti avanzava PRIMA dell'invio, e l'esito dell'invio
 * veniva buttato:
 *
 *     await updateReminderAttempt(proposal)     // attempts += 1
 *     await sendTelegramMessage(...).catch(...) // esito ignorato
 *
 * `sendTelegramMessage` **non rigetta MAI** (`telegram-helpers.ts:51-61`, dove
 * sta scritto a chiare lettere): senza token esce muta, e su 4xx/429 la fetch
 * risolve lo stesso. Quel `.catch` e' codice morto.
 *
 * Il danno non e' teorico. A `attempts >= 3` scatta `autoMemorizePendingProposals`:
 * la proposta viene **confermata e scritta in memoria da sola**, con la
 * motivazione «Nessuna risposta dopo 3 solleciti». Con tre solleciti mai
 * arrivati, una scadenza entra nel sistema senza che l'Ingegnere abbia visto
 * un solo messaggio.
 *
 * ⭐ Il cron delle scadenze fa gia' la cosa giusta, e il suo commento
 * (`cron/scadenze/route.ts:148-153`) descrive PRECISAMENTE questo errore:
 * «dando per consegnato un messaggio mai arrivato si marca la scadenza come
 * avvisata e quel promemoria e' perso per sempre». La lezione era gia' scritta
 * in casa, su un canale solo.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const inviatiChecked = vi.fn()
let aggiornamenti: unknown[] = []

vi.mock('@/lib/telegram-helpers', () => ({
  sendTelegramMessage: vi.fn(),
  sendTelegramMessageChecked: (...a: unknown[]) => inviatiChecked(...a),
}))

const PROPOSTA = {
  id: 'p-1',
  attachment_filename: 'DURC.pdf',
  tipo_documento: 'DURC',
  soggetto: 'RESTRUKTURA S.R.L.',
  data_scadenza: '2026-10-01',
  attempts: 2,
}

vi.mock('@/lib/supabase', () => ({
  supabase: {
    from: () => {
      const b: Record<string, unknown> = {}
      b.select = () => b
      b.eq = () => b
      b.lt = () => b
      b.order = () => b
      b.limit = () => Promise.resolve({ data: [PROPOSTA], error: null })
      b.update = (patch: unknown) => {
        aggiornamenti.push(patch)
        const u: Record<string, unknown> = {}
        u.eq = () => u
        // la catena .eq().eq() deve poter essere attesa
        u.then = (res: (v: unknown) => void) => res({ error: null })
        return u
      }
      return b
    },
  },
}))

import { remindPendingProposals } from './route'

describe('il contatore dei solleciti avanza SOLO se il messaggio e arrivato', () => {
  beforeEach(() => {
    aggiornamenti = []
    vi.clearAllMocks()
  })

  it('se Telegram non conferma, attempts NON avanza', async () => {
    inviatiChecked.mockResolvedValue(false)

    const errori: string[] = []
    const riproposte = await remindPendingProposals(123456, errori)

    expect(aggiornamenti).toHaveLength(0)
    expect(riproposte).toBe(0)
  })

  it('CONTROLLO POSITIVO: se Telegram conferma, attempts avanza', async () => {
    // Senza questo, il test sopra passerebbe anche con un codice che non
    // aggiorna mai niente e non sollecita piu' nessuno.
    inviatiChecked.mockResolvedValue(true)

    const errori: string[] = []
    const riproposte = await remindPendingProposals(123456, errori)

    expect(aggiornamenti).toHaveLength(1)
    expect(aggiornamenti[0]).toMatchObject({ attempts: 3 })
    expect(riproposte).toBe(1)
  })

  it('una consegna non riuscita viene DETTA, non ingoiata', async () => {
    // Se il sollecito non parte e nessuno lo dice, la proposta resta ferma a
    // tempo indeterminato e nessuno sa perche'.
    inviatiChecked.mockResolvedValue(false)

    const errori: string[] = []
    await remindPendingProposals(123456, errori)

    expect(errori.length).toBeGreaterThan(0)
    expect(errori.join(' ')).toContain('DURC.pdf')
  })
})
