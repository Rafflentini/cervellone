// src/lib/auto-debrief.test.ts — TDD auto-debrief (apprendimento implicito)
import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Mock Anthropic SDK (per runDebrief / maybeRunDebrief) ─────────────────────
const mockCreate = vi.fn()
vi.mock('@anthropic-ai/sdk', () => ({
  default: vi.fn().mockImplementation(() => ({
    messages: { create: mockCreate },
  })),
}))

// ── Mock Supabase (per isAutoDebriefEnabled) ──────────────────────────────────
// Catena: from('cervellone_config').select('value').eq('key', ...).maybeSingle()
const mockMaybeSingle = vi.fn()
const mockFrom = vi.fn(() => ({
  select: vi.fn().mockReturnThis(),
  eq: vi.fn().mockReturnThis(),
  maybeSingle: mockMaybeSingle,
}))
vi.mock('./supabase-server', () => ({
  getSupabaseServer: () => ({ from: mockFrom }),
}))

// ── Mock './claude' (getConfig) — evita di tirare dentro il modulo pesante ─────
vi.mock('./claude', () => ({
  getConfig: vi.fn().mockResolvedValue({ modelAudit: 'claude-sonnet-4-6' }),
}))

// ── Mock working-memory (write + read helpers) ────────────────────────────────
const mockCreateProcedure = vi.fn().mockResolvedValue(true)
const mockAddLesson = vi.fn().mockResolvedValue(true)
const mockSetActiveProject = vi.fn().mockResolvedValue(true)
const mockMergeChecklistSteps = vi.fn().mockResolvedValue(true)
const mockSetOutputPreferences = vi.fn().mockResolvedValue(true)
const mockGetActiveProject = vi.fn().mockResolvedValue(null)
const mockInferTaskType = vi.fn().mockResolvedValue('pos')
const mockBuildProcedureContext = vi.fn().mockResolvedValue('')
const mockSetLastDebriefAt = vi.fn().mockResolvedValue(true)

vi.mock('./working-memory', () => ({
  createProcedure: (...a: unknown[]) => mockCreateProcedure(...a),
  addLesson: (...a: unknown[]) => mockAddLesson(...a),
  setActiveProject: (...a: unknown[]) => mockSetActiveProject(...a),
  mergeChecklistSteps: (...a: unknown[]) => mockMergeChecklistSteps(...a),
  setOutputPreferences: (...a: unknown[]) => mockSetOutputPreferences(...a),
  getActiveProject: (...a: unknown[]) => mockGetActiveProject(...a),
  inferTaskType: (...a: unknown[]) => mockInferTaskType(...a),
  buildProcedureContext: (...a: unknown[]) => mockBuildProcedureContext(...a),
  setLastDebriefAt: (...a: unknown[]) => mockSetLastDebriefAt(...a),
}))

import {
  markToolSignal,
  consumeToolSignals,
  isApproval,
  passesGate,
  inCooldown,
  isAutoDebriefEnabled,
  applyDebrief,
  maybeRunDebrief,
  type DebriefSignals,
  type DebriefResult,
} from './auto-debrief'

beforeEach(() => {
  vi.clearAllMocks()
  mockGetActiveProject.mockResolvedValue(null)
  mockInferTaskType.mockResolvedValue('pos')
  mockBuildProcedureContext.mockResolvedValue('')
  mockCreateProcedure.mockResolvedValue(true)
  mockAddLesson.mockResolvedValue(true)
  mockSetActiveProject.mockResolvedValue(true)
  mockMergeChecklistSteps.mockResolvedValue(true)
  mockSetOutputPreferences.mockResolvedValue(true)
  mockSetLastDebriefAt.mockResolvedValue(true)
})

// Helper: fa sì che isAutoDebriefEnabled ritorni il valore voluto.
function setFlag(enabled: boolean) {
  mockMaybeSingle.mockResolvedValue({ data: { value: enabled ? 'true' : 'false' }, error: null })
}

// Helper: una risposta Anthropic con un tool_use StructuredOutput.
function anthropicToolUse(input: unknown) {
  return { content: [{ type: 'tool_use', name: 'StructuredOutput', input }] }
}

// ── Segnali tool ──────────────────────────────────────────────────────────────
describe('markToolSignal / consumeToolSignals', () => {
  it('set e consume: il consume ritorna i segnali e svuota la mappa', () => {
    markToolSignal('conv-1', 'pdf_saved')
    markToolSignal('conv-1', 'project_closed')
    const got = consumeToolSignals('conv-1')
    expect(got.has('pdf_saved')).toBe(true)
    expect(got.has('project_closed')).toBe(true)
    // consume svuota: una seconda lettura è vuota
    expect(consumeToolSignals('conv-1').size).toBe(0)
  })

  it('conversazioni isolate: un segnale su conv-A non appare su conv-B', () => {
    markToolSignal('conv-A', 'pdf_saved')
    expect(consumeToolSignals('conv-B').size).toBe(0)
    expect(consumeToolSignals('conv-A').has('pdf_saved')).toBe(true)
  })

  it('conversationId vuoto è no-op', () => {
    markToolSignal('', 'pdf_saved')
    expect(consumeToolSignals('').size).toBe(0)
  })
})

