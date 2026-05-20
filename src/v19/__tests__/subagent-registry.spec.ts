import { describe, it, expect } from 'vitest'
import { SUBAGENT_REGISTRY, filterToolsForSubagent, getSubagentDefinition } from '../agent/subagent-registry'

const mockTools = [
  { name: 'web_search', description: 'web', input_schema: { type: 'object' as const, properties: {} } },
  { name: 'web_fetch', description: 'web', input_schema: { type: 'object' as const, properties: {} } },
  { name: 'code_execution', description: 'sandbox', input_schema: { type: 'object' as const, properties: {} } },
  { name: 'read_email', description: 'list inbox', input_schema: { type: 'object' as const, properties: {} } },
  { name: 'get_email_body', description: 'read body', input_schema: { type: 'object' as const, properties: {} } },
  { name: 'mark_email', description: 'flag/move', input_schema: { type: 'object' as const, properties: {} } },
  { name: 'send_email', description: 'send', input_schema: { type: 'object' as const, properties: {} } },
  { name: 'forward_email', description: 'forward', input_schema: { type: 'object' as const, properties: {} } },
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

  it('mail-router ha read/get/mark ma NON send/forward (policy conferma utente nel parent)', () => {
    const filtered = filterToolsForSubagent(mockTools, 'mail-router')
    const names = filtered.map((t) => t.name)
    expect(names).toContain('read_email')
    expect(names).toContain('get_email_body')
    expect(names).toContain('mark_email')
    expect(names).not.toContain('send_email')
    expect(names).not.toContain('forward_email')
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
