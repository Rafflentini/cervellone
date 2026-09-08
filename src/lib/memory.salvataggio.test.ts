/**
 * `supabase-js` NON lancia quando un insert viene rifiutato: mette l'errore in
 * `.error` e ritorna normalmente. Un `try/catch` attorno a `await insert(...)`
 * quindi non scatta mai — e per la chat web, dove dall'8 set 2026 questa e'
 * l'UNICA scrittura della risposta, un rifiuto (RLS, vincolo, payload) farebbe
 * sparire la risposta senza una riga di log: la stessa perdita muta che il fix
 * doveva eliminare, spostata di un livello.
 */
import { describe, test, expect, vi, beforeEach } from 'vitest'

const insertMock = vi.fn()
vi.mock('./supabase', () => ({
  supabase: { from: () => ({ insert: (riga: unknown) => insertMock(riga) }) },
}))
vi.mock('./logger', () => ({
  logWarn: vi.fn(), logInfo: vi.fn(), logError: vi.fn(),
}))

import { saveMessageOnly } from './memory'

describe('saveMessageOnly', () => {
  beforeEach(() => { insertMock.mockReset() })

  test('dice di NON aver salvato quando Supabase rifiuta la riga', async () => {
    insertMock.mockResolvedValue({ error: { message: 'new row violates row-level security policy' } })
    await expect(saveMessageOnly('conv-1', 'assistant', 'La risposta lunga.')).resolves.toBe(false)
  })

  // CONTROLLO POSITIVO: senza questo, un `return false` secco passerebbe il test
  // qui sopra e farebbe gridare al lupo a ogni salvataggio riuscito.
  test('dice di aver salvato quando la riga entra', async () => {
    insertMock.mockResolvedValue({ error: null })
    await expect(saveMessageOnly('conv-1', 'assistant', 'La risposta lunga.')).resolves.toBe(true)
  })

  test('non lascia passare per riuscito un insert che ha lanciato davvero', async () => {
    insertMock.mockRejectedValue(new Error('rete giu'))
    await expect(saveMessageOnly('conv-1', 'assistant', 'La risposta lunga.')).resolves.toBe(false)
  })
})
