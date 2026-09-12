/**
 * Il piede dell'Allegato 10 CIGO (Task 5).
 *
 * `build-allegato10.ts:257` scriveva la ragione sociale DUE VOLTE: una
 * cablata ("RESTRUKTURA S.r.l.") e una dai dati (`${input.azienda.denominazione}`).
 * Se la pratica fosse di un'altra azienda il piede si sarebbe contraddetto da
 * solo — "RESTRUKTURA S.r.l. — P.IVA <altra> — <ALTRA DENOMINAZIONE>" — e
 * nessuno se ne sarebbe accorto leggendo il codice, perche' sembra che il dato
 * venga dai dati. Qui si prova che il letterale e' sparito: si guarda
 * `buildAllegato10Doc` direttamente, senza passare dal render, per isolare il
 * dato dal formato.
 */
import { describe, it, expect } from 'vitest'
import { buildAllegato10Doc } from '../tools/cigo/build-allegato10'
import { fixtureCigoAprile2026 } from './fixtures/cigo-aprile-2026'
import type { Allegato10Input } from '../tools/cigo/types'

describe('buildAllegato10Doc — il piede non cabla piu la ragione sociale', () => {
  it('con una pratica di un\'altra azienda, il piede NON contiene "RESTRUKTURA S.r.l." cablato', () => {
    const inputAltraAzienda: Allegato10Input = {
      ...fixtureCigoAprile2026,
      azienda: {
        ...fixtureCigoAprile2026.azienda,
        denominazione: 'ACME COSTRUZIONI S.R.L.',
        codice_fiscale: '11111111111',
      },
    }
    const doc = buildAllegato10Doc(inputAltraAzienda)
    expect(doc.footer).toContain('ACME COSTRUZIONI S.R.L.')
    expect(doc.footer).toContain('11111111111')
    expect(doc.footer).not.toContain('RESTRUKTURA')
  })

  // CONTROLLO POSITIVO: senza questo, una funzione che avesse smesso del
  // tutto di scrivere la denominazione nel piede passerebbe il test sopra.
  it('CONTROLLO POSITIVO — con la pratica vera di Restruktura, il piede la contiene', () => {
    const doc = buildAllegato10Doc(fixtureCigoAprile2026)
    expect(doc.footer).toContain('RESTRUKTURA S.r.l.')
    expect(doc.footer).toContain('02087420762')
  })
})
