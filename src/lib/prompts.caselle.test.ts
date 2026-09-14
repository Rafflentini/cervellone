import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'
import { listaCaselle } from './caselle'

const PROMPT = fs.readFileSync(path.join(process.cwd(), 'src', 'lib', 'prompts.ts'), 'utf8')

describe('il prompt e il registro non possono divergere', () => {
  it('🚨 ogni casella del registro e NOMINATA nel prompt', () => {
    // Il prompt e' la mappa che il modello usa per sapere cosa puo' fare. Se il
    // registro ne conosce quattro e il prompt tre, il bot rifiuta una posta a
    // cui ha accesso — da un difetto al suo opposto.
    const mancanti = listaCaselle()
      .map((c) => c.indirizzo)
      .filter((indirizzo) => !PROMPT.includes(indirizzo))

    expect(mancanti, `caselle nel registro ma non nel prompt: ${mancanti.join(', ')}`).toEqual([])
  })

  it('il prompt non dice piu che i tool Gmail lavorano su UNA casella sola', () => {
    expect(PROMPT).not.toMatch(/tool gmail_\*\)?:?\s*$/im)
    expect(PROMPT).toMatch(/casella .*OBBLIGATORIA|di' SEMPRE da quale casella/i)
  })
})
