import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'
import { oggettiAttesi } from './deriva-schema'
import ATTESI from './deriva-schema-attesi.json'

/**
 * L'elenco congelato DEVE combaciare con le migrazioni vere.
 *
 * Un elenco scritto a mano invecchia in silenzio, ed e' cosi' che nasce il
 * problema che questo guardiano risolve. Qui l'elenco e' generato, e questo
 * test e' il patto: se qualcuno aggiunge una migrazione e non rigenera, la
 * suite muore.
 */
const CARTELLA = path.join(process.cwd(), 'supabase', 'migrations')

function daDisco() {
  const nomi = fs.readdirSync(CARTELLA).filter((n) => n.endsWith('.sql')).sort()
  return oggettiAttesi(nomi.map((nome) => ({ nome, sql: fs.readFileSync(path.join(CARTELLA, nome), 'utf8') })))
}

describe('deriva-schema-attesi.json', () => {
  it('non e vuoto: zero oggetti su 43 migrazioni vuol dire parser rotto', () => {
    // Un `forEach` su zero elementi e' verde e non prova niente.
    expect(ATTESI.oggetti.length).toBeGreaterThan(20)
  })

  it('e FRESCO: combacia con i file .sql di oggi', () => {
    expect(ATTESI).toEqual(JSON.parse(JSON.stringify(daDisco())))
  })

  it('dichiara quanti statement non sa leggere, e il numero e VISIBILE', () => {
    expect(Array.isArray(ATTESI.nonInterpretate)).toBe(true)
    // Non si pretende che sia zero: si pretende che sia detto.
    expect(typeof ATTESI.nonInterpretate.length).toBe('number')
  })
})
