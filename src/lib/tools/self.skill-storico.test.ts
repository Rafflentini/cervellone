/**
 * Una skill non si puo' piu' perdere riscrivendola.
 *
 * Il 1 agosto 2026 la skill `segreteria` e' passata da 3797 a 1364 caratteri
 * (‑64%) e con quella riscrittura sono sparite le istruzioni sulle foto. Il dato
 * lo dice ancora: al 3 settembre e' alla v3, e la v2 — l'unica copia, nell'unico
 * slot `istruzioni_precedenti` — era a UNA modifica dalla cancellazione
 * definitiva. La v1 non esiste piu' da nessuna parte.
 *
 * Due difese, provate qui:
 * 1. una riscrittura molto piu' corta viene RIFIUTATA e spiegata, invece di
 *    essere obbedita (chi aggiunge una regola non dimezza il testo);
 * 2. ogni versione finisce in uno storico dedicato PRIMA di essere sostituita,
 *    e se lo storico non si scrive la modifica non parte.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const ISTRUZIONI_LUNGHE = 'Regole della segreteria. '.repeat(160) // ~4000 caratteri

let skillCorrente: { istruzioni: string; versione: number } | null = null
let versioneInStorico: { istruzioni: string; archiviata_il: string; updated_by?: string } | null = null
let elencoStorico: Array<{ versione: number; istruzioni: string; archiviata_il: string; updated_by?: string }> = []
let erroreStorico: { message: string } | null = null
let erroreUpdate: { message: string } | null = null

const upsertStorico = vi.fn()
const updateSkill = vi.fn()

vi.mock('../supabase', () => ({
  supabase: {
    from: (tabella: string) => {
      if (tabella === 'cervellone_skills_versioni') {
        return {
          upsert: (riga: unknown, opts: unknown) => {
            upsertStorico(riga, opts)
            return Promise.resolve({ error: erroreStorico })
          },
          select: () => ({
            eq: () => ({
              eq: () => ({ maybeSingle: async () => ({ data: versioneInStorico, error: null }) }),
              order: async () => ({ data: elencoStorico, error: erroreStorico }),
              maybeSingle: async () => ({ data: versioneInStorico, error: null }),
            }),
          }),
        }
      }
      return {
        select: () => ({
          eq: () => ({
            single: async () => ({ data: skillCorrente, error: null }),
            maybeSingle: async () => ({ data: skillCorrente, error: null }),
          }),
          order: async () => ({ data: [], error: null }),
        }),
        update: (riga: unknown) => {
          updateSkill(riga)
          return { eq: async () => ({ error: erroreUpdate }) }
        },
        insert: async () => ({ error: null }),
        upsert: async () => ({ error: null }),
      }
    },
  },
}))
vi.mock('../telegram-helpers', () => ({ sendTelegramMessage: async () => undefined }))
vi.mock('../skills', () => ({ invalidateSkillCache: () => {} }))

import { executeSelfTools } from './self'

beforeEach(() => {
  vi.clearAllMocks()
  skillCorrente = { istruzioni: ISTRUZIONI_LUNGHE, versione: 3 }
  versioneInStorico = null
  elencoStorico = []
  erroreStorico = null
  erroreUpdate = null
})

describe('modifica_skill — la guardia anti-riassunto', () => {
  it('RIFIUTA una riscrittura piu corta del 40%, che e come sparirono le foto', async () => {
    const out = await executeSelfTools('modifica_skill', {
      skill_id: 'segreteria',
      nuove_istruzioni: 'Regole brevi della segreteria.',
      motivo: 'aggiungo una nota sulle mail',
    })

    expect(out).toContain('NON applicata')
    // Deve dire QUANTO si perde: "più corta" e "‑99%" non sono la stessa cosa.
    expect(out).toMatch(/\d+%/)
    // E deve dire cosa fare, non solo che ha rifiutato.
    expect(out).toContain('testo COMPLETO')
    expect(updateSkill).not.toHaveBeenCalled()
  })

  it('la lascia passare se e dichiarata esplicitamente', async () => {
    const out = await executeSelfTools('modifica_skill', {
      skill_id: 'segreteria',
      nuove_istruzioni: 'Regole brevi della segreteria.',
      motivo: 'la accorcio davvero',
      conferma_riduzione: true,
    })

    expect(out).toContain('aggiornata')
    expect(updateSkill).toHaveBeenCalled()
  })

  it('non intralcia una modifica normale che AGGIUNGE testo', async () => {
    // Controllo positivo: senza, la guardia potrebbe bloccare tutto e i test
    // sopra sarebbero verdi per il motivo sbagliato.
    const out = await executeSelfTools('modifica_skill', {
      skill_id: 'segreteria',
      nuove_istruzioni: ISTRUZIONI_LUNGHE + '\nNuova regola: le foto vanno archiviate per cantiere.',
      motivo: 'aggiungo la regola sulle foto',
    })

    expect(out).toContain('aggiornata')
    expect(out).toContain('+') // il delta di caratteri, positivo
    expect(updateSkill).toHaveBeenCalled()
  })

  it('non si applica alle skill corte, dove un dimezzamento e normale', async () => {
    skillCorrente = { istruzioni: 'Poche istruzioni.', versione: 1 }

    const out = await executeSelfTools('modifica_skill', {
      skill_id: 'clienti',
      nuove_istruzioni: 'Ancora meno.',
      motivo: 'semplifico',
    })

    expect(out).toContain('aggiornata')
  })
})

describe('modifica_skill — lo storico si scrive PRIMA di sovrascrivere', () => {
  it('archivia la versione attuale con il suo numero', async () => {
    await executeSelfTools('modifica_skill', {
      skill_id: 'segreteria',
      nuove_istruzioni: ISTRUZIONI_LUNGHE + ' aggiunta',
      motivo: 'aggiunta',
    })

    expect(upsertStorico).toHaveBeenCalled()
    const riga = upsertStorico.mock.calls[0][0] as Record<string, unknown>
    expect(riga.skill_id).toBe('segreteria')
    expect(riga.versione).toBe(3) // la versione SOSTITUITA, non la nuova
    expect(riga.istruzioni).toBe(ISTRUZIONI_LUNGHE)
  })

  it('se lo storico non si scrive, la modifica NON parte', async () => {
    // E' il cuore della correzione: meglio una modifica rifiutata che una
    // versione perduta. Prima si sovrascriveva e basta.
    erroreStorico = { message: 'permission denied' }

    const out = await executeSelfTools('modifica_skill', {
      skill_id: 'segreteria',
      nuove_istruzioni: ISTRUZIONI_LUNGHE + ' aggiunta',
      motivo: 'aggiunta',
    })

    expect(out).toContain('NON applicata')
    expect(out).toContain('copia di sicurezza')
    expect(updateSkill).not.toHaveBeenCalled()
  })
})

describe('ripristina_skill', () => {
  it('riporta il testo di una versione passata e archivia quella attuale', async () => {
    versioneInStorico = { istruzioni: 'Testo della v2, con le regole sulle foto.', archiviata_il: '2026-08-01T10:00:00Z' }

    const out = await executeSelfTools('ripristina_skill', { skill_id: 'segreteria', versione: 2, motivo: 'recupero le foto' })

    expect(out).toContain('v2')
    const scritto = updateSkill.mock.calls[0][0] as Record<string, unknown>
    expect(scritto.istruzioni).toBe('Testo della v2, con le regole sulle foto.')
    expect(scritto.versione).toBe(4) // 3 attuale + 1: il ripristino e' una nuova versione
    // La versione sostituita va nello storico, o il ripristino non sarebbe annullabile.
    expect(upsertStorico).toHaveBeenCalled()
    expect((upsertStorico.mock.calls[0][0] as Record<string, unknown>).versione).toBe(3)
  })

  it('non inventa una versione che non esiste', async () => {
    versioneInStorico = null

    const out = await executeSelfTools('ripristina_skill', { skill_id: 'segreteria', versione: 99, motivo: 'x' })

    expect(out).toContain('non trovata')
    expect(updateSkill).not.toHaveBeenCalled()
  })

  it('un ripristino piu corto NON viene bloccato dalla guardia', async () => {
    // Il testo arriva dallo storico, non dal modello, ed e' una richiesta
    // esplicita: qui la guardia sarebbe un impedimento, non una protezione.
    versioneInStorico = { istruzioni: 'Testo corto della v1.', archiviata_il: '2026-04-18T10:00:00Z' }

    const out = await executeSelfTools('ripristina_skill', { skill_id: 'segreteria', versione: 1, motivo: 'torno all originale' })

    expect(out).toContain('✅')
    expect(updateSkill).toHaveBeenCalled()
  })
})

describe('storico_skill', () => {
  it('elenca le versioni con dimensione e data', async () => {
    elencoStorico = [
      { versione: 3, istruzioni: 'x'.repeat(1364), archiviata_il: '2026-08-01T00:00:00Z', updated_by: 'cervellone: chiarimento' },
      { versione: 2, istruzioni: 'y'.repeat(3797), archiviata_il: '2026-07-01T00:00:00Z' },
    ]

    const out = await executeSelfTools('storico_skill', { skill_id: 'segreteria' })

    expect(out).toContain('v3')
    expect(out).toContain('1364')
    expect(out).toContain('v2')
    // La dimensione e' il segnale che rende visibile l'incidente: 3797 → 1364.
    expect(out).toContain('3797')
  })

  it('con una versione indicata restituisce il TESTO, per poterlo leggere', async () => {
    versioneInStorico = { istruzioni: 'Le istruzioni sulle foto del cantiere.', archiviata_il: '2026-07-01T00:00:00Z' }

    const out = await executeSelfTools('storico_skill', { skill_id: 'segreteria', versione: 2 })

    expect(out).toContain('Le istruzioni sulle foto del cantiere.')
  })

  it('uno storico vuoto lo dice, invece di sembrare un errore', async () => {
    elencoStorico = []

    const out = await executeSelfTools('storico_skill', { skill_id: 'clienti' })

    expect(out).toContain('Nessuna versione in storico')
  })
})