// ── Approval ──────────────────────────────────────────────────────────────────
describe('isApproval', () => {
  it("'perfetto' → true", () => {
    expect(isApproval('perfetto')).toBe(true)
  })
  it("frase lunga interrogativa con 'perfetto' dentro → false", () => {
    expect(isApproval('mi spieghi se è perfetto fare X?')).toBe(false)
  })
  it("'ok così' e 'ottimo' → true; stringa vuota → false", () => {
    expect(isApproval('ok così')).toBe(true)
    expect(isApproval('ottimo')).toBe(true)
    expect(isApproval('')).toBe(false)
  })
})

// ── Gate ──────────────────────────────────────────────────────────────────────
describe('passesGate', () => {
  it('pdfSaved → true sempre (anche senza progetto, task altro)', () => {
    const sig: DebriefSignals = { pdfSaved: true, projectClosed: false, approval: false }
    expect(passesGate(sig, false, 'altro')).toBe(true)
  })
  it('approval senza progetto e task_type=altro → false', () => {
    const sig: DebriefSignals = { pdfSaved: false, projectClosed: false, approval: true }
    expect(passesGate(sig, false, 'altro')).toBe(false)
  })
  it('approval con progetto attivo → true', () => {
    const sig: DebriefSignals = { pdfSaved: false, projectClosed: false, approval: true }
    expect(passesGate(sig, true, 'altro')).toBe(true)
  })
  it('approval con task_type riconosciuto (pos) → true', () => {
    const sig: DebriefSignals = { pdfSaved: false, projectClosed: false, approval: true }
    expect(passesGate(sig, false, 'pos')).toBe(true)
  })
})

// ── Cooldown ──────────────────────────────────────────────────────────────────
describe('inCooldown', () => {
  const now = Date.now()
  it('ultimo debrief 5 min fa → true', () => {
    expect(inCooldown(new Date(now - 5 * 60_000).toISOString(), now)).toBe(true)
  })
  it('ultimo debrief 20 min fa → false', () => {
    expect(inCooldown(new Date(now - 20 * 60_000).toISOString(), now)).toBe(false)
  })
  it('null → false', () => {
    expect(inCooldown(null, now)).toBe(false)
  })
  it('iso non valido → false', () => {
    expect(inCooldown('non-una-data', now)).toBe(false)
  })
})

// ── isAutoDebriefEnabled ──────────────────────────────────────────────────────
describe('isAutoDebriefEnabled', () => {
  it("value 'true' → true", async () => {
    setFlag(true)
    expect(await isAutoDebriefEnabled()).toBe(true)
  })
  it("value 'false' → false", async () => {
    setFlag(false)
    expect(await isAutoDebriefEnabled()).toBe(false)
  })
  it('errore DB → false (fail-closed)', async () => {
    mockMaybeSingle.mockResolvedValue({ data: null, error: { message: 'boom' } })
    expect(await isAutoDebriefEnabled()).toBe(false)
  })
})

// ── applyDebrief ──────────────────────────────────────────────────────────────
describe('applyDebrief', () => {
  it('confidence < 0.6 → non scrive nulla', async () => {
    const r: DebriefResult = {
      task_type: 'pos',
      is_new_type: false,
      strategy_steps: ['passo 1'],
      sources: { DVR: 'drive://x' },
      output_preferences: ['tabella bordata'],
      lessons: ['lezione 1'],
      confidence: { strategy_steps: 0.5, sources: 0.5, output_preferences: 0.5, lessons: 0.5 },
    }
    const applied = await applyDebrief('conv-1', r)
    expect(applied).toEqual([])
    expect(mockCreateProcedure).not.toHaveBeenCalled()
    expect(mockMergeChecklistSteps).not.toHaveBeenCalled()
    expect(mockAddLesson).not.toHaveBeenCalled()
    expect(mockSetOutputPreferences).not.toHaveBeenCalled()
    expect(mockSetActiveProject).not.toHaveBeenCalled()
  })

  it('is_new_type=true con strategy_steps≥0.6 → createProcedure', async () => {
    const r: DebriefResult = {
      task_type: 'nuovo-tipo',
      is_new_type: true,
      strategy_steps: ['passo A', 'passo B'],
      sources: {},
      save_location: 'cantiere/X',
      output_preferences: [],
      lessons: [],
      confidence: { strategy_steps: 0.9 },
    }
    const applied = await applyDebrief('conv-1', r)
    expect(mockCreateProcedure).toHaveBeenCalledTimes(1)
    expect(mockCreateProcedure).toHaveBeenCalledWith(
      expect.objectContaining({ taskType: 'nuovo-tipo', checklist: ['passo A', 'passo B'], saveLocation: 'cantiere/X' }),
    )
    expect(applied).toContain('nuova procedura nuovo-tipo')
  })

  it('lessons≥0.6 → addLesson per ognuna', async () => {
    const r: DebriefResult = {
      task_type: 'pos',
      is_new_type: false,
      strategy_steps: [],
      sources: {},
      output_preferences: [],
      lessons: ['le firme dal DVR', 'tabella bordata sempre'],
      confidence: { lessons: 0.95 },
    }
    await applyDebrief('conv-1', r)
    expect(mockAddLesson).toHaveBeenCalledTimes(2)
    expect(mockAddLesson).toHaveBeenCalledWith('pos', 'le firme dal DVR')
    expect(mockAddLesson).toHaveBeenCalledWith('pos', 'tabella bordata sempre')
  })

  it('sources≥0.6 → setActiveProject con key_files', async () => {
    const r: DebriefResult = {
      task_type: 'pos',
      is_new_type: false,
      strategy_steps: [],
      sources: { DVR: 'drive://dvr', CME: 'sheet://cme' },
      output_preferences: [],
      lessons: [],
      confidence: { sources: 0.8 },
    }
    await applyDebrief('conv-1', r)
    expect(mockSetActiveProject).toHaveBeenCalledWith('conv-1', {
      key_files: { DVR: 'drive://dvr', CME: 'sheet://cme' },
    })
  })

  it('normalizza il task_type (POS → pos) per TUTTI gli helper, incluso addLesson', async () => {
    const r: DebriefResult = {
      task_type: 'POS',
      is_new_type: false,
      strategy_steps: ['s1'],
      sources: {},
      output_preferences: ['pref'],
      lessons: ['lez'],
      confidence: { strategy_steps: 0.9, output_preferences: 0.9, lessons: 0.9 },
    }
    await applyDebrief('conv-1', r)
    expect(mockMergeChecklistSteps).toHaveBeenCalledWith('pos', ['s1'])
    expect(mockAddLesson).toHaveBeenCalledWith('pos', 'lez')
    expect(mockSetOutputPreferences).toHaveBeenCalledWith('pos', ['pref'])
  })
})

