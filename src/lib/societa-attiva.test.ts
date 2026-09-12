import { describe, it, expect, vi, beforeEach } from 'vitest'

// Stato del finto database, per conversazione
let righe: Record<string, string> = {}
let erroreLettura: { message: string } | null = null
let lanciaEccezione = false

vi.mock('./supabase-server', () => ({
  getSupabaseServer: () => ({
    from: () => ({
      select: () => ({
        eq: (_col: string, convId: string) => ({
          maybeSingle: async () => {
            if (lanciaEccezione) throw new Error('connessione interrotta')
            return {
              data: righe[convId] ? { societa: righe[convId] } : null,
              error: erroreLettura,
            }
          },
        }),
      }),
      upsert: async (row: { conversation_id: string; societa: string }) => {
        righe[row.conversation_id] = row.societa
        return { error: null }
      },
    }),
  }),
}))

import { getSocietaAttiva, setSocietaAttiva, bloccoSocietaAttiva, leggiSocietaAttiva } from './societa-attiva'
import { getSocieta } from './societa'

describe('societa attiva', () => {
  beforeEach(() => {
    righe = {}
    erroreLettura = null
    lanciaEccezione = false
  })

  // Chi non ha mai usato /societa deve trovare il comportamento di sempre.
  it('senza impostazione la societa e Restruktura', async () => {
    expect(await getSocietaAttiva('conv-nuova')).toBe('restruktura')
  })

  it('ricorda la societa scelta', async () => {
    await setSocietaAttiva('conv-1', 'larealestate')
    expect(await getSocietaAttiva('conv-1')).toBe('larealestate')
  })

  it('due conversazioni non si influenzano', async () => {
    await setSocietaAttiva('conv-1', 'larealestate')
    expect(await getSocietaAttiva('conv-2')).toBe('restruktura')
  })

  // Un errore di database non deve cambiare azienda sotto i piedi.
  it('se la lettura fallisce resta Restruktura, non l ultima scelta', async () => {
    await setSocietaAttiva('conv-1', 'larealestate')
    erroreLettura = { message: 'connessione persa' }
    expect(await getSocietaAttiva('conv-1')).toBe('restruktura')
  })

  it('un codice societa sconosciuto nel database non diventa un azienda fantasma', async () => {
    righe['conv-1'] = 'societa-che-non-esiste'
    expect(await getSocietaAttiva('conv-1')).toBe('restruktura')
  })

  it('senza conversazione ritorna il default invece di lanciare', async () => {
    expect(await getSocietaAttiva('')).toBe('restruktura')
  })
})

describe('leggiSocietaAttiva — un errore NON e\' una societa\'', () => {
  beforeEach(() => {
    righe = {}
    erroreLettura = null
    lanciaEccezione = false
  })

  it('nessuna riga: Restruktura, ma dichiarata NON esplicita', async () => {
    const e = await leggiSocietaAttiva('conv-1')
    expect(e).toEqual({ ok: true, codice: 'restruktura', esplicita: false })
  })

  it('riga presente: la societa\' scelta, esplicita', async () => {
    righe['conv-1'] = 'larealestate'
    const e = await leggiSocietaAttiva('conv-1')
    expect(e).toEqual({ ok: true, codice: 'larealestate', esplicita: true })
  })

  it('CONTROLLO POSITIVO — errore dal database: ok:false, NON Restruktura', async () => {
    erroreLettura = { message: 'connessione persa' }
    const e = await leggiSocietaAttiva('conv-1')
    expect(e.ok).toBe(false)
    if (e.ok) throw new Error('un guasto si e\' travestito da societa\': e\' il difetto, non il fix')
    expect(e.errore).toContain('connessione persa')
  })

  it('CONTROLLO POSITIVO — eccezione: ok:false', async () => {
    lanciaEccezione = true
    const e = await leggiSocietaAttiva('conv-1')
    expect(e.ok).toBe(false)
  })

  it('senza conversationId: Restruktura non esplicita (non c\'e\' niente da leggere)', async () => {
    expect(await leggiSocietaAttiva(undefined)).toEqual({ ok: true, codice: 'restruktura', esplicita: false })
  })

  it('codice sconosciuto in riga: Restruktura non esplicita, non un\'azienda fantasma', async () => {
    righe['conv-1'] = 'acme'
    const e = await leggiSocietaAttiva('conv-1')
    expect(e).toEqual({ ok: true, codice: 'restruktura', esplicita: false })
  })
})

describe('getSocietaAttiva — comportamento invariato', () => {
  beforeEach(() => {
    righe = {}
    erroreLettura = null
    lanciaEccezione = false
  })

  it('su errore restituisce ancora restruktura (i chiamanti di contesto non cambiano)', async () => {
    erroreLettura = { message: 'connessione persa' }
    expect(await getSocietaAttiva('conv-1')).toBe('restruktura')
  })
})

describe('blocco iniettato nel contesto', () => {
  it('nomina societa, partita IVA e aliquota', () => {
    const testo = bloccoSocietaAttiva(getSocieta('larealestate'))
    expect(testo).toContain('LA REAL ESTATE SRLS')
    expect(testo).toContain('02232730768')
    expect(testo).toContain('10%')
  })

  // Il punto del blocco non e informare: e VIETARE la deduzione.
  it('vieta esplicitamente di dedurre la societa da solo', () => {
    const testo = bloccoSocietaAttiva(getSocieta('restruktura'))
    expect(testo).toMatch(/NON dedurlo/i)
    // Prima diceva "usa /societa": un comando che esiste SOLO su Telegram.
    // Chi legge dalla chat web veniva mandato contro un muro. Il tool c e su
    // tutti e due i canali.
    expect(testo).toContain('imposta_societa_attiva')
    expect(testo).not.toContain('/societa')
  })

  it('distingue le due societa', () => {
    const a = bloccoSocietaAttiva(getSocieta('restruktura'))
    const b = bloccoSocietaAttiva(getSocieta('larealestate'))
    expect(a).not.toBe(b)
    expect(a).not.toContain('02232730768')
  })
})
