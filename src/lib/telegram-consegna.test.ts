/**
 * Una consegna fallita lasciava in storia una riga che diceva «consegnato».
 *
 * `editTelegramMessage` non tornava niente: se l'edit finale falliva (Markdown
 * malformato piu' fallback fallito, rate limit, rete), l'Ingegnere restava col
 * «🧠 Sto elaborando…» o con la risposta a meta' — e in `messages` la risposta
 * completa risultava consegnata. Al turno dopo lui scrive «allora?» e il bot
 * risponde come se avesse gia' detto tutto.
 *
 * Sul web questo non esiste: li' un `invia()` che fallisce significa che il
 * browser se n'e' andato, e salvare comunque e' la scelta giusta e documentata.
 * Su Telegram no: il destinatario e' sempre li'.
 *
 * ⭐ La regola era gia' scritta in memoria — «`sendTelegramMessage` NON rigetta
 * mai: usare `sendTelegramMessageChecked`» — e non era applicata nel punto piu'
 * importante di tutti: la risposta del turno.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const risposte: Array<{ ok: boolean; description?: string }> = []
beforeEach(() => {
  risposte.length = 0
  vi.stubGlobal('fetch', vi.fn(async () => ({
    status: 200,
    json: async () => risposte.shift() ?? { ok: true },
  })))
  process.env.TELEGRAM_BOT_TOKEN = 'x'
})

describe('editTelegramMessage — dice se la consegna e riuscita', () => {
  it('quando Telegram accetta, torna true', async () => {
    risposte.push({ ok: true })
    const { editTelegramMessage } = await import('./telegram-helpers')
    expect(await editTelegramMessage(1, 2, 'testo')).toBe(true)
  })

  it('«not modified» conta come consegnato: il testo e gia li', async () => {
    risposte.push({ ok: false, description: 'Bad Request: message is not modified' })
    const { editTelegramMessage } = await import('./telegram-helpers')
    expect(await editTelegramMessage(1, 2, 'testo')).toBe(true)
  })

  it('Markdown rotto ma fallback riuscito: consegnato', async () => {
    risposte.push({ ok: false, description: "can't parse entities" })
    risposte.push({ ok: true })
    const { editTelegramMessage } = await import('./telegram-helpers')
    expect(await editTelegramMessage(1, 2, 'testo *rotto')).toBe(true)
  })

  // IL CASO CHE CONTA: entrambi falliti. Prima tornava undefined e nessuno
  // poteva distinguerlo da una consegna riuscita.
  it('Markdown rotto E fallback fallito: NON consegnato', async () => {
    risposte.push({ ok: false, description: "can't parse entities" })
    risposte.push({ ok: false, description: 'Bad Request: message too long' })
    const { editTelegramMessage } = await import('./telegram-helpers')
    expect(await editTelegramMessage(1, 2, 'testo *rotto')).toBe(false)
  })

  it('un errore qualsiasi di Telegram: NON consegnato', async () => {
    risposte.push({ ok: false, description: 'Too Many Requests: retry after 30' })
    const { editTelegramMessage } = await import('./telegram-helpers')
    expect(await editTelegramMessage(1, 2, 'testo')).toBe(false)
  })

  it('la rete che cade: NON consegnato, e non lancia', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNRESET') }))
    const { editTelegramMessage } = await import('./telegram-helpers')
    expect(await editTelegramMessage(1, 2, 'testo')).toBe(false)
  })

  it('senza token configurato: NON consegnato', async () => {
    delete process.env.TELEGRAM_BOT_TOKEN
    const { editTelegramMessage } = await import('./telegram-helpers')
    expect(await editTelegramMessage(1, 2, 'testo')).toBe(false)
  })
})
