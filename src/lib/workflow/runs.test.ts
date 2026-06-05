import { describe, it, expect, vi, beforeEach } from 'vitest'
import { incrementRunAttempts, getActiveRunForChat } from './runs'

// Mock getSupabaseServer — stesso pattern di circuit-breaker.test.ts (mock './supabase')
// ma qui mocchiamo '@/lib/supabase-server' che esporta getSupabaseServer().
const mockRpc = vi.fn()
const mockFrom = vi.fn()

vi.mock('@/lib/supabase-server', () => ({
  getSupabaseServer: () => ({
    rpc: mockRpc,
    from: mockFrom,
  }),
}))

describe('incrementRunAttempts', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('ritorna il valore restituito dalla RPC', async () => {
    mockRpc.mockResolvedValue({ data: 3, error: null })
    const result = await incrementRunAttempts('run-abc')
    expect(mockRpc).toHaveBeenCalledWith('increment_workflow_run_attempts', { p_run_id: 'run-abc' })
    expect(result).toBe(3)
  })

  it('fail-open: ritorna 1 se RPC ritorna errore', async () => {
    mockRpc.mockResolvedValue({ data: null, error: { message: 'DB error' } })
    const result = await incrementRunAttempts('run-err')
    expect(result).toBe(1)
  })

  it('fail-open: ritorna 1 se data è null (run non trovata)', async () => {
    mockRpc.mockResolvedValue({ data: null, error: null })
    const result = await incrementRunAttempts('run-not-found')
    expect(result).toBe(1)
  })

  it('fail-open: ritorna 1 se RPC lancia un errore inatteso', async () => {
    mockRpc.mockRejectedValue(new Error('network error'))
    const result = await incrementRunAttempts('run-throw')
    expect(result).toBe(1)
  })
})

describe('getActiveRunForChat', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('ritorna la run attiva se esiste una running fresca', async () => {
    const fakeRun = { id: 'run-1', channel: 'telegram', chat_id: '123', conversation_id: 'conv-1', status: 'running' }
    const chainMock = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      gt: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({ data: fakeRun, error: null }),
    }
    mockFrom.mockReturnValue(chainMock)

    const result = await getActiveRunForChat('123')
    expect(result).toEqual(fakeRun)
    expect(mockFrom).toHaveBeenCalledWith('agent_workflow_runs')
    expect(chainMock.eq).toHaveBeenCalledWith('status', 'running')
    expect(chainMock.eq).toHaveBeenCalledWith('chat_id', '123')
  })

  it('ritorna null se non ci sono run attive (data null)', async () => {
    const chainMock = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      gt: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
    }
    mockFrom.mockReturnValue(chainMock)

    const result = await getActiveRunForChat('456')
    expect(result).toBeNull()
  })

  it('fail-open: ritorna null su errore DB', async () => {
    const chainMock = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      gt: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({ data: null, error: { message: 'connection lost' } }),
    }
    mockFrom.mockReturnValue(chainMock)

    const result = await getActiveRunForChat('789')
    expect(result).toBeNull()
  })

  it('fail-open: ritorna null su eccezione inattesa', async () => {
    mockFrom.mockImplementation(() => { throw new Error('unexpected') })
    const result = await getActiveRunForChat('xxx')
    expect(result).toBeNull()
  })
})
