import { describe, it, expect, vi } from 'vitest'

// Isola il modulo dai suoi import che caricano env/servizi a load-time
// (./supabase crea il client con NEXT_PUBLIC_SUPABASE_URL, assente nei test).
vi.mock('../supabase', () => ({ supabase: {} }))
vi.mock('../gmail-tools', () => ({}))
vi.mock('../gmail-summary', () => ({ buildDailySummary: async () => '' }))
vi.mock('@/v19/tools/email', () => ({ MAIL_TOOL_EXECUTORS: {}, MAIL_TOOL_DEFINITIONS: [] }))
vi.mock('@/lib/sent-mail', () => ({ recordSentMail: async () => {} }))

import { GMAIL_TOOLS, executeGmailWrapper, executeMailWrapper } from './mail'

describe('mail module', () => {
  it('GMAIL_TOOLS espone definizioni valide', () => {
    expect(GMAIL_TOOLS.length).toBeGreaterThan(0)
    for (const t of GMAIL_TOOLS) {
      expect(typeof t.name).toBe('string')
      expect(t.input_schema).toBeTruthy()
    }
  })
  it('gli executor ritornano null per nomi non gestiti (fall-through)', async () => {
    expect(await executeGmailWrapper('non_esiste', {})).toBeNull()
    expect(await executeMailWrapper('non_esiste', {})).toBeNull()
  })
})
