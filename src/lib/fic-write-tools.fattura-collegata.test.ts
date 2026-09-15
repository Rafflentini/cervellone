/**
 * src/lib/fic-write-tools.fattura-collegata.test.ts — l'integrazione deve dire
 * QUALE fattura sta integrando, nel campo strutturato.
 *
 * ⚠️ Il 15 settembre 2026 l'Ingegnere ha fornito l'XML di una TD17 vera e
 * valida — integrazione di una fattura Dropbox Irlanda — e dentro c'era:
 *
 *     <DatiFattureCollegate>
 *       <IdDocumento>NC2CQNXC5QL2</IdDocumento>
 *       <Data>2025-12-18</Data>
 *     </DatiFattureCollegate>
 *
 * Fino a quel momento il nostro riferimento alla fattura estera viaggiava solo
 * nella riga e nelle note: testo che un umano legge e una macchina no. Il tool
 * lo dichiarava pure, come cosa «da controllare a mano su FIC» — dichiarare un
 * buco e' meglio che nasconderlo, ma resta un buco.
 *
 * ⚠️ Questo e' il primo pezzo della giornata deciso su una PROVA e non su un
 * sintomo: l'XML di un documento accettato, non l'etichetta di un PDF.
 */
import { describe, it, expect } from 'vitest'
import { eiRawIntegrazionePerTest } from './fic-write-tools'

const dentro = (ei: Record<string, unknown>) =>
  ((ei.FatturaElettronicaBody as Record<string, unknown>).DatiGenerali) as Record<string, unknown>

describe('il riferimento alla fattura estera sta nel campo strutturato', () => {
  it('🚨 IdDocumento e Data sono quelli della fattura ORIGINALE', () => {
    const ei = eiRawIntegrazionePerTest('TD17', { numero: '1660950537', data: '2026-08-03' })

    expect(dentro(ei).DatiFattureCollegate).toEqual({
      IdDocumento: '1660950537',
      Data: '2026-08-03',
    })
  })

  it('🚨 il tipo documento TD17 resta dov era: in ei_raw, non nel campo type', () => {
    const ei = eiRawIntegrazionePerTest('TD17', { numero: 'X', data: '2026-01-01' })

    expect(dentro(ei).DatiGeneraliDocumento).toEqual({ TipoDocumento: 'TD17' })
  })

  it('🚨 un riferimento a META non si scrive: o entrambi o niente', () => {
    // Un campo strutturato compilato a meta' su un documento fiscale e' peggio
    // di uno vuoto, perche' SEMBRA compilato.
    expect(dentro(eiRawIntegrazionePerTest('TD17', { numero: '123', data: '' })).DatiFattureCollegate).toBeUndefined()
    expect(dentro(eiRawIntegrazionePerTest('TD17', { numero: '', data: '2026-01-01' })).DatiFattureCollegate).toBeUndefined()
  })

  it('CONTROLLO POSITIVO: senza fattura collegata il blocco non c e, e il resto regge', () => {
    // Senza questo, una funzione che mettesse sempre il blocco (magari con
    // valori vuoti) passerebbe i test qui sopra.
    const ei = eiRawIntegrazionePerTest('TD17')

    expect(dentro(ei).DatiFattureCollegate).toBeUndefined()
    expect(dentro(ei).DatiGeneraliDocumento).toEqual({ TipoDocumento: 'TD17' })
  })
})
