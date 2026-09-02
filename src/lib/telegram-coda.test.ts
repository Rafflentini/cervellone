/**
 * Un messaggio mandato mentre il bot lavora non deve sparire.
 *
 * Ieri sera "⏳ Sto ancora elaborando il messaggio precedente" e' comparso piu'
 * volte: ogni volta un messaggio dell'Ingegnere e' svanito. Non c'era coda, non
 * c'era retry, e il testo non finiva nemmeno in `messages` — la scrittura sta a
 * valle del mutex. Peggio: il dedup su (chat_id, message_id) veniva scritto
 * PRIMA del controllo del lock, quindi anche una riconsegna di Telegram sarebbe
 * stata ignorata come "gia' processato".
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

interface Riga { id: number; chat_id: number; testo: string; created_at: string; consumato_at: string | null }

let righe: Riga[] = []
let seq = 0
let insertErrore: string | null = null
let updateErrore: string | null = null

vi.mock('./supabase', () => ({
  supabase: {
    from: (t: string) => {
      if (t !== 'telegram_coda') throw new Error('tabella inattesa: ' + t)
      const filtri: Array<[string, unknown]> = []
      let soloAperti = false
      let limite = 1000
      let ordine: { col: string; asc: boolean } | null = null
      const api = {
        insert: async (p: { chat_id: number; testo: string; created_at?: string }) => {
          if (insertErrore) return { error: { message: insertErrore } }
          righe.push({ id: ++seq, chat_id: p.chat_id, testo: p.testo, created_at: p.created_at ?? new Date().toISOString(), consumato_at: null })
          return { error: null }
        },
        select: () => api,
        eq: (c: string, v: unknown) => { filtri.push([c, v]); return api },
        is: (_c: string, _v: null) => { soloAperti = true; return api },
        // Ordina DAVVERO: con `order: () => api` il test sull'ordine di arrivo
        // verificava l'ordine di inserimento nell'array, non quello prodotto
        // dalla query — restava verde anche invertendo `ascending`.
        order: (c: string, o?: { ascending?: boolean }) => { ordine = { col: c, asc: o?.ascending !== false }; return api },
        limit: (n: number) => { limite = n; return api },
        update: (p: { consumato_at: string }) => {
          const upFiltri: Array<[string, unknown]> = []
          let upSoloAperti = false
          const chain = {
            in: async (_c: string, ids: number[]) => {
              if (updateErrore) return { error: { message: updateErrore } }
              for (const r of righe) if (ids.includes(r.id)) r.consumato_at = p.consumato_at
              return { error: null }
            },
            eq: (c: string, v: unknown) => { upFiltri.push([c, v]); return chain },
            is: (_c: string, _v: null) => {
              upSoloAperti = true
              if (updateErrore) return Promise.resolve({ error: { message: updateErrore } })
              for (const r of righe) {
                const match = upFiltri.every(([c, v]) => (r as unknown as Record<string, unknown>)[c] === v)
                if (match && (!upSoloAperti || r.consumato_at === null)) r.consumato_at = p.consumato_at
              }
              return Promise.resolve({ error: null })
            },
          }
          return chain
        },
        then: (res: (v: { data: Riga[]; error: null }) => unknown) => {
          let out = righe.filter(r => filtri.every(([c, v]) => (r as unknown as Record<string, unknown>)[c] === v))
          if (soloAperti) out = out.filter(r => r.consumato_at === null)
          if (ordine) {
            const k = ordine.col as keyof Riga
            out = [...out].sort((a, b) => String(a[k]).localeCompare(String(b[k])))
            if (!ordine.asc) out.reverse()
          }
          return Promise.resolve(res({ data: out.slice(0, limite), error: null }))
        },
      }
      return api
    },
  },
}))

import {
  accodaMessaggio, drenaCoda, formatCoda, svuotaCoda, riaccodaMessaggi,
  CODA_MAX_MS, TESTO_MAX_CHARS,
} from './telegram-coda'

beforeEach(() => { righe = []; seq = 0; insertErrore = null; updateErrore = null })

describe('accodare', () => {
  it('salva il testo respinto invece di buttarlo', async () => {
    expect(await accodaMessaggio(111, 'mandami il preventivo Rossi')).toBe(true)
    expect(righe).toHaveLength(1)
    expect(righe[0].testo).toBe('mandami il preventivo Rossi')
  })

  it('un messaggio vuoto non crea una riga', async () => {
    expect(await accodaMessaggio(111, '   ')).toBe(false)
    expect(righe).toHaveLength(0)
  })

  it('se nemmeno la coda funziona, lo dice invece di fingere', async () => {
    // Qui il messaggio e' perso davvero: il chiamante deve poterlo sapere per
    // non promettere all'Ingegnere che lo ha messo da parte.
    insertErrore = 'connection reset'
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})

    expect(await accodaMessaggio(111, 'testo importante')).toBe(false)
    expect(spy).toHaveBeenCalled()
    spy.mockRestore()
  })
})

describe('recuperare', () => {
  it('restituisce gli arretrati in ordine di arrivo', async () => {
    await accodaMessaggio(111, 'primo')
    await accodaMessaggio(111, 'secondo')

    const out = await drenaCoda(111)

    expect(out.map(m => m.testo)).toEqual(['primo', 'secondo'])
  })

  it('non li riconsegna una seconda volta', async () => {
    await accodaMessaggio(111, 'primo')

    expect(await drenaCoda(111)).toHaveLength(1)
    expect(await drenaCoda(111)).toHaveLength(0)
  })

  it('non pesca la coda di un altra chat', async () => {
    await accodaMessaggio(111, 'mio')
    await accodaMessaggio(222, 'di un altro')

    expect((await drenaCoda(111)).map(m => m.testo)).toEqual(['mio'])
  })

  it('non riesuma un messaggio troppo vecchio, ma lo toglie di mezzo', async () => {
    // Riproporre un "mandami il preventivo" di ieri dentro un discorso di oggi
    // confonde piu' di quanto aiuti. La riga pero' resta, marcata.
    await accodaMessaggio(111, 'vecchio')
    righe[0].created_at = new Date(Date.now() - CODA_MAX_MS - 60_000).toISOString()

    expect(await drenaCoda(111)).toHaveLength(0)
    expect(righe[0].consumato_at).not.toBeNull()
  })

  it('se non riesce a marcarli NON li consegna', async () => {
    // Consegnarli senza poterli marcare significherebbe riproporli a ogni
    // messaggio, per sempre.
    await accodaMessaggio(111, 'primo')
    updateErrore = 'connection reset'
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})

    expect(await drenaCoda(111)).toHaveLength(0)
    spy.mockRestore()
  })
})

describe('la finestra dei 10 minuti', () => {
  it('vale esattamente 10 minuti, come il riaggancio degli upload', () => {
    // Il test di scadenza costruisce il timestamp A PARTIRE da CODA_MAX_MS:
    // qualunque valore lo soddisferebbe, ed e' proprio il valore il punto.
    // Dieci minuti e' la stessa finestra entro cui il messaggio successivo
    // riaggancia gli upload recenti (telegram/route.ts): se divergono, una
    // didascalia arriva al modello senza la foto a cui si riferisce.
    expect(CODA_MAX_MS).toBe(10 * 60 * 1000)
  })
})

describe('restituire alla coda', () => {
  it('conserva l eta originale, non fa ripartire l orologio', async () => {
    // Un turno puo' rimbalzare sul ramo durable per mezz'ora. Se ogni
    // riaccodamento azzerasse l'orologio, un messaggio vecchio 40 minuti
    // risulterebbe fresco e arriverebbe quando la foto non e' piu' riagganciabile.
    const vecchio = new Date(Date.now() - 8 * 60 * 1000).toISOString()

    await riaccodaMessaggi(111, [{ testo: 'arretrato', created_at: vecchio }])

    expect(righe[0].created_at).toBe(vecchio)
  })

  it('dice quanti non e riuscita a restituire', async () => {
    insertErrore = 'connection reset'
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const persi = await riaccodaMessaggi(111, [
      { testo: 'a', created_at: new Date().toISOString() },
      { testo: 'b', created_at: new Date().toISOString() },
    ])

    expect(persi).toBe(2)
    spy.mockRestore()
  })
})

describe('messaggi lunghi', () => {
  it('il troncamento non e silenzioso', async () => {
    // Restituire meta' messaggio dopo aver promesso di averlo tenuto e' peggio
    // che dire subito che non ci stava.
    await accodaMessaggio(111, 'x'.repeat(TESTO_MAX_CHARS + 500))

    expect(righe[0].testo).toContain('troncato')
    expect(righe[0].testo.length).toBeLessThan(TESTO_MAX_CHARS + 100)
  })
})

describe('svuotare (/nuova e /reset)', () => {
  it('butta gli arretrati della chat, cosi la conversazione nuova nasce pulita', async () => {
    // "Puoi rimandare il messaggio" e poi riproporglielo insieme all'"anzi
    // lascia stare" arrivato dopo sarebbe peggio del blocco.
    await accodaMessaggio(111, 'primo')
    await accodaMessaggio(111, 'anzi lascia stare')

    await svuotaCoda(111)

    expect(await drenaCoda(111)).toHaveLength(0)
  })

  it('non tocca la coda di un altra chat', async () => {
    await accodaMessaggio(111, 'mio')
    await accodaMessaggio(222, 'di un altro')

    await svuotaCoda(111)

    expect((await drenaCoda(222)).map(m => m.testo)).toEqual(['di un altro'])
  })
})

describe('come arrivano al modello', () => {
  it('sono marcati come NON letti, non come un ripensamento', async () => {
    const testo = formatCoda([{ id: 1, testo: 'e porta anche il DURC', created_at: new Date().toISOString() }])

    expect(testo).toContain('e porta anche il DURC')
    expect(testo).toContain('NON avevo ancora letto')
  })

  it('senza arretrati non aggiunge niente', () => {
    expect(formatCoda([])).toBe('')
  })
})