// ── maybeRunDebrief (orchestratore) ───────────────────────────────────────────
describe('maybeRunDebrief', () => {
  it('flag OFF → runDebrief (Anthropic) mai chiamato', async () => {
    setFlag(false)
    markToolSignal('conv-1', 'pdf_saved')
    await maybeRunDebrief({ conversationId: 'conv-1', userText: '', transcript: 't' })
    expect(mockCreate).not.toHaveBeenCalled()
    // segnali consumati? no: usciamo prima del consume → restano (best-effort, accettabile)
  })

  it('nessun segnale (no tool, no approval) → return senza distillazione', async () => {
    setFlag(true)
    await maybeRunDebrief({ conversationId: 'conv-1', userText: 'ciao come va', transcript: 't' })
    expect(mockCreate).not.toHaveBeenCalled()
    expect(mockGetActiveProject).not.toHaveBeenCalled()
  })

  it('pdf_saved + gate ok → runDebrief + applyDebrief + setLastDebriefAt + sendSummary', async () => {
    setFlag(true)
    mockCreate.mockResolvedValue(
      anthropicToolUse({
        task_type: 'pos',
        is_new_type: false,
        strategy_steps: ['s1'],
        sources: {},
        output_preferences: [],
        lessons: ['lez'],
        confidence: { strategy_steps: 0.9, lessons: 0.9 },
      }),
    )
    markToolSignal('conv-1', 'pdf_saved')
    const summaries: string[] = []
    await maybeRunDebrief({
      conversationId: 'conv-1',
      userText: '',
      transcript: 'transcript di lavoro',
      sendSummary: (l) => summaries.push(l),
    })
    expect(mockCreate).toHaveBeenCalledTimes(1)
    expect(mockMergeChecklistSteps).toHaveBeenCalledWith('pos', ['s1'])
    expect(mockAddLesson).toHaveBeenCalledWith('pos', 'lez')
    expect(mockSetLastDebriefAt).toHaveBeenCalledWith('conv-1', expect.any(String))
    expect(summaries.length).toBe(1)
    expect(summaries[0]).toContain('Ho imparato')
  })

  it('cooldown attivo (last_debrief_at 5 min fa) → skip prima di runDebrief', async () => {
    setFlag(true)
    mockGetActiveProject.mockResolvedValue({
      conversation_id: 'conv-1',
      status: 'active',
      key_files: {},
      done: [],
      pending: [],
      decisions: [],
      last_debrief_at: new Date(Date.now() - 5 * 60_000).toISOString(),
    })
    markToolSignal('conv-1', 'pdf_saved')
    await maybeRunDebrief({ conversationId: 'conv-1', userText: '', transcript: 't' })
    expect(mockCreate).not.toHaveBeenCalled()
    expect(mockSetLastDebriefAt).not.toHaveBeenCalled()
  })

  it('approval senza progetto e task_type=altro → gate fallisce, niente runDebrief', async () => {
    setFlag(true)
    mockInferTaskType.mockResolvedValue('altro')
    mockGetActiveProject.mockResolvedValue(null)
    await maybeRunDebrief({ conversationId: 'conv-1', userText: 'perfetto', transcript: 't' })
    expect(mockCreate).not.toHaveBeenCalled()
  })
})
