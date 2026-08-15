import { describe, it, expect, vi } from 'vitest'

// Isola gli import che caricano env/servizi a load-time.
vi.mock('../supabase', () => ({ supabase: {} }))
vi.mock('../telegram-helpers', () => ({ sendTelegramMessage: async () => {} }))
vi.mock('../circuit-breaker', () => ({ promoteModel: async () => '' }))

import { SELF_TOOLS, executeSelfTools } from './self'

describe('self module', () => {
  it('SELF_TOOLS ha definizioni valide', () => {
    expect(SELF_TOOLS.length).toBeGreaterThan(0)
    expect(SELF_TOOLS.every(t => t.name && t.input_schema)).toBe(true)
  })
  it('executeSelfTools ritorna null per nomi non suoi', async () => {
    expect(await executeSelfTools('non_esiste', {})).toBeNull()
  })
})
