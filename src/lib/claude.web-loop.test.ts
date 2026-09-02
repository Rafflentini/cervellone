/**
 * Il loop web deve eseguire un tool anche quando il modello NON scrive testo
 * prima di chiamarlo.
 *
 * Incidente 2026-09-02: sulla chat web il bot scriveva "Verifico le colonne del
 * Registro Cantieri..." e il turno finiva li'. Nessun tool eseguito, nessun
 * errore. Su Telegram lo stesso flusso funzionava.
 *
 * La differenza e' che il solo loop web contiene `if (!iterationHasText && i > 0) break`:
 * una iterazione che chiama un tool SENZA preambolo testuale interrompe la run in
 * silenzio. Incatenare due tool (leggi intestazione -> scrivi riga) senza narrare
 * in mezzo e' comportamento normale del modello, quindi il turno moriva a meta'.
 *
 * Prova che il difetto e' quello e non il modello: qui il modello chiede
 * ESPLICITAMENTE il secondo tool. Se il secondo tool non viene eseguito, e' il
 * loop ad averlo buttato via.
 *
 * Nessuna rete: SDK, tool, Supabase e memoria sono mockati.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Anthropic SDK: uno stream finto per iterazione, guidato da `scriptedTurns` ──
type FakeEvent = Record<string, unknown>
interface FakeTurn {
  /** testo emesso in delta durante l'iterazione (vuoto = nessun text_delta) */
  text: string
  /** blocchi tool_use richiesti dal modello in questa iterazione */
  toolUses: Array<{ id: string; name: string; input: Record<string, unknown> }>
  stopReason: string
}

let scriptedTurns: FakeTurn[] = []
let turnIndex = 0

const mockStream = vi.fn(() => {
  const turn = scriptedTurns[Math.min(turnIndex, scriptedTurns.length - 1)]
  turnIndex++

  const events: FakeEvent[] = []
  if (turn.text) {
    events.push({ type: 'content_block_delta', delta: { type: 'text_delta', text: turn.text } })
  }
  for (const t of turn.toolUses) {
    events.push({ type: 'content_block_start', content_block: { type: 'tool_use', id: t.id, name: t.name } })
  }

  const content = [
    ...(turn.text ? [{ type: 'text', text: turn.text }] : []),
    ...turn.toolUses.map(t => ({ type: 'tool_use', id: t.id, name: t.name, input: t.input })),
  ]

  return {
    async *[Symbol.asyncIterator]() { for (const e of events) yield e },
    finalMessage: async () => ({
      content,
      stop_reason: turn.stopReason,
      usage: { input_tokens: 10, output_tokens: 10 },
    }),
  }
})

vi.mock('@anthropic-ai/sdk', () => {
  class FakeAnthropic {
    messages = { stream: (...a: unknown[]) => mockStream(...(a as [])) }
    models = { retrieve: async () => ({ id: 'claude-sonnet-5' }) }
  }
  return { default: FakeAnthropic }
})

// ── Tool: registriamo ogni esecuzione ──
const executedTools: string[] = []
const mockExecuteTool = vi.fn(async (name: string, _input?: Record<string, unknown>, _convId?: string) => {
  executedTools.push(name)
  return JSON.stringify({ ok: true, tool: name })
})
vi.mock('@/lib/tools', () => ({
  getToolDefinitions: () => [{ name: 'leggi_intestazione_registro' }, { name: 'scrivi_riga_registro' }],
  executeTool: (name: string, input: Record<string, unknown>, convId?: string) =>
    mockExecuteTool(name, input, convId),
}))
vi.mock('./tools', () => ({
  getToolDefinitions: () => [{ name: 'leggi_intestazione_registro' }, { name: 'scrivi_riga_registro' }],
  executeTool: (name: string, input: Record<string, unknown>, convId?: string) =>
    mockExecuteTool(name, input, convId),
}))

// ── Contorno inerte ──
vi.mock('./memory', () => ({
  searchMemory: async () => '',
  saveMessageWithEmbedding: async () => undefined,
}))
vi.mock('./supabase', () => ({
  supabase: { from: () => ({ select: () => ({ in: async () => ({ data: [] }) }) }) },
}))
vi.mock('./api-usage', async (orig) => {
  const actual = await orig<typeof import('./api-usage')>()
  return { ...actual, logApiUsage: async () => undefined }
})
vi.mock('./cheap-routing', () => ({
  shouldUseCheapModel: async () => false,
  CHEAP_MODEL: 'claude-haiku-4-5-20251001',
}))
vi.mock('./telegram-helpers', () => ({ sendTelegramMessage: async () => undefined }))

import { callClaudeStream } from './claude'

beforeEach(() => {
  turnIndex = 0
  executedTools.length = 0
  mockExecuteTool.mockClear()
  mockStream.mockClear()
})

function run() {
  return callClaudeStream(
    {
      systemPrompt: 'system',
      userQuery: 'crea il cantiere sul Registro',
      messages: [{ role: 'user', content: 'crea il cantiere sul Registro' }],
      entryPoint: 'chat',
    } as Parameters<typeof callClaudeStream>[0],
    { onText: () => {} },
  )
}

describe('callClaudeStream — tool concatenati senza testo in mezzo', () => {
  it('esegue il secondo tool anche se l iterazione non ha emesso testo', async () => {
    scriptedTurns = [
      // it.1: il modello annuncia e legge l'intestazione
      {
        text: 'Verifico le colonne del Registro Cantieri per compilare la riga correttamente.',
        toolUses: [{ id: 't1', name: 'leggi_intestazione_registro', input: {} }],
        stopReason: 'tool_use',
      },
      // it.2: incatena la scrittura SENZA preambolo testuale — il caso dell'incidente
      {
        text: '',
        toolUses: [{ id: 't2', name: 'scrivi_riga_registro', input: { committente: 'La Colla Domenico' } }],
        stopReason: 'tool_use',
      },
      // it.3: riferisce l'esito
      { text: 'Fatto: riga creata sul Registro.', toolUses: [], stopReason: 'end_turn' },
    ]

    const out = await run()

    expect(executedTools).toEqual(['leggi_intestazione_registro', 'scrivi_riga_registro'])
    expect(out).toContain('Fatto')
  })

  it('non lascia il turno muto quando il modello parte subito con un tool', async () => {
    scriptedTurns = [
      // it.1: nessun testo, va dritto al tool
      { text: '', toolUses: [{ id: 't1', name: 'leggi_intestazione_registro', input: {} }], stopReason: 'tool_use' },
      // it.2: ancora nessun testo, secondo tool
      { text: '', toolUses: [{ id: 't2', name: 'scrivi_riga_registro', input: {} }], stopReason: 'tool_use' },
      // it.3: finalmente risponde
      { text: 'Riga creata.', toolUses: [], stopReason: 'end_turn' },
    ]

    const out = await run()

    expect(executedTools).toEqual(['leggi_intestazione_registro', 'scrivi_riga_registro'])
    // il sintomo utente: risposta a zero caratteri
    expect(out.length).toBeGreaterThan(0)
  })

  it('non restituisce mai una risposta muta: se il modello non scrive mai, lo dice', async () => {
    // Il modello chiude il turno senza produrre un solo blocco di testo.
    // Prima l'utente riceveva 0 caratteri, indistinguibile da un bot che ignora.
    scriptedTurns = [{ text: '', toolUses: [], stopReason: 'end_turn' }]

    const out = await run()

    expect(out).toContain('Non sono riuscito a sintetizzare')
  })
})
