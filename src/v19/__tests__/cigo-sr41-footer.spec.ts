/**
 * Il piede dell'SR41 (12 set 2026) — il gemello di `cigo-allegato10-footer.spec.ts`.
 *
 * `build-sr41.ts:73` scriveva `SR41 (placeholder) — Restruktura — Periodo …`
 * con la ragione sociale **cablata**, mentre il quadro A dello stesso documento
 * stampa `input.azienda.denominazione` **dai dati**. Su una pratica di un'altra
 * azienda il documento si contraddiceva da solo: il corpo diceva una cosa e il
 * piede un'altra, su un modulo destinato all'INPS.
 *
 * È il DODICESIMO punto dell'inventario, e l'ultimo trovato: lo ha visto
 * l'agente del Task 5 mentre lavorava su `build-allegato10.ts`, e lo ha
 * RIFERITO invece di correggerlo in silenzio, perché la nota di quel task
 * escludeva questo file. Il conto era «undici» in tre documenti diversi: la
 * misura a mano ha sbagliato quattro volte, e questa volta l'ha corretta un
 * agente che guardava un file vicino.
 *
 * Si guarda `buildSr41Doc` direttamente, senza passare dal render: estrarre il
 * testo da un Buffer .docx per sapere quale ragione sociale c'è scritta
 * significa misurare due cose insieme e non sapere quale ha sbagliato.
 */
import { describe, it, expect } from 'vitest'
import { buildSr41Doc } from '../tools/cigo/build-sr41'
import { fixtureCigoAprile2026 } from './fixtures/cigo-aprile-2026'
import type { Allegato10Input } from '../tools/cigo/types'

describe('buildSr41Doc — il piede non cabla piu la ragione sociale', () => {
  it('CONTROLLO POSITIVO: con una pratica di un\'altra azienda il piede NON dice "Restruktura"', () => {
    const inputAltraAzienda: Allegato10Input = {
      ...fixtureCigoAprile2026,
      azienda: {
        ...fixtureCigoAprile2026.azienda,
        denominazione: 'ACME COSTRUZIONI S.R.L.',
        codice_fiscale: '11111111111',
      },
    }
    const doc = buildSr41Doc(inputAltraAzienda)
    expect(doc.footer).toContain('ACME COSTRUZIONI S.R.L.')
    expect(doc.footer).not.toMatch(/restruktura/i)
  })

  it('CONTROLLO NEGATIVO: con la pratica di Restruktura il piede dice Restruktura — la cura non ha rotto il caso normale', () => {
    const doc = buildSr41Doc(fixtureCigoAprile2026)
    expect(doc.footer).toContain(fixtureCigoAprile2026.azienda.denominazione)
  })

  it('il piede e il corpo nominano la STESSA azienda: un documento non deve contraddirsi da solo', () => {
    const inputAltraAzienda: Allegato10Input = {
      ...fixtureCigoAprile2026,
      azienda: { ...fixtureCigoAprile2026.azienda, denominazione: 'ACME COSTRUZIONI S.R.L.' },
    }
    const doc = buildSr41Doc(inputAltraAzienda)
    // Il quadro A stampa la denominazione dai dati: cercarla nelle righe della
    // prima tabella prova che corpo e piede vengono dalla stessa fonte.
    const testoCorpo = JSON.stringify(doc.sections)
    expect(testoCorpo).toContain('ACME COSTRUZIONI S.R.L.')
    expect(doc.footer).toContain('ACME COSTRUZIONI S.R.L.')
  })
})
