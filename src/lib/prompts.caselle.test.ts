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
    // LA DECISIONE, 14 settembre 2026 (audit avversariale): la regex
    // originaria (`/tool gmail_\*\)?:?\s*$/im`) era `false` ANCHE sul prompt
    // vecchio — misurato girandola sul commit 7ca173d, prima di questo lavoro
    // — quindi non poteva mai diventare rossa e non provava niente. La vecchia
    // intestazione vera era `REGOLA TOOL GMAIL (Google API OAuth, account
    // restruktura.drive@gmail.com):`: e' QUESTA la stringa che deve sparire.
    expect(PROMPT).not.toMatch(/account restruktura\.drive@gmail\.com\)/i)
    // E il rimpiazzo afferma esplicitamente che sono due, non una.
    expect(PROMPT).toMatch(/le caselle Google sono DUE/i)
    expect(PROMPT).toMatch(/casella .*OBBLIGATORIA|di' SEMPRE da quale casella/i)
  })
})
