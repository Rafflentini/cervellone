import { describe, it, expect } from 'vitest'
import { SUBAGENT_REGISTRY, filterToolsForSubagent, getSubagentDefinition } from '../agent/subagent-registry'

const mockTools = [
  { name: 'web_search', description: 'web', input_schema: { type: 'object' as const, properties: {} } },
  { name: 'web_fetch', description: 'web', input_schema: { type: 'object' as const, properties: {} } },
  { name: 'code_execution', description: 'sandbox', input_schema: { type: 'object' as const, properties: {} } },
  { name: 'gmail_send_draft', description: 'send', input_schema: { type: 'object' as const, properties: {} } },
  { name: 'gmail_create_draft', description: 'draft', input_schema: { type: 'object' as const, properties: {} } },
  { name: 'genera_docx_v19', description: 'docx', input_schema: { type: 'object' as const, properties: {} } },
] as any

describe('subagent registry', () => {
  it('ha 6 sub-agent definiti', () => {
    expect(Object.keys(SUBAGENT_REGISTRY)).toHaveLength(6)
  })

  it('domain-italiano ha access a web_search ma NON a code_execution', () => {
    const filtered = filterToolsForSubagent(mockTools, 'domain-italiano')
    expect(filtered.map((t) => t.name)).toContain('web_search')
    expect(filtered.map((t) => t.name)).not.toContain('code_execution')
  })

  it('numerical-engine ha access a code_execution', () => {
    const filtered = filterToolsForSubagent(mockTools, 'numerical-engine')
    expect(filtered.map((t) => t.name)).toContain('code_execution')
  })

  it('gmail-router NON ha access a gmail_send_draft (mai send via subagent)', () => {
    const filtered = filterToolsForSubagent(mockTools, 'gmail-router')
    expect(filtered.map((t) => t.name)).toContain('gmail_create_draft')
    expect(filtered.map((t) => t.name)).not.toContain('gmail_send_draft')
  })

  it('document-render ha access a genera_docx_v19', () => {
    const filtered = filterToolsForSubagent(mockTools, 'document-render')
    expect(filtered.map((t) => t.name)).toContain('genera_docx_v19')
  })

  it('getSubagentDefinition lancia su kind sconosciuto', () => {
    expect(() => getSubagentDefinition('inesistente' as any)).toThrow(/sconosciuto/i)
  })

  it('ogni system prompt menziona Restruktura (case-insensitive)', () => {
    for (const def of Object.values(SUBAGENT_REGISTRY)) {
      expect(def.systemPrompt.toLowerCase()).toContain('restruktura')
    }
  })
})
