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
  it('non e vuoto: zero oggetti su 44 migrazioni vuol dire parser rotto', () => {
    // Un `forEach` su zero elementi e' verde e non prova niente.
    //
    // Il pavimento e' 450 perche' le migrazioni di oggi promettono 493
    // oggetti: cosi' il parser non puo' perderne piu' di una novantina
    // restando verde. Il vecchio pavimento (20) su 107 oggetti veri gli
    // lasciava perdere l'80% senza che nessuno se ne accorgesse -- il
    // difetto che questo file esiste per uccidere, dentro il file stesso.
    // ⚠️ L'audit chiedeva 90, cifra tarata sui 107 oggetti di allora: dopo i
    // reperti 1 e 2 gli oggetti veri sono 493 e 90 avrebbe rimesso il buco.
    // Se una migrazione nuova alza il conto, questo numero si alza con lei.
    expect(ATTESI.oggetti.length).toBeGreaterThan(450)
  })

  it('e FRESCO: combacia con i file .sql di oggi', () => {
    expect(ATTESI).toEqual(JSON.parse(JSON.stringify(daDisco())))
  })

  it('dichiara quanti statement non sa leggere, e ognuno dice DOVE e COSA', () => {
    expect(Array.isArray(ATTESI.nonInterpretate)).toBe(true)
    // Non si pretende che siano zero: si pretende che siano dichiarati per
    // davvero. `typeof length === 'number'` era una tautologia -- `length` e'
    // sempre un number -- e quel test non poteva fallire in nessun universo.
    // Qui si pretende che ogni voce abbia il file e il testo, perche' una voce
    // vuota gonfierebbe il numero senza dire niente a nessuno.
    for (const s of ATTESI.nonInterpretate) {
      expect(s.file).toMatch(/\.sql$/)
      expect(s.testo.trim().length).toBeGreaterThan(0)
    }
  })
})
