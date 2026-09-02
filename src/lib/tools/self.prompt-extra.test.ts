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

vi.mock('../supabase', () => ({
  supabase: {
    from: () => ({
      update: (payload: Record<string, unknown>) => ({
        eq: async (_col: string, key: string) => {
          updateCalls.push({ key, payload })
          return { error: null }
        },
      }),
    }),
  },
}))
vi.mock('../telegram-helpers', () => ({ sendTelegramMessage: async () => {} }))
vi.mock('../circuit-breaker', () => ({ promoteModel: async () => '' }))

import { executeSelfTools } from './self'

describe('cervellone_modifica su prompt_extra', () => {
  it('non dichiara salvata una regola che il guardrail scartera sempre', async () => {
    updateCalls.length = 0

    const out = await executeSelfTools('cervellone_modifica', {
      chiave: 'prompt_extra',
      valore: 'Quando affermo un fatto verificato con un tool, non ribalto la posizione.',
      motivo: 'regola comportamentale permanente',
    })

    // Non deve affermare il successo: quel testo non entrera' in nessun prompt.
    expect(out).not.toContain('CONFIGURAZIONE AGGIORNATA')
    expect(out).not.toContain('attiva dalla prossima richiesta')
    // Deve dire perche', cosi' il modello puo' riferirlo onestamente all'utente.
    expect(String(out).toLowerCase()).toContain('non pos')

    // E soprattutto: non deve scrivere nulla in DB, per non lasciare in giro un
    // valore che `cervellone_info` poi rileggerebbe come se fosse attivo.
    expect(updateCalls).toHaveLength(0)
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
