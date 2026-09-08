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

describe('saveMessageOnly — l ordine dei messaggi', () => {
  beforeEach(() => { insertMock.mockReset(); insertMock.mockResolvedValue({ error: null }) })

  // IL DIFETTO (8 set 2026): se la connessione dell'Ingegnere cade ma il server
  // prosegue (puo' volerci fino a 800s), la risposta viene scritta DOPO la
  // domanda successiva. Riaprendo la conversazione si trovava: domanda A,
  // domanda B, risposta B, risposta A — e cosi' andava anche al modello.
  //
  // La riga deve portare l'istante del SUO turno, non quello in cui il server
  // e' riuscito a scriverla.
  test('scrive l istante indicato invece di quello della scrittura', async () => {
    await saveMessageOnly('conv-1', 'assistant', 'La risposta.', '2026-09-08T10:00:00.000Z')

    expect(insertMock).toHaveBeenCalledTimes(1)
    expect(insertMock.mock.calls[0][0]).toMatchObject({
      conversation_id: 'conv-1',
      role: 'assistant',
      created_at: '2026-09-08T10:00:00.000Z',
    })
  })

  // CONTROLLO POSITIVO: senza questo, passare sempre un istante fisso (o
  // sempre `undefined`) passerebbe il test qui sopra.
  test('senza istante lascia decidere al database', async () => {
    await saveMessageOnly('conv-1', 'assistant', 'La risposta.')

    expect(insertMock.mock.calls[0][0]).not.toHaveProperty('created_at')
  })
})
