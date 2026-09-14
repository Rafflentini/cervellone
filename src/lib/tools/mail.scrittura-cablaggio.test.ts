import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * `mail.scrittura-casella-obbligatoria.test.ts` prova `casellaPerScrittura`
 * come funzione PURA — che `mail.ts:409` la chiami PRIMA di `gmail-tools` non
 * lo prova quello, lo prova solo eseguire DAVVERO `executeGmailWrapper` con lo
 * spione dentro `gmail-tools`. Senza questo file, un cablaggio rotto (il check
 * spento, o la guardia sostituita da un default silenzioso) restava verde su
 * tutta la suite (audit avversariale, 14 settembre 2026).
 *
 * Import pesante: `../gmail-tools` va mockato PRIMA di importare `./mail`,
 * altrimenti si trascina dentro `googleapis` (vedi il monito in
 * `politica-caselle.ts` — gia' costato un test caduto per timeout).
 */

const { createDraft } = vi.hoisted(() => ({ createDraft: vi.fn() }))

vi.mock('../supabase', () => ({ supabase: {} }))
vi.mock('../gmail-tools', () => ({
  createDraft,
  // Le altre funzioni non servono a questi test: se `executeGmailWrapper`
  // le chiamasse per errore, un TypeError le fa fallire rumorosamente — mai
  // in silenzio.
}))
vi.mock('../gmail-summary', () => ({ buildDailySummary: async () => '' }))
vi.mock('@/v19/tools/email', () => ({ MAIL_TOOL_EXECUTORS: {}, MAIL_TOOL_DEFINITIONS: [] }))
vi.mock('@/lib/sent-mail', () => ({ recordSentMail: async () => {} }))

import { executeGmailWrapper } from './mail'

beforeEach(() => {
  createDraft.mockReset()
  createDraft.mockResolvedValue({ draftId: 'd1', messageId: 'm1' })
})

describe('executeGmailWrapper — il cablaggio vero, non la funzione pura', () => {
  it('🚨 gmail_create_draft SENZA casella: rifiuto vero, e createDraft MAI chiamata', async () => {
    const esito = await executeGmailWrapper('gmail_create_draft', {
      to: 'cliente@example.com',
      subject: 'Oggetto',
      body: 'Corpo',
    })

    expect(esito).toContain('CHIEDI')
    expect(esito).toContain('larealestate')
    expect(createDraft).not.toHaveBeenCalled()
  })

  it('CONTROLLO POSITIVO: con casella indicata, createDraft e chiamata CON QUELLA casella', async () => {
    // Senza questo, una versione che rifiuta SEMPRE (o che non chiama mai
    // davvero gmail-tools) passerebbe anche il test qui sopra.
    const esito = await executeGmailWrapper('gmail_create_draft', {
      to: 'cliente@example.com',
      subject: 'Oggetto',
      body: 'Corpo',
      casella: 'larealestate',
    })

    expect(createDraft).toHaveBeenCalledTimes(1)
    expect(createDraft.mock.calls[0][0]).toBe('larealestate')
    expect(esito).toContain('Bozza creata')
  })
})
