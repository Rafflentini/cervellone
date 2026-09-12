/**
 * src/lib/guardia-autorizzazioni.test.ts — la via d'uscita dal blocco sui
 * dati societari (Task 12).
 *
 * `messaggioBlocco` prometteva «se e' voluto, dimmelo e lo genero comunque»
 * senza un modo per mantenerla: qui si prova che ORA c'e' davvero, e che le
 * cinque scelte che la rendono sicura (vedi il commento in cima al modulo)
 * reggono — soprattutto le tre che, se non tenessero, spegnerebbero la
 * guardia credendo di averle solo dato una via d'uscita: un'autorizzazione
 * NON deve valere per un contenuto diverso, NON deve valere scaduta, NON
 * deve valere una seconda volta.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

type Riga = {
  uuid: string
  conversation_id: string
  impronta: string
  pive_accettate: string[]
  scadenza: string
  concessa_at: string | null
  usata_at: string | null
  created_at: string
}

let righe: Riga[] = []

/**
 * Un builder minimo ma VERO: applica i filtri accumulati (eq/is) alle righe
 * quando viene chiamato un metodo terminale (limit, maybeSingle, select
 * dopo un update). Non e' un mock che dice sempre "ok" — se lo fosse, i
 * controlli positivi di questo file non morderebbero mai.
 */
function selezione(iniziali: Riga[]) {
  const filtri: Array<(r: Riga) => boolean> = []
  const builder = {
    eq: (colonna: keyof Riga, valore: unknown) => {
      filtri.push((r) => r[colonna] === valore)
      return builder
    },
    is: (colonna: keyof Riga, valore: null) => {
      filtri.push((r) => (r[colonna] ?? null) === valore)
      return builder
    },
    order: () => builder,
    limit: async (_n: number) => ({ data: iniziali.filter((r) => filtri.every((f) => f(r))), error: null }),
    maybeSingle: async () => ({ data: iniziali.filter((r) => filtri.every((f) => f(r)))[0] ?? null, error: null }),
  }
  return builder
}

vi.mock('./supabase-server', () => ({
  getSupabaseServer: () => ({
    from: (tabella: string) => {
      if (tabella !== 'cervellone_guardia_autorizzazioni') {
        throw new Error(`tabella inattesa in questo test: ${tabella}`)
      }
      return {
        insert: async (row: Record<string, unknown>) => {
          righe.push(row as Riga)
          return { error: null }
        },
        select: () => selezione(righe),
        update: (patch: Record<string, unknown>) => {
          const filtri: Array<(r: Riga) => boolean> = []
          const b = {
            eq: (colonna: keyof Riga, valore: unknown) => {
              filtri.push((r) => r[colonna] === valore)
              return b
            },
            is: (colonna: keyof Riga, valore: null) => {
              filtri.push((r) => (r[colonna] ?? null) === valore)
              return b
            },
            select: async (_colonne?: string) => {
              const colpite = righe.filter((r) => filtri.every((f) => f(r)))
              colpite.forEach((r) => Object.assign(r, patch))
              return { data: colpite.map((r) => ({ uuid: r.uuid })), error: null }
            },
          }
          return b
        },
      }
    },
  }),
}))

beforeEach(() => { righe = [] })

import { chiediAutorizzazione, concediAutorizzazione, autorizzazioneValida, AUTORIZZAZIONE_TTL_MS } from './guardia-autorizzazioni'
import { comandoDaMostrare, ORIGINE_CODICE } from './comandi-uuid'
import type { EsitoGuardia } from './guardia-societa'

const ESITO: Extract<EsitoGuardia, { ok: false }> = {
  ok: false,
  trovate: [{ piva: '02087420762', denominazione: 'RESTRUKTURA S.r.l.' }],
  attesa: { denominazione: 'LA REAL ESTATE SRLS', piva: '02232730768' },
}

const CONTENUTO_A = '<h1>RESTRUKTURA S.r.l.</h1><p>P.IVA 02087420762</p>'
const CONTENUTO_B = '<h1>ALTRO CONTENUTO</h1><p>P.IVA 02087420762</p>'

