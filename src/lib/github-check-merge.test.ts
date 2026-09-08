/**
 * L'8 settembre 2026 il bot ha mergiato su `main` una PR che NON COMPILAVA: una
 * chiusura di commento finita dentro un commento rompeva `pdf-generator.ts`.
 * (E mi e' successo di nuovo scrivendo QUESTO file.) Il build di Vercel
 * falliva, il deploy non partiva, e per ore il bot e io abbiamo ragionato su
 * codice che non era in produzione — lui rigenerava PDF e concludeva che il
 * proprio fix "non funzionava".
 *
 * La CI esisteva dal 17 agosto e faceva `tsc --noEmit` + vitest: avrebbe visto
 * quell'errore. Ma il commento in cima a `ci.yml` diceva, testuale: "NON
 * impostare questi job come required status check finche' il bot che mergia le
 * PR non e' stato adeguato". Questo e' l'adeguamento.
 */
import { describe, test, expect } from 'vitest'
import { decidiSeMergiare, type StatoCheck } from './github-check-merge'

const verde: StatoCheck = { stato: 'success', inCorso: 0, falliti: [], totali: 2 }

describe('decidiSeMergiare', () => {
  test('con i controlli verdi si mergia', () => {
    expect(decidiSeMergiare(verde).mergia).toBe(true)
  })

  // IL CASO DELL'8 SETTEMBRE.
  test('se la CI e ROSSA non si mergia, e si dice quale job', () => {
    const esito = decidiSeMergiare({
      stato: 'failure', inCorso: 0, falliti: ['typecheck + unit'], totali: 2,
    })
    expect(esito.mergia).toBe(false)
    expect(esito.motivo).toContain('typecheck + unit')
  })

  test('se i controlli sono ancora IN CORSO si aspetta, non si tira a indovinare', () => {
    const esito = decidiSeMergiare({ stato: 'pending', inCorso: 1, falliti: [], totali: 2 })
    expect(esito.mergia).toBe(false)
    expect(esito.motivo).toMatch(/in corso/i)
  })

  // Il caso insidioso: nessun controllo configurato. Rispondere "verde" qui
  // significa esattamente la situazione dell'8 set — via libera senza che
  // nessuno abbia guardato niente.
  test('se NON esiste nessun controllo, non si spaccia per verde', () => {
    const esito = decidiSeMergiare({ stato: 'success', inCorso: 0, falliti: [], totali: 0 })
    expect(esito.mergia).toBe(false)
    expect(esito.motivo).toMatch(/nessun controllo/i)
  })

  test('un controllo forzato dall Ingegnere passa comunque', () => {
    const esito = decidiSeMergiare(
      { stato: 'failure', inCorso: 0, falliti: ['typecheck + unit'], totali: 2 },
      { forzato: true },
    )
    expect(esito.mergia).toBe(true)
    expect(esito.motivo).toMatch(/forzat/i)
  })
})
