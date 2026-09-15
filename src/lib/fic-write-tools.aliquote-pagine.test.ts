/**
 * src/lib/fic-write-tools.aliquote-pagine.test.ts — l'elenco delle aliquote
 * non si legge dieci volte.
 *
 * ⚠️ Trovato nel LOG DELLE RICHIESTE dell'app su Fatture in Cloud, il 15
 * settembre 2026: `GET settings/vat_types` chiamato DIECI volte in quattro
 * secondi, tutte identiche.
 *
 * La causa: quell'endpoint non e' paginato — ignora `page` e restituisce ogni
 * volta la stessa lista intera. Il ciclo si fermava solo su una pagina VUOTA o
 * su `last_page`, che li' non arriva: quindi girava tutte e dieci le volte e
 * `righe` finiva per contenere ogni aliquota DIECI VOLTE.
 *
 * Non era solo spreco: l'elenco che il tool mostra all'Ingegnere quando gli
 * chiede quale aliquota usare — l'unica cosa che legge prima di scegliere —
 * era dieci volte piu' lungo del vero.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const stato = { chiamate: 0 }

vi.mock('./fatture-in-cloud', async (importOriginal) => {
  const vero = await importOriginal<typeof import('./fatture-in-cloud')>()
  return {
    ...vero,
    getCompanyId: async () => ({ ok: true as const, id: 42 }),
    // Il comportamento VERO di FIC: `page` ignorato, sempre la stessa lista.
    ficGet: async () => {
      stato.chiamate++
      return {
        ok: true as const,
        data: { data: [{ id: 1, value: 22 }, { id: 2, value: 10 }] },
      }
    },
  }
})

import { elencoAliquoteFicPerTest } from './fic-write-tools'

beforeEach(() => { stato.chiamate = 0 })

describe('le aliquote si leggono una volta sola', () => {
  it('🚨 un endpoint non paginato viene interrogato UNA volta, non dieci', async () => {
    await elencoAliquoteFicPerTest('larealestate')

    expect(stato.chiamate).toBeLessThanOrEqual(2)
  }, 30_000)

  it('🚨 nessuna aliquota compare due volte nell elenco mostrato all Ingegnere', async () => {
    const esito = await elencoAliquoteFicPerTest('larealestate')

    expect(esito.ok).toBe(true)
    if (!esito.ok) return
    const ids = esito.righe.map((r) => String(r.id))
    expect(ids).toEqual([...new Set(ids)])
    expect(esito.righe).toHaveLength(2)
  }, 30_000)

  it('CONTROLLO POSITIVO: le aliquote VERE ci sono tutte, non si perde niente', async () => {
    // Senza questo, un ciclo che si ferma subito e restituisce una lista vuota
    // passerebbe i test qui sopra — e il tool direbbe «nessuna aliquota».
    const esito = await elencoAliquoteFicPerTest('larealestate')

    expect(esito.ok).toBe(true)
    if (!esito.ok) return
    expect(esito.righe.map((r) => r.value).sort()).toEqual([10, 22])
  }, 30_000)
})
