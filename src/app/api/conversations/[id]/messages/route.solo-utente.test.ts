/**
 * Una scheda vecchia rimasta aperta continuava a scrivere le risposte.
 *
 * MISURATO IN PRODUZIONE il 9 set 2026, sulla conversazione in cui l'Ingegnere
 * lavorava al SAL della commessa C2026-008: fra le 18:42 e le 18:59, SETTE
 * righe `assistant` scritte dal server e SETTE scritte dal browser — una a una,
 * lo stesso testo due volte. E il commit che aveva tolto quel codice dal
 * browser era in produzione da TRE ORE (`7af006b`, deploy delle 15:50).
 *
 * Il browser non aveva ricaricato la pagina: girava ancora il bundle vecchio.
 * Nessuna modifica al codice del client puo' raggiungere una scheda gia'
 * aperta — ma questa e' una rotta SERVER, e il server e' aggiornato.
 *
 * ⭐ Il commento qui sopra diceva gia' «qui passa il messaggio dell'UTENTE».
 * Era un'invariante dichiarata e non fatta rispettare: esattamente la forma di
 * difetto che l'8 set ha lasciato il bot a mergiare PR coi controlli assenti.
 * Un difetto documentato resta un difetto.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const inserite: Array<Record<string, unknown>> = []
vi.mock('@/lib/auth', () => ({ validateAuth: () => true }))
vi.mock('@/lib/memory', () => ({ saveEmbeddingOnly: async () => true }))
vi.mock('@/lib/supabase', () => ({
  supabase: {
    from: (tabella: string) => ({
      insert: (riga: Record<string, unknown>) => {
        if (tabella === 'messages') inserite.push(riga)
        return { select: () => ({ single: async () => ({ data: { id: 'r1' }, error: null }) }) }
      },
      select: () => ({ eq: () => ({ single: async () => ({ data: { title: 'x' } }) }) }),
      update: () => ({ eq: async () => ({ error: null }) }),
    }),
  },
}))

import { POST } from './route'

function richiesta(role: string, content: string) {
  return {
    cookies: { get: () => ({ value: 'cookie-di-prova-abbastanza-lungo' }) },
    json: async () => ({ role, content }),
  } as unknown as Parameters<typeof POST>[0]
}

const params = Promise.resolve({ id: '2aac17c8-b937-4d94-89fe-84d092a3ff5c' })

beforeEach(() => { inserite.length = 0 })

describe('POST messaggi — il browser scrive solo la DOMANDA', () => {
  it('una risposta mandata dal browser viene RIFIUTATA, non scritta', async () => {
    const res = await POST(richiesta('assistant', 'Ecco il preventivo aggiornato.'), { params })

    expect(res.status).toBe(409)
    expect(inserite).toHaveLength(0)
  })

  it('anche un ruolo inventato viene rifiutato', async () => {
    const res = await POST(richiesta('knowledge', 'roba'), { params })

    expect(res.status).toBe(409)
    expect(inserite).toHaveLength(0)
  })

  // CONTROLLO POSITIVO: senza, una rotta che rifiuta TUTTO passerebbe
  // i due test qui sopra a mani basse.
  it('la domanda dell utente si salva normalmente', async () => {
    const res = await POST(richiesta('user', 'preparami il SAL 1'), { params })

    expect(res.status).not.toBe(409)
    expect(inserite).toHaveLength(1)
    expect(inserite[0]).toMatchObject({ role: 'user', content: 'preparami il SAL 1' })
  })
})
