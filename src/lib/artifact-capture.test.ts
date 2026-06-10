import { describe, it, expect, vi, beforeEach } from 'vitest'
import { isSubstantialArtifact, captureArtifact, buildArtifactsPointer } from './artifact-capture'

// Mock getSupabaseServer (stesso pattern di runs.test.ts) + isWorkingMemoryEnabled.
const mockFrom = vi.fn()
const mockIsWorkingMemoryEnabled = vi.fn()

vi.mock('@/lib/supabase-server', () => ({
  getSupabaseServer: () => ({
    from: mockFrom,
  }),
}))

// artifact-capture importa './supabase-server' e './working-memory' con path relativo;
// risolvono allo stesso modulo di '@/lib/...'. Mocchiamo entrambi i path relativi.
vi.mock('./supabase-server', () => ({
  getSupabaseServer: () => ({
    from: mockFrom,
  }),
}))

vi.mock('./working-memory', () => ({
  isWorkingMemoryEnabled: () => mockIsWorkingMemoryEnabled(),
}))

const LETTER = `Oggetto: Sollecito di pagamento fattura n. 123

Gentile Cliente,

con la presente La informiamo che la fattura n. 123 del 10/05/2026, di importo
pari a euro 1.500,00, risulta ad oggi non ancora saldata nonostante i precedenti
solleciti verbali intercorsi.

La invitiamo pertanto a provvedere al pagamento entro e non oltre 15 giorni dalla
ricezione della presente comunicazione, al fine di evitare l'avvio delle procedure
di recupero del credito previste dalla normativa vigente.

Restiamo a disposizione per qualsiasi chiarimento e cogliamo l'occasione per
porgere distinti saluti.

Cordiali saluti,
Restruktura S.r.l.`

describe('isSubstantialArtifact', () => {
  it('true per una mail lunga con "Oggetto:" e "Cordiali saluti"', () => {
    expect(isSubstantialArtifact(LETTER)).toBe(true)
  })

  it('false per una risposta breve tipo chat', () => {
    expect(isSubstantialArtifact('ok fatto')).toBe(false)
  })

  it('false per testo lungo ma destrutturato (niente marker, niente paragrafi)', () => {
    // > 600 char, una sola riga continua, nessun marker documentale.
    const blob = 'parola '.repeat(120).trim()
    expect(blob.length).toBeGreaterThan(600)
    expect(isSubstantialArtifact(blob)).toBe(false)
  })

  it('true per testo lungo strutturato a >=3 paragrafi anche senza marker', () => {
    const p = 'Questo è un paragrafo abbastanza lungo da contribuire alla lunghezza totale del testo in esame. '.repeat(3)
    const structured = `${p}\n\n${p}\n\n${p}`
    expect(structured.length).toBeGreaterThan(600)
    expect(isSubstantialArtifact(structured)).toBe(true)
  })
})

describe('captureArtifact', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockIsWorkingMemoryEnabled.mockResolvedValue(true)
  })

  it('flag ON + artefatto sostanziale → INSERT con type auto-bozza, ritorna {saved:true,id}', async () => {
    // catena dedup: select->eq->eq->order->limit->maybeSingle => nessuna precedente
    const dedupChain = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      order: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
    }
    // catena insert: insert->select->single
    const insertSingle = vi.fn().mockResolvedValue({ data: { id: 'doc-1' }, error: null })
    const insertChain = {
      insert: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({ single: insertSingle }),
      }),
    }
    mockFrom.mockReturnValueOnce(dedupChain).mockReturnValueOnce(insertChain)

    const res = await captureArtifact('conv-1', LETTER)

    expect(res).toEqual({ saved: true, id: 'doc-1' })
    expect(insertChain.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        conversation_id: 'conv-1',
        type: 'auto-bozza',
        content: LETTER.trim(),
      }),
    )
    // titolo derivato dall'Oggetto
    const arg = insertChain.insert.mock.calls[0][0]
    expect(arg.name).toContain('Sollecito di pagamento')
  })

  it('testo breve → {saved:false} senza chiamare INSERT', async () => {
    const res = await captureArtifact('conv-1', 'ok fatto')
    expect(res.saved).toBe(false)
    expect(mockFrom).not.toHaveBeenCalled()
  })

  it('flag OFF → {saved:false, reason:disabled}', async () => {
    mockIsWorkingMemoryEnabled.mockResolvedValue(false)
    const res = await captureArtifact('conv-1', LETTER)
    expect(res).toEqual({ saved: false, reason: 'disabled' })
    expect(mockFrom).not.toHaveBeenCalled()
  })

  it('dedup: stesso content dell ultima auto-bozza → {saved:false, reason:duplicate}', async () => {
    const dedupChain = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      order: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({ data: { content: LETTER.trim() }, error: null }),
    }
    mockFrom.mockReturnValueOnce(dedupChain)

    const res = await captureArtifact('conv-1', LETTER)
    expect(res).toEqual({ saved: false, reason: 'duplicate' })
  })
})

describe('buildArtifactsPointer', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('con 1 bozza → stringa contiene titolo, id e ritrova_bozza', async () => {
    const chain = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      order: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue({
        data: [{ id: 'doc-9', name: 'Sollecito fattura 123', type: 'auto-bozza' }],
        error: null,
      }),
    }
    mockFrom.mockReturnValue(chain)

    const out = await buildArtifactsPointer('conv-1')
    expect(out).toContain('Sollecito fattura 123')
    expect(out).toContain('doc-9')
    expect(out).toContain('ritrova_bozza')
  })

  it('con 0 bozze → stringa vuota', async () => {
    const chain = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      order: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue({ data: [], error: null }),
    }
    mockFrom.mockReturnValue(chain)

    const out = await buildArtifactsPointer('conv-1')
    expect(out).toBe('')
  })
})
