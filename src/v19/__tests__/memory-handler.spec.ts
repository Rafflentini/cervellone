import { describe, it, expect } from 'vitest'
import { handleMemoryToolCall } from '../memory/handler'

function makeMockStorage() {
  const files = new Map<string, string>()
  return {
    files,
    storage: {
      viewFile: async (rel: string) => files.get(rel) ?? null,
      viewDir: async (prefix: string) => {
        const dir = prefix.endsWith('/') ? prefix.slice(0, -1) : prefix
        const result: string[] = []
        for (const k of files.keys()) {
          if (k.startsWith(dir + '/')) result.push(k)
        }
        return result
      },
      createFile: async (rel: string, content: string) => {
        files.set(rel, content)
      },
      strReplace: async (rel: string, oldS: string, newS: string) => {
        const cur = files.get(rel)
        if (cur === undefined) throw new Error('file not found')
        if (!cur.includes(oldS)) throw new Error('old_str not found')
        files.set(rel, cur.replace(oldS, newS))
      },
      insertLine: async (rel: string, line: number, text: string) => {
        const cur = files.get(rel) ?? ''
        const lines = cur.split('\n')
        lines.splice(line, 0, text)
        files.set(rel, lines.join('\n'))
      },
      deleteFile: async (rel: string) => {
        files.delete(rel)
      },
      renameFile: async (oldR: string, newR: string) => {
        const cur = files.get(oldR)
        if (cur === undefined) throw new Error('file not found')
        files.set(newR, cur)
        files.delete(oldR)
      },
    },
  }
}

describe('handleMemoryToolCall', () => {
  it('view su file esistente ritorna contenuto', async () => {
    const m = makeMockStorage()
    m.files.set('raffaele/identita.md', '# Identità\nIng. Raffaele Lentini')
    const r = await handleMemoryToolCall(
      { command: 'view', path: '/memories/raffaele/identita.md' },
      'raffaele',
      { storage: m.storage },
    )
    expect(r).toContain('Ing. Raffaele Lentini')
  })

  it('view su file inesistente ritorna placeholder', async () => {
    const m = makeMockStorage()
    const r = await handleMemoryToolCall(
      { command: 'view', path: '/memories/raffaele/inesistente.md' },
      'raffaele',
      { storage: m.storage },
    )
    expect(r).toContain('non trovato')
  })

  it('create scrive un nuovo file', async () => {
    const m = makeMockStorage()
    const r = await handleMemoryToolCall(
      { command: 'create', path: '/memories/raffaele/test.md', file_text: 'contenuto' },
      'raffaele',
      { storage: m.storage },
    )
    expect(r).toMatch(/^OK/)
    expect(m.files.get('raffaele/test.md')).toBe('contenuto')
  })

  it('str_replace aggiorna contenuto esistente', async () => {
    const m = makeMockStorage()
    m.files.set('raffaele/x.md', 'hello world')
    await handleMemoryToolCall(
      { command: 'str_replace', path: '/memories/raffaele/x.md', old_str: 'world', new_str: 'V19' },
      'raffaele',
      { storage: m.storage },
    )
    expect(m.files.get('raffaele/x.md')).toBe('hello V19')
  })

  it('delete rimuove file', async () => {
    const m = makeMockStorage()
    m.files.set('raffaele/y.md', 'bye')
    await handleMemoryToolCall(
      { command: 'delete', path: '/memories/raffaele/y.md' },
      'raffaele',
      { storage: m.storage },
    )
    expect(m.files.has('raffaele/y.md')).toBe(false)
  })

  it('rename sposta file', async () => {
    const m = makeMockStorage()
    m.files.set('raffaele/old.md', 'contenuto')
    await handleMemoryToolCall(
      { command: 'rename', path: '/memories/raffaele/old.md', new_path: '/memories/raffaele/new.md' },
      'raffaele',
      { storage: m.storage },
    )
    expect(m.files.has('raffaele/old.md')).toBe(false)
    expect(m.files.get('raffaele/new.md')).toBe('contenuto')
  })

  it('REJECT path traversal verso altro userId', async () => {
    const m = makeMockStorage()
    m.files.set('altro/segreto.md', 'top secret')
    await expect(
      handleMemoryToolCall(
        { command: 'view', path: '/memories/altro/segreto.md' },
        'raffaele',
        { storage: m.storage },
      ),
    ).rejects.toThrow(/Path traversal|non appartiene/i)
  })

  it('REJECT path senza prefisso /memories/', async () => {
    const m = makeMockStorage()
    await expect(
      handleMemoryToolCall(
        { command: 'view', path: '/etc/passwd' as any },
        'raffaele',
        { storage: m.storage },
      ),
    ).rejects.toThrow(/deve iniziare con/i)
  })
})
