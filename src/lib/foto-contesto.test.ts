/**
 * Il modulo del contesto foto, provato DAVVERO.
 *
 * I test di foto-archive-tools lo mockano, quindi asserivano sul contratto del
 * finto, non sul codice vero: mutazioni come "data illeggibile = adesso" o
 * "confermato_at scritto sempre" sopravvivevano indisturbate. E' [[la misura non
 * e' il dato]] applicata ai test stessi.
 *
 * Il cuore da difendere e' uno: `confermato_at` si aggiorna SOLO quando il
 * cantiere l'ha indicato l'Ingegnere. Se si aggiornasse anche sulle deduzioni,
 * ogni deduzione rinnoverebbe la propria finestra e un giro di tre cantieri
 * nella stessa giornata finirebbe tutto nel primo — senza che la richiesta di
 * conferma scatti mai.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

interface Riga { conversation_id: string; cantiere: string; ambito: string; confermato_at?: string; updated_at?: string }

let righe: Riga[] = []
let upserts: Array<{ payload: Riga; onConflict?: string }> = []
let letturaErrore: string | null = null

vi.mock('./supabase', () => ({
  supabase: {
    from: (table: string) => {
      if (table !== 'cervellone_foto_contesto') throw new Error('tabella inattesa: ' + table)
      const filtri: Array<[string, unknown]> = []
      const api = {
        select: () => api,
        eq: (c: string, v: unknown) => { filtri.push([c, v]); return api },
        maybeSingle: async () => {
          if (letturaErrore) return { data: null, error: { message: letturaErrore } }
          const r = righe.find(x => filtri.every(([c, v]) => (x as unknown as Record<string, unknown>)[c] === v))
          return { data: r ?? null, error: null }
        },
        upsert: async (payload: Riga, opts?: { onConflict?: string }) => {
          upserts.push({ payload, onConflict: opts?.onConflict })
          // Come il DB: senza onConflict una chiave duplicata e' un errore.
          const esistente = righe.find(x => x.conversation_id === payload.conversation_id)
          if (esistente && !opts?.onConflict) return { error: { message: 'duplicate key' } }
          if (esistente) Object.assign(esistente, payload)
          // default now() sulle colonne non passate, come da DDL
          else righe.push({ confermato_at: new Date().toISOString(), ...payload })
          return { error: null }
        },
        delete: () => ({
          eq: async (c: string, v: unknown) => {
            righe = righe.filter(x => (x as unknown as Record<string, unknown>)[c] !== v)
            return { error: null }
          },
        }),
      }
      return api
    },
  },
}))

import {
  getFotoContesto, setFotoContesto, clearFotoContesto,
  FOTO_CONTESTO_MAX_MS,
} from './foto-contesto'

beforeEach(() => { righe = []; upserts = []; letturaErrore = null })

describe('lettura del contesto foto', () => {
  it('senza riga non inventa niente', async () => {
    expect(await getFotoContesto('chat-1')).toBeNull()
  })

  it('calcola l eta dalla conferma, non da adesso', async () => {
    const oreFa = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString()
    righe.push({ conversation_id: 'chat-1', cantiere: 'Commessa A', ambito: 'cantiere', confermato_at: oreFa })

    const ctx = await getFotoContesto('chat-1')

    expect(ctx?.cantiere).toBe('Commessa A')
    expect(ctx!.etaMs).toBeGreaterThan(FOTO_CONTESTO_MAX_MS) // 3h > 2h
  })

  it('una data illeggibile vale VECCHISSIMA, non "adesso"', async () => {
    // Se valesse "adesso", un timestamp corrotto farebbe dedurre in silenzio.
    // In dubbio si chiede.
    righe.push({ conversation_id: 'chat-1', cantiere: 'Commessa A', ambito: 'cantiere', confermato_at: 'non-una-data' })

    const ctx = await getFotoContesto('chat-1')

    expect(ctx?.etaMs).toBe(Infinity)
  })

  it('una data nel futuro non diventa un contesto eternamente fresco', async () => {
    // Clock skew o dato manomesso: senza clamp l eta sarebbe negativa e
    // passerebbe ogni soglia per sempre.
    const fraUnGiorno = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
    righe.push({ conversation_id: 'chat-1', cantiere: 'Commessa A', ambito: 'cantiere', confermato_at: fraUnGiorno })

    const ctx = await getFotoContesto('chat-1')

    expect(ctx!.etaMs).toBeGreaterThanOrEqual(0)
  })

  it('un ambito fuori dai due validi viene scartato', async () => {
    righe.push({ conversation_id: 'chat-1', cantiere: 'Commessa A', ambito: 'chissa', confermato_at: new Date().toISOString() })

    expect(await getFotoContesto('chat-1')).toBeNull()
  })

  it('un errore di lettura non passa per "nessun contesto" silenzioso', async () => {
    letturaErrore = 'connection reset'
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})

    expect(await getFotoContesto('chat-1')).toBeNull()
    expect(spy).toHaveBeenCalled()
    spy.mockRestore()
  })

  it('legge solo la propria conversazione', async () => {
    righe.push({ conversation_id: 'chat-1', cantiere: 'A', ambito: 'cantiere', confermato_at: new Date().toISOString() })
    expect(await getFotoContesto('chat-2')).toBeNull()
  })
})

describe('scrittura del contesto foto', () => {
  it('con cantiere CONFERMATO fa ripartire la finestra', async () => {
    await setFotoContesto('chat-1', 'Commessa A', 'cantiere', true)

    expect(upserts[0].payload.confermato_at).toBeTruthy()
    expect(upserts[0].onConflict).toBe('conversation_id')
  })

  it('con cantiere DEDOTTO non tocca la conferma', async () => {
    // Il cuore del meccanismo: una deduzione non deve rinnovare la finestra che
    // le ha permesso di dedurre.
    await setFotoContesto('chat-1', 'Commessa A', 'cantiere', false)

    expect(upserts[0].payload).not.toHaveProperty('confermato_at')
    expect(upserts[0].payload.cantiere).toBe('Commessa A')
  })

  it('una deduzione non sposta in avanti una conferma gia esistente', async () => {
    const dueOreFa = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString()
    righe.push({ conversation_id: 'chat-1', cantiere: 'Commessa A', ambito: 'cantiere', confermato_at: dueOreFa })

    await setFotoContesto('chat-1', 'Commessa A', 'cantiere', false)

    expect(righe[0].confermato_at).toBe(dueOreFa)
  })

  it('non scrive righe vuote', async () => {
    expect(await setFotoContesto('chat-1', '', 'cantiere', true)).toBe(false)
    expect(await setFotoContesto('', 'Commessa A', 'cantiere', true)).toBe(false)
    expect(upserts).toHaveLength(0)
  })
})

describe('cancellazione', () => {
  it('/nuova toglie il contesto della sua conversazione e non tocca le altre', async () => {
    righe.push({ conversation_id: 'chat-1', cantiere: 'A', ambito: 'cantiere' })
    righe.push({ conversation_id: 'chat-2', cantiere: 'B', ambito: 'cantiere' })

    await clearFotoContesto('chat-1')

    expect(righe.map(r => r.conversation_id)).toEqual(['chat-2'])
  })
})
