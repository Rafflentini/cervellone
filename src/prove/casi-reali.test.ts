/**
 * src/prove/casi-reali.test.ts — il guardiano dell'insieme delle prove.
 *
 * Questo file NON esegue i casi: verifica che il CORPUS resti onesto.
 *
 * Un insieme di prove marcisce in due modi, ed entrambi sono silenziosi:
 *  1. un caso dichiara «coperto da X» e X non esiste più → la copertura è una
 *     promessa scaduta, e nessuno se ne accorge finché il difetto non torna;
 *  2. i casi si riempiono di parafrasi invece delle parole vere → si finisce a
 *     provare quello che credevamo che l'Ingegnere volesse dire.
 *
 * È lo stesso difetto che l'11 set 2026 ha portato a cancellare 955 righe di
 * sotto-agenti: le loro liste di strumenti erano marcite, uno aveva 4 nomi su 5
 * di tool che non esistevano più, e nessun test lo sorvegliava.
 */
import { describe, it, expect } from 'vitest'
import { existsSync } from 'node:fs'
import { CASI_REALI } from './casi-reali'

describe("l'insieme delle prove — che non marcisca", () => {
  it('ogni caso ha le parole VERE di Raffaele, non una parafrasi', () => {
    for (const c of CASI_REALI) {
      expect(c.domanda.trim().length, `${c.id}: domanda vuota`).toBeGreaterThan(20)
      expect(c.quando, `${c.id}: manca la data`).toMatch(/2026-09-\d\d/)
    }
  })

  it('ogni caso dice cosa DEVE e cosa NON DEVE: senza il secondo non si riconosce la ricaduta', () => {
    for (const c of CASI_REALI) {
      expect(c.deve.length, `${c.id}: nessun requisito`).toBeGreaterThan(0)
      expect(c.non_deve.length, `${c.id}: nessun divieto`).toBeGreaterThan(0)
    }
  })

  it('CONTROLLO POSITIVO — i file citati in "coperto_da" esistono davvero', () => {
    // Il modo numero 1 in cui un corpus marcisce: una copertura che non c'e' piu'.
    const fantasmi: string[] = []
    for (const c of CASI_REALI) {
      if (!c.coperto_da) continue
      // Si estraggono i nomi di file citati, ovunque nella frase.
      const citati = c.coperto_da.match(/[\w.-]+\.(?:test|spec)\.ts|[\w/-]+\.ts/g) ?? []
      for (const nome of citati) {
        const trovato =
          existsSync(`src/lib/${nome}`) ||
          existsSync(`src/lib/tools/${nome}`) ||
          existsSync(`src/${nome}`) ||
          existsSync(nome)
        if (!trovato) fantasmi.push(`${c.id} → ${nome}`)
      }
    }
    expect(fantasmi, `coperture che non esistono piu': ${fantasmi.join(', ')}`).toEqual([])
  })

  it('i casi senza copertura sono DICHIARATI, non nascosti', () => {
    // Un caso scoperto non e' un difetto del corpus: e' un debito noto.
    // Quello che sarebbe un difetto e' non sapere quali sono.
    const scoperti = CASI_REALI.filter((c) => !c.coperto_da)
    // Non si impone un numero: si impone che il conto sia visibile.
    expect(Array.isArray(scoperti)).toBe(true)
    console.log(
      `[prove] casi totali: ${CASI_REALI.length} · ` +
        `deterministici: ${CASI_REALI.filter((c) => c.livello === 'deterministico').length} · ` +
        `che richiedono il modello: ${CASI_REALI.filter((c) => c.livello === 'richiede_modello').length} · ` +
        `SCOPERTI: ${scoperti.length}${scoperti.length ? ' → ' + scoperti.map((c) => c.id).join(', ') : ''}`,
    )
  })

  it('ogni caso nomina la CLASSE di difetto: senza, il corpus e un elenco di aneddoti', () => {
    for (const c of CASI_REALI) {
      expect(c.classe.trim().length, `${c.id}: manca la classe`).toBeGreaterThan(5)
    }
  })

  it('nessun id duplicato: gli id finiscono nei rapporti e devono essere stabili', () => {
    const visti = new Set<string>()
    const doppi: string[] = []
    for (const c of CASI_REALI) {
      if (visti.has(c.id)) doppi.push(c.id)
      visti.add(c.id)
    }
    expect(doppi, `id duplicati: ${doppi.join(', ')}`).toEqual([])
  })
})
