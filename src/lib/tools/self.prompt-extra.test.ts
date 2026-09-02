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
vi.mock('../circuit-breaker', () => ({ promoteModel: async () => '' }))

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
