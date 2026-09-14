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

  it('spesa_ricevuta: registrare una fattura d ACQUISTO si disfa, quindi una conferma sola', async () => {
    // ⚠️ Il criterio resta «reversibile o no». Una spesa non si trasmette a
    // nessuno: e' la registrazione di un documento che abbiamo RICEVUTO, e su
    // Fatture in Cloud si cancella in dieci secondi. Quello che non si disfa
    // e' EMETTERE — ma dal 15 set anche quelli stanno a UNA conferma, per
      // decisione esplicita dell Ingegnere (v. il blocco qui sotto).
    righe.valore = pending('spesa_ricevuta', { descrizione: 'Registro una SPESA (fattura RICEVUTA) su Fatture in Cloud' })

    const esito = await confermaFicPiuRecente('restruktura')

    expect(step1).toHaveBeenCalledTimes(1)
    expect(step2).toHaveBeenCalledTimes(1)
    expect(esito.message).toContain('Scritto su Fatture in Cloud')
    expect(esito.message).not.toContain('un\'ultima volta')
  })
})

describe('🚨 UNA conferma sola, anche per i documenti che si EMETTONO', () => {
  // ⚠️ Fino al 14 settembre 2026 il criterio era «reversibile o no»: emettere
  // non si disfa, quindi fattura e autofattura restavano a due passaggi.
  //
  // Il 15 settembre l'Ingegnere l'ha chiesto una seconda volta, esplicitamente
  // per le fatture: «ti avevo detto di lasciare singola conferma vocale, non
  // doppia». E' una sua decisione, ripetuta, ed e' sua da prendere.
  //
  // Cosa regge al posto del secondo cancello: l'anteprima — fornitore, numero,
  // date, importi — gli viene mostrata QUANDO il tool prepara la riga. Il
  // «confermo» arriva dopo averla letta, non al buio.

  it('fattura_emessa: il «confermo» scrive, e non ne chiede un altro', async () => {
    righe.valore = pending('fattura_emessa', { descrizione: 'Creo la fattura 30-ED' })

    const esito = await confermaFicPiuRecente('restruktura')

    expect(step1).toHaveBeenCalledTimes(1)
    expect(step2).toHaveBeenCalledTimes(1)
    expect(esito.message).not.toContain('Conferma DEFINITIVA')
  })

  it('rapporto_intervento: idem', async () => {
    righe.valore = pending('rapporto_intervento')

    await confermaFicPiuRecente('restruktura')

    expect(step2).toHaveBeenCalledTimes(1)
  })

  it('autofattura: N documenti, UN «confermo»', async () => {
    // La conferma MASSIVA e la conferma SINGOLA sono due cose diverse, e qui
    // valgono insieme: una riga sola per N autofatture, e un passaggio solo.
    righe.valore = pending('autofattura', { descrizione: 'Compilo 3 AUTOFATTURE (reverse charge, fatture estere)' })

    const esito = await confermaFicPiuRecente('restruktura')

    expect(step1).toHaveBeenCalledTimes(1)
    expect(step2).toHaveBeenCalledTimes(1)
    expect(esito.message).not.toContain('Conferma DEFINITIVA')
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
