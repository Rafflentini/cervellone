/**
 * La chat web trascrive con lo stesso orecchio di Telegram.
 *
 * Fino al 3 settembre 2026 il web usava `SpeechRecognition` del browser e
 * Telegram Whisper sul server: due motori diversi, quindi il vocabolario coi
 * nomi veri dei clienti, il filtro sulle frasi inventate dal silenzio e la
 * scelta del modello valevano per meta' prodotto.
 *
 * Questi test pinnano il cablaggio: la rotta deve passare l'audio del web
 * ESATTAMENTE alla stessa funzione che serve Telegram. Se qualcuno la
 * scollegasse — o ne scrivesse una seconda copia, che e' come nascono tutte le
 * divergenze di questo repo — cadono.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockTrascriviBuffer = vi.fn()
let autorizzato = true
let sottoLimite = true

vi.mock('@/lib/auth', () => ({ validateAuth: () => autorizzato }))
vi.mock('@/lib/rate-limiter', () => ({ rateLimit: () => sottoLimite }))
vi.mock('@/lib/trascrizione', () => ({
  trascriviBuffer: (...args: unknown[]) => mockTrascriviBuffer(...args),
}))

import { POST } from './route'

function richiesta(file: File | null, durata?: string) {
  const form = new FormData()
  if (file) form.append('audio', file)
  if (durata) form.append('durata', durata)
  return {
    cookies: { get: () => ({ value: 'cookie-di-prova-abbastanza-lungo' }) },
    formData: async () => form,
  } as unknown as Parameters<typeof POST>[0]
}

function audioFinto(byte = 2048, tipo = 'audio/webm') {
  return new File([new Uint8Array(byte)], 'dettatura.webm', { type: tipo })
}

beforeEach(() => {
  vi.clearAllMocks()
  autorizzato = true
  sottoLimite = true
  mockTrascriviBuffer.mockResolvedValue({ testo: 'Prepara la lettera per Blasi.' })
})

describe('POST /api/trascrivi', () => {
  it('manda l audio del web allo STESSO motore di Telegram', async () => {
    const res = await POST(richiesta(audioFinto(), '4.2'))
    const body = await res.json()

    expect(mockTrascriviBuffer).toHaveBeenCalledTimes(1)
    const [buffer, opts] = mockTrascriviBuffer.mock.calls[0] as [ArrayBuffer, Record<string, unknown>]
    expect(buffer.byteLength).toBe(2048)
    // Il canale serve solo ai log, ma dice che l'audio non e' arrivato da Telegram.
    expect(opts.canale).toBe('web')
    // Il tipo dichiarato dal browser va passato, non indovinato: Chrome produce
    // webm/opus, Safari mp4.
    expect(opts.mime).toBe('audio/webm')
    expect(opts.durataSec).toBe(4.2)
    expect(body.testo).toBe('Prepara la lettera per Blasi.')
  })

  it('senza cookie valido non trascrive niente', async () => {
    autorizzato = false

    const res = await POST(richiesta(audioFinto()))

    expect(res.status).toBe(401)
    expect(mockTrascriviBuffer).not.toHaveBeenCalled()
  })

  it('una registrazione mancante non arriva al trascrittore', async () => {
    const res = await POST(richiesta(null))
    const body = await res.json()

    expect(mockTrascriviBuffer).not.toHaveBeenCalled()
    expect(body.problema).toContain('nessun audio')
  })

  it('il rate limit protegge dalla dettatura che si ripete da sola', async () => {
    sottoLimite = false

    const res = await POST(richiesta(audioFinto()))

    expect(res.status).toBe(429)
    expect(mockTrascriviBuffer).not.toHaveBeenCalled()
  })

  it('quando il motore non ha capito, risponde 200 con il motivo', async () => {
    // Deve restare 200: il client tiene il testo del browser e non mostra un
    // errore. Un 500 farebbe sparire la dettatura appena fatta.
    mockTrascriviBuffer.mockResolvedValue({ testo: '', problema: 'Non ho sentito nulla di comprensibile nel vocale.' })

    const res = await POST(richiesta(audioFinto()))
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.testo).toBe('')
    expect(body.problema).toContain('Non ho sentito nulla')
  })
})