describe('la via d\'uscita — i sette casi del brief', () => {
  it('CONTROLLO POSITIVO — senza autorizzazione il documento resta bloccato', async () => {
    const valida = await autorizzazioneValida('conv-1', CONTENUTO_A)
    expect(valida).toBe(false)
  })

  it('con autorizzazione valida per QUESTO contenuto, il documento si salva', async () => {
    const { uuid } = await chiediAutorizzazione('conv-1', CONTENUTO_A, ESITO)
    const concessa = await concediAutorizzazione(uuid)
    expect(concessa).toEqual({ ok: true })

    const valida = await autorizzazioneValida('conv-1', CONTENUTO_A)
    expect(valida).toBe(true)
  })

  it('CONTROLLO POSITIVO — l\'autorizzazione NON vale per un contenuto diverso', async () => {
    // Autorizza il contenuto A, poi prova a validare il contenuto B: deve
    // restare bloccato. E' la prova che non abbiamo spento la guardia per
    // tutta la conversazione.
    const { uuid } = await chiediAutorizzazione('conv-1', CONTENUTO_A, ESITO)
    await concediAutorizzazione(uuid)

    const valida = await autorizzazioneValida('conv-1', CONTENUTO_B)
    expect(valida).toBe(false)

    // E quella giusta resta valida: il controllo sopra non e' solo un
    // motore che rifiuta sempre.
    expect(await autorizzazioneValida('conv-1', CONTENUTO_A)).toBe(true)
  })

  it('CONTROLLO POSITIVO — scaduta non vale', async () => {
    const { uuid } = await chiediAutorizzazione('conv-1', CONTENUTO_A, ESITO)
    await concediAutorizzazione(uuid)
    // Retroattiva la scadenza: e' successa piu' di 30 minuti fa.
    righe[0].scadenza = new Date(Date.now() - AUTORIZZAZIONE_TTL_MS - 1000).toISOString()

    const valida = await autorizzazioneValida('conv-1', CONTENUTO_A)
    expect(valida).toBe(false)
  })

  it('CONTROLLO POSITIVO — usata una volta, non vale la seconda', async () => {
    const { uuid } = await chiediAutorizzazione('conv-1', CONTENUTO_A, ESITO)
    await concediAutorizzazione(uuid)

    const prima = await autorizzazioneValida('conv-1', CONTENUTO_A)
    expect(prima).toBe(true)

    const seconda = await autorizzazioneValida('conv-1', CONTENUTO_A)
    expect(seconda).toBe(false)
  })

  it('il messaggio col codice NOMINA le partite IVA che si stanno autorizzando', async () => {
    // Non e' la formattazione del messaggio (quella e' in guardia-societa.ts
    // e i suoi test) — e' che chiediAutorizzazione REGISTRA le P.IVA lette
    // dall'esito, cosi' un messaggio costruito da quel dato le puo' nominare:
    // si autorizza una cosa che si e' letta, non un codice al buio.
    await chiediAutorizzazione('conv-1', CONTENUTO_A, ESITO)
    expect(righe[0].pive_accettate).toEqual(['02087420762'])
  })

  it('il codice e\' tappabile: 16 cifre esadecimali, nessun trattino, sotto i 32 caratteri', async () => {
    const { uuid } = await chiediAutorizzazione('conv-1', CONTENUTO_A, ESITO)
    const comando = comandoDaMostrare('doc_ok', uuid)

    expect(comando.length).toBeLessThanOrEqual(32)
    expect(comando).not.toMatch(/-/)
    expect(comando.slice('/doc_ok_'.length)).toMatch(/^[0-9a-f]{16}$/)
  })
})

describe('doc_ok / doc_no risolvono nella tabella giusta — non "id" come nelle mail in sospeso', () => {
  it('ORIGINE_CODICE punta a cervellone_guardia_autorizzazioni, colonna uuid', () => {
    expect(ORIGINE_CODICE.doc_ok).toEqual({ tabella: 'cervellone_guardia_autorizzazioni', colonna: 'uuid' })
    expect(ORIGINE_CODICE.doc_no).toEqual({ tabella: 'cervellone_guardia_autorizzazioni', colonna: 'uuid' })
  })
})

describe('concediAutorizzazione — tre modi di fallire, dichiarati', () => {
  it('codice inesistente: lo dice, non finge successo', async () => {
    const r = await concediAutorizzazione('00000000-0000-0000-0000-000000000000')
    expect(r).toEqual({ ok: false, motivo: expect.stringContaining('non trovato') })
  })

  it('codice scaduto: lo dice', async () => {
    const { uuid } = await chiediAutorizzazione('conv-1', CONTENUTO_A, ESITO)
    righe[0].scadenza = new Date(Date.now() - 1000).toISOString()

    const r = await concediAutorizzazione(uuid)
    expect(r.ok).toBe(false)
    if (r.ok) throw new Error('atteso rifiuto')
    expect(r.motivo).toMatch(/scadut/)
  })

  it('codice gia\' concesso: il secondo tap non finge un secondo successo', async () => {
    const { uuid } = await chiediAutorizzazione('conv-1', CONTENUTO_A, ESITO)
    const prima = await concediAutorizzazione(uuid)
    expect(prima).toEqual({ ok: true })

    const seconda = await concediAutorizzazione(uuid)
    expect(seconda.ok).toBe(false)
  })
})

describe('CONTROLLO NEGATIVO — una diversa conversazione non eredita l\'autorizzazione', () => {
  it('stesso contenuto, conversazione diversa: resta bloccato', async () => {
    const { uuid } = await chiediAutorizzazione('conv-1', CONTENUTO_A, ESITO)
    await concediAutorizzazione(uuid)

    expect(await autorizzazioneValida('conv-ALTRA', CONTENUTO_A)).toBe(false)
  })
})
