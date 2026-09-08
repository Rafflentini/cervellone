import { describe, test, expect, vi } from 'vitest'
import { conTetto } from './tetto-attesa'

const dopo = <T>(ms: number, valore: T) =>
  new Promise<T>((res) => setTimeout(() => res(valore), ms))

describe('conTetto', () => {
  test('se il lavoro finisce in tempo, restituisce il suo esito', async () => {
    await expect(conTetto(dopo(5, 'salvato'), 1000, 'scaduto')).resolves.toBe('salvato')
  })

  // IL DIFETTO che questa funzione chiude (8 set 2026): in `api/chat/route.ts`
  // `controller.close()` era finito dietro un await di rete verso Supabase senza
  // timeout. Con Supabase lento il testo era gia' a schermo ma lo stream non
  // chiudeva: spinner acceso e pulsante invio bloccato fino a `maxDuration`,
  // cioe' 800 secondi.
  test('se il lavoro non finisce in tempo, non trattiene il chiamante', async () => {
    vi.useFakeTimers()
    try {
      const lentissimo = new Promise<string>(() => { /* non si risolve mai */ })
      const esito = conTetto(lentissimo, 5_000, 'scaduto')
      await vi.advanceTimersByTimeAsync(5_000)
      await expect(esito).resolves.toBe('scaduto')
    } finally {
      vi.useRealTimers()
    }
  })

  test('un lavoro che fallisce non fa esplodere il chiamante', async () => {
    await expect(conTetto(Promise.reject(new Error('rete giu')), 1000, 'scaduto'))
      .resolves.toBe('scaduto')
  })
})
