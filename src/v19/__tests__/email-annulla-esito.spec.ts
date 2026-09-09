/**
 * src/v19/__tests__/email-annulla-esito.spec.ts
 *
 * `/annulla_<uuid>` diceva SEMPRE «❎ Invio annullato.»
 *
 *     await markPendingCancelled(uuid)          // esito buttato
 *     return { ok: true, message: '❎ Invio annullato.' }
 *
 * mentre `markPendingCancelled` dichiara tre esiti distinti nel suo contratto
 * (`pending.ts:189-199`), fra cui `db_error` e `already_processed`.
 *
 * Due danni, tutti e due su una mail verso un destinatario ESTERNO:
 *
 * 1. Su un errore Supabase la riga resta `status='pending'` e il bot dice
 *    «annullato». Quella riga resta il *latest pending valido*: la successiva
 *    conferma a voce «invia pure la mail» (`confirmLatestPendingSend`)
 *    SPEDISCE la mail che l'Ingegnere aveva annullato.
 * 2. Sulla corsa, la mail e' gia' partita (`status='sent'`) e il bot dice
 *    comunque «annullato»: l'Ingegnere crede di averla fermata.
 *
 * ⭐ Il gemello `markPendingSent` l'esito lo controlla (`telegram-confirm.ts:63`).
 * La difesa esisteva su una porta e non sull'altra: una correzione applicata a
 * meta', la firma di questo repo.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const fetchPendingMock = vi.fn()
const markPendingCancelledMock = vi.fn()
const logEmailMock = vi.fn().mockResolvedValue(undefined)

vi.mock('../tools/email/pending', () => ({
  fetchPending: (...a: unknown[]) => fetchPendingMock(...a),
  markPendingCancelled: (...a: unknown[]) => markPendingCancelledMock(...a),
  getLatestPendingSend: vi.fn(),
  countValidPendingSends: vi.fn(),
  listValidPendingSends: vi.fn(),
  markPendingSent: vi.fn(),
  updatePendingMessageId: vi.fn(),
}))
vi.mock('../tools/email/send-email', () => ({ sendEmailInternal: vi.fn() }))
vi.mock('../tools/email/audit', () => ({ logEmail: (...a: unknown[]) => logEmailMock(...a) }))
vi.mock('@/lib/sent-mail', () => ({ recordSentMail: vi.fn() }))

import { cancelPendingSend } from '../tools/email/telegram-confirm'

const PENDING = { uuid: 'u-1', from_account: 'raffaele', to: ['cliente@esterno.it'] }

describe('/annulla dice la verita sull esito', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    fetchPendingMock.mockResolvedValue(PENDING)
  })

  it('se il database NON ha annullato, NON dice che ha annullato', async () => {
    markPendingCancelledMock.mockResolvedValue({ ok: false, reason: 'db_error', error: 'rete giu' })

    const esito = await cancelPendingSend('u-1')

    expect(esito.ok).toBe(false)
    expect(esito.message).not.toContain('annullato')
  })

  it('se la mail era gia partita, non fa credere di averla fermata', async () => {
    markPendingCancelledMock.mockResolvedValue({ ok: false, reason: 'already_processed' })

    const esito = await cancelPendingSend('u-1')

    expect(esito.ok).toBe(false)
    expect(esito.message).not.toContain('❎ Invio annullato.')
  })

  it('CONTROLLO POSITIVO: quando annulla davvero, lo dice', async () => {
    // Senza questo, i due test sopra passerebbero anche con un codice che
    // risponde sempre "non annullato" e non annulla mai niente.
    markPendingCancelledMock.mockResolvedValue({ ok: true })

    const esito = await cancelPendingSend('u-1')

    expect(esito.ok).toBe(true)
    expect(esito.message).toContain('annullato')
  })

  it('un annullamento fallito non finisce nel registro come annullato', async () => {
    // `logEmail` con action 'pending_cancelled' e' la traccia su cui si
    // ricostruisce cosa e' successo: registrarla per un annullamento mai
    // avvenuto renderebbe il registro stesso una fonte che mente.
    markPendingCancelledMock.mockResolvedValue({ ok: false, reason: 'db_error', error: 'rete giu' })

    await cancelPendingSend('u-1')

    expect(logEmailMock).not.toHaveBeenCalled()
  })
})
