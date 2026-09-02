/**
 * Il bot non deve dichiarare salvata una regola che non entrera' mai in un prompt.
 *
 * Incidente 1 settembre 2026: all'Ingegnere e' stato detto "salvato in
 * configurazione permanente — non solo in questa chat, in tutte le sessioni
 * future". Era falso, e nessuno poteva accorgersene.
 *
 * getPromptExtra() (src/lib/prompts.ts) scarta il valore se `updated_by` inizia
 * per "cervellone" — guardrail anti-avvelenamento, introdotto apposta perche' il
 * bot non deve poter riscrivere il proprio system prompt. Ma cervellone_modifica
 * firma SEMPRE `updated_by: "cervellone: ..."`. Quindi la scrittura riesce, viene
 * sempre scartata, e il tool risponde "✅ CONFIGURAZIONE AGGIORNATA ... attiva
 * dalla prossima richiesta".
 *
 * Il guardrail e' giusto e resta. A mentire e' il tool: deve dire che non puo'.
 */
import { describe, it, expect, vi } from 'vitest'

const updateCalls: Array<{ key: string; payload: Record<string, unknown> }> = []
const proposte: Array<Record<string, unknown>> = []

vi.mock('../supabase', () => ({
  supabase: {
    from: (table: string) => ({
      update: (payload: Record<string, unknown>) => ({
        eq: async (_col: string, key: string) => {
          updateCalls.push({ key, payload })
          return { error: null }
        },
      }),
      insert: (payload: Record<string, unknown>) => {
        proposte.push({ table, ...payload })
        return {
          select: () => ({
            single: async () => ({
              data: { id: '11111111-2222-3333-4444-555555555555', testo: payload.testo },
              error: null,
            }),
          }),
        }
      },
    }),
  },
}))
vi.mock('../telegram-helpers', () => ({ sendTelegramMessage: async () => {} }))
// Una scrittura riuscita su una chiave `model_*` fa `await import('../claude')`
// per invalidare le cache: senza mock il test tira dentro l'intero motore e va
// in timeout — e lo faceva solo nella suite completa, non da solo.
vi.mock('../claude', () => ({
  invalidateConfigCache: () => {},
  invalidateModelCapsCache: () => {},
}))
// `assertModelloEsiste` resta quella VERA: mockarla renderebbe vacuo il test
// sull'id inventato — proverebbe il finto, non la difesa.
vi.mock('../circuit-breaker', async (orig) => {
  const actual = await orig<typeof import('../circuit-breaker')>()
  return { ...actual, promoteModel: async () => '' }
})

import { executeSelfTools } from './self'

describe('cervellone_modifica su prompt_extra', () => {
  it('non dichiara salvata una regola: la propone e chiede conferma', async () => {
    updateCalls.length = 0
    proposte.length = 0

    const out = await executeSelfTools('cervellone_modifica', {
      chiave: 'prompt_extra',
      valore: 'Quando affermo un fatto verificato con un tool, non ribalto la posizione.',
      motivo: 'regola comportamentale permanente',
    })

    // Non deve affermare il successo: finche' l'Ingegnere non conferma, quel
    // testo non entra in nessun prompt.
    expect(out).not.toContain('CONFIGURAZIONE AGGIORNATA')
    expect(out).not.toContain('attiva dalla prossima richiesta')
    expect(out).toContain('NON ANCORA ATTIVA')
    // Deve consegnare al modello il comando esatto da riferire all'utente.
    expect(out).toContain('/regola_ok_11111111-2222-3333-4444-555555555555')

    // Non tocca prompt_extra in cervellone_config: un valore li' dentro
    // verrebbe riletto da cervellone_info come se fosse attivo.
    expect(updateCalls).toHaveLength(0)
    // La proposta finisce nella sua tabella, in stato 'proposta'.
    expect(proposte).toHaveLength(1)
    expect(proposte[0].table).toBe('cervellone_regole')
    expect(proposte[0].stato).toBe('proposta')
  })

  it('non scrive un id modello inventato in configurazione', async () => {
    // Il buco che la validazione di promuovi_modello NON copriva: questo tool
    // scriveva model_default senza nemmeno controllare il prefisso, nello stesso
    // file, 120 righe piu' su. E qui non c'e' neanche la semantica di backup —
    // model_stable non viene aggiornato, quindi un id sbagliato non lascia nulla
    // su cui ripiegare, e la chat web resta ferma finche' non si digita /sonnet.
    updateCalls.length = 0
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true, status: 200,
      json: async () => ({ data: [{ id: 'claude-opus-5' }, { id: 'claude-sonnet-5' }] }),
    })))

    const out = await executeSelfTools('cervellone_modifica', {
      chiave: 'model_default',
      valore: 'claude-mythos-5',
      motivo: 'modello nuovo',
    })

    expect(out).toContain('NON esiste')
    expect(updateCalls).toHaveLength(0)
    vi.unstubAllGlobals()
  })

  it('rifiuta un modello di un altro fornitore', async () => {
    // Il controllo sul prefisso "claude-" e' duplicato dentro promuovi_modello,
    // quindi da quella parte non si vede se sparisce. Qui invece e' l'unica
    // difesa: cervellone_modifica non ne ha una propria.
    updateCalls.length = 0
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true, status: 200,
      // `gpt-5` e' nell'elenco apposta: senza, il test passerebbe perche' manca
      // dalla lista, non perche' il prefisso venga controllato.
      json: async () => ({ data: [{ id: 'claude-opus-5' }, { id: 'gpt-5' }] }),
    })))

    const out = await executeSelfTools('cervellone_modifica', {
      chiave: 'model_default', valore: 'gpt-5', motivo: 'prova',
    })

    expect(out).toContain('claude-')
    expect(updateCalls).toHaveLength(0)
    vi.unstubAllGlobals()
  })

  it('un id modello vero passa', async () => {
    updateCalls.length = 0
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true, status: 200,
      json: async () => ({ data: [{ id: 'claude-opus-5' }, { id: 'claude-sonnet-5' }] }),
    })))

    const out = await executeSelfTools('cervellone_modifica', {
      chiave: 'model_default',
      valore: 'claude-opus-5',
      motivo: 'richiesta dell Ingegnere',
    })

    expect(out).toContain('CONFIGURAZIONE AGGIORNATA')
    expect(updateCalls.map(u => u.key)).toContain('model_default')
    vi.unstubAllGlobals()
  })

  it('le altre chiavi di configurazione restano scrivibili', async () => {
    updateCalls.length = 0

    const out = await executeSelfTools('cervellone_modifica', {
      chiave: 'max_tokens_default',
      valore: '8000',
      motivo: 'prova',
    })

    expect(out).toContain('CONFIGURAZIONE AGGIORNATA')
    expect(updateCalls).toHaveLength(1)
    expect(updateCalls[0].key).toBe('max_tokens_default')
  })
})
