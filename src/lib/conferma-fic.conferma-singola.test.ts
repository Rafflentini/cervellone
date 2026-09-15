/**
 * src/lib/conferma-fic.conferma-singola.test.ts — il percorso VOCALE riporta
 * l'esito del primo passaggio, e non ne chiede un secondo di sua iniziativa.
 *
 * ⚠️ **Dove sta la regola, e perche' e' stata spostata.** Fino al 15 settembre
 * 2026 l'elenco dei tipi «a conferma singola» viveva in `conferma-fic.ts`,
 * cioe' governava solo il percorso vocale («confermo», «procedi»). I comandi
 * `/fic_ok_<id>` arrivano invece dalle rotte — `api/chat` e `api/telegram` —
 * che chiamano `confirmFicStep1` DIRITTO: la regola non passava di li'.
 *
 * Risultato: l'Ingegnere ha chiesto la conferma singola DUE volte, l'ha avuta
 * sul percorso vocale, e ha continuato a vedersene chiedere due perche' usava
 * i comandi. Ora la regola sta dentro `confirmFicStep1`, dove la vedono tutti
 * i chiamanti, e i due canali restano equipollenti senza ricordarselo in tre
 * posti.
 *
 * ⚠️ Cosa prova QUESTO file, allora: che il percorso vocale **riporta com'e'**
 * quello che il primo passaggio ha risposto — sia quando ha gia' scritto, sia
 * quando serve ancora una conferma — e che non chiama `confirmFicStep2` di
 * testa sua, perche' quello vorrebbe dire scrivere due volte.
 *
 * ⚠️ E questo file nasce perche' `conferma-fic.ts` non aveva un solo test, pur
 * essendo il punto in cui una scrittura contabile diventa definitiva.
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
  step1.mockResolvedValue('Anteprima pronta. Conferma con /fic_ok2_abc')
})

describe('quando il primo passaggio ha GIA scritto, non si chiede altro', () => {
  // E' quello che fa `confirmFicStep1` per i tipi a conferma singola: scrive e
  // restituisce l'esito, senza `/fic_ok2_` dentro.
  const ESITO = '✅ Scritto su Fatture in Cloud.'

  for (const tipo of ['pagamento_emessa', 'pagamento_ricevuta', 'spesa_ricevuta', 'fattura_emessa', 'rapporto_intervento', 'autofattura', 'modifica_documento']) {
    it(`🚨 ${tipo}: l esito arriva com e, e non parte una seconda scrittura`, async () => {
      step1.mockResolvedValue(ESITO)
      righe.valore = pending(tipo)

      const esito = await confermaFicPiuRecente('restruktura')

      expect(esito.intercettato).toBe(true)
      expect(esito.message).toBe(ESITO)
      expect(step1).toHaveBeenCalledTimes(1)
      // 🚨 La prova che conta: NON si scrive due volte. Finche' la regola
      // stava anche qui, questo punto chiamava `confirmFicStep2` una seconda
      // volta su un documento gia' creato.
      expect(step2).not.toHaveBeenCalled()
      expect(esito.message).not.toContain('un\'ultima volta')
    })
  }
})

describe('CONTROLLO POSITIVO — quando il primo passaggio ne chiede un altro, si chiede', () => {
  it('🚨 il testo dice cosa sta per succedere e su quale societa', async () => {
    // Senza questo, un percorso che riportasse sempre e solo il messaggio di
    // step1 passerebbe i test qui sopra e farebbe sparire il secondo cancello
    // anche dove serve — per esempio su un tipo di documento nuovo, che non e'
    // nell'elenco e deve ereditare il comportamento severo.
    righe.valore = pending('tipo_che_non_esiste_ancora')

    const esito = await confermaFicPiuRecente('restruktura')

    expect(esito.intercettato).toBe(true)
    expect(esito.message).toContain('Conferma DEFINITIVA')
    expect(esito.message).toContain('un\'ultima volta')
    expect(step2).not.toHaveBeenCalled()
  })

  it('la denominazione viene dalla RIGA: una conferma che nomina l azienda sbagliata e peggio di una che non la nomina', async () => {
    righe.valore = pending('tipo_che_non_esiste_ancora', { societa: 'larealestate' })

    const esito = await confermaFicPiuRecente('larealestate')

    expect(esito.message).toContain('LA REAL ESTATE')
  })
})

describe('🚨 il registro dei tipi a conferma singola', () => {
  it('contiene tutti i tipi di documento, come chiesto dall Ingegnere due volte', async () => {
    // La regola vive in fic-write-tools: qui si pinna il CONTENUTO, cosi' se
    // qualcuno toglie un tipo lo fa sapendo di cambiare una decisione presa.
    const vero = await vi.importActual<typeof import('./fic-write-tools')>('./fic-write-tools')

    for (const tipo of ['pagamento_emessa', 'pagamento_ricevuta', 'spesa_ricevuta', 'fattura_emessa', 'rapporto_intervento', 'autofattura', 'modifica_documento']) {
      expect(vero.A_CONFERMA_SINGOLA.has(tipo)).toBe(true)
    }
    // CONTROLLO POSITIVO: un tipo sconosciuto NON c'e', e resta prudente.
    expect(vero.A_CONFERMA_SINGOLA.has('tipo_che_non_esiste_ancora')).toBe(false)
  }, 30_000)
})
