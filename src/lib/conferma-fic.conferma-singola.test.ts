/**
 * src/lib/conferma-fic.conferma-singola.test.ts — un incasso si conferma UNA volta.
 *
 * ⚠️ **Il criterio non è «semplice o complicata», è reversibile o no.**
 * Emettere una fattura è un atto fiscale che non si disfa: resta a due
 * passaggi. Registrare un incasso si cancella dall'interfaccia di Fatture in
 * Cloud in dieci secondi — e pretendere due «confermo» per una data e un
 * importo che l'Ingegnere ha appena letto nell'anteprima non è prudenza, è
 * attrito. Chiesto da Raffaele il 14 settembre 2026.
 *
 * ⚠️ E questo file nasce perché `conferma-fic.ts` **non aveva un solo test**,
 * pur essendo il punto in cui una scrittura contabile diventa definitiva. È lo
 * stesso difetto che oggi ha fatto perdere due giorni sulla fattura 19-ED: una
 * difesa scritta e mai provata sul percorso vero.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

/** ⚠️ `vi.hoisted`: una `const` normale finirebbe in TDZ sotto la factory issata. */
const { step1, step2, righe } = vi.hoisted(() => ({
  step1: vi.fn(async () => 'Anteprima pronta. Conferma con /fic_ok2_abc'),
  step2: vi.fn(async () => '✅ Scritto su Fatture in Cloud.'),
  righe: { valore: [] as Record<string, unknown>[] },
}))

vi.mock('./fic-write-tools', () => ({ confirmFicStep1: step1, confirmFicStep2: step2 }))

vi.mock('./supabase', () => {
  const q: Record<string, unknown> = {}
  for (const m of ['select', 'eq', 'gte', 'order']) q[m] = () => q
  q.limit = async () => ({ data: righe.valore, error: null })
  return { supabase: { from: () => q } }
})

import { confermaFicPiuRecente } from './conferma-fic'

function pending(tipo: string, over: Record<string, unknown> = {}) {
  return [{
    id: 'abc',
    conferme: 0,
    descrizione: 'Segno incassata la fattura 19-ED',
    created_at: new Date().toISOString(),
    societa: 'restruktura',
    tipo,
    ...over,
  }]
}

beforeEach(() => {
  // ⚠️ Corpo a BLOCCO: `() => step1.mockClear()` restituirebbe la spia, e
  // vitest la richiamerebbe come teardown dopo ogni test.
  step1.mockClear()
  step2.mockClear()
})

describe('un INCASSO si chiude con una conferma sola', () => {
  it('🚨 pagamento_emessa: un «confermo» scrive, senza chiederne un secondo', async () => {
    righe.valore = pending('pagamento_emessa')

    const esito = await confermaFicPiuRecente('restruktura')

    expect(step1).toHaveBeenCalledTimes(1)
    expect(step2).toHaveBeenCalledTimes(1)
    expect(esito.message).toContain('Scritto su Fatture in Cloud')
    // Non deve restare in giro la richiesta di una seconda conferma.
    expect(esito.message).not.toContain('un\'ultima volta')
  })

  it('pagamento_ricevuta: stessa regola, e la fa il registro non un if sparso', async () => {
    righe.valore = pending('pagamento_ricevuta')

    await confermaFicPiuRecente('restruktura')

    expect(step2).toHaveBeenCalledTimes(1)
  })
})

describe('CONTROLLO POSITIVO — quello che NON si disfa resta a due passaggi', () => {
  it('🚨 fattura_emessa: il primo «confermo» NON scrive, ne chiede un altro', async () => {
    // Senza questo, togliere la doppia conferma per TUTTI passerebbe i test
    // qui sopra — e una fattura potrebbe nascere con un «ok» distratto.
    righe.valore = pending('fattura_emessa', { descrizione: 'Creo la fattura 30-ED' })

    const esito = await confermaFicPiuRecente('restruktura')

    expect(step1).toHaveBeenCalledTimes(1)
    expect(step2).not.toHaveBeenCalled()
    expect(esito.message).toContain('Conferma DEFINITIVA')
  })

  it('rapporto_intervento: idem, resta doppia', async () => {
    righe.valore = pending('rapporto_intervento')

    await confermaFicPiuRecente('restruktura')

    expect(step2).not.toHaveBeenCalled()
  })

  it('un tipo sconosciuto resta PRUDENTE: doppia conferma', async () => {
    // Se domani nasce un tipo nuovo e nessuno aggiorna il registro, deve
    // ereditare il comportamento severo, non quello permissivo.
    righe.valore = pending('tipo_che_non_esiste_ancora')

    await confermaFicPiuRecente('restruktura')

    expect(step2).not.toHaveBeenCalled()
  })
})

describe('il primo passaggio che fallisce non diventa una scrittura', () => {
  it('🚨 se step1 non prepara niente, step2 NON parte nemmeno su un incasso', async () => {
    // `confirmFicStep1` segnala il guasto restituendo un testo senza il
    // comando del secondo passaggio: da lì non si va avanti.
    step1.mockResolvedValueOnce('❌ Non sono riuscito a preparare la scrittura.')
    righe.valore = pending('pagamento_emessa')

    const esito = await confermaFicPiuRecente('restruktura')

    expect(step2).not.toHaveBeenCalled()
    expect(esito.message).toContain('Non sono riuscito')
  })
})
