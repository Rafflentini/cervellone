/**
 * Il confine: una regola entra nel system prompt SOLO dopo la conferma esplicita.
 *
 * E' il punto su cui il vecchio guardrail aveva ragione. Cervellone legge mail e
 * documenti scritti da altri: se bastasse che sia lui a scrivere una regola, un
 * testo esterno potrebbe fargli cambiare le proprie istruzioni in modo
 * permanente. Qui la difesa non e' piu' un confronto di stringhe su `updated_by`
 * ma lo stato della riga — e questi test lo pinnano.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

interface Row {
  id: string
  testo: string
  motivo: string | null
  stato: string
  proposta_da: string | null
  created_at: string
  decisa_at: string | null
  updated_at: string
}

let rows: Row[] = []
let seq = 0

/** Supabase finto: abbastanza fedele da far fallire i test se la logica sbaglia. */
function makeQuery(table: string) {
  if (table !== 'cervellone_regole') throw new Error('tabella inattesa: ' + table)
  const filters: Array<[string, unknown]> = []
  let orderAsc = true
  let limitN = 1000

  const api = {
    select() { return api },
    insert(payload: Partial<Row>) {
      const now = new Date().toISOString()
      const row: Row = {
        id: `id-${++seq}`,
        testo: String(payload.testo),
        motivo: (payload.motivo as string) ?? null,
        stato: payload.stato ?? 'proposta',
        proposta_da: (payload.proposta_da as string) ?? null,
        created_at: (payload.created_at as string) ?? now,
        decisa_at: null,
        updated_at: now,
      }
      rows.push(row)
      return {
        select: () => ({ single: async () => ({ data: row, error: null }) }),
      }
    },
    update(payload: Partial<Row>) {
      const upd = { ...api, __payload: payload }
      return upd
    },
    eq(col: string, val: unknown) { filters.push([col, val]); return api },
    order(_col: string, o: { ascending: boolean }) { orderAsc = o.ascending; return api },
    limit(n: number) { limitN = n; return api },
    match() { return api },
    async maybeSingle() {
      const found = rows.find(r => filters.every(([c, v]) => (r as unknown as Record<string, unknown>)[c] === v))
      const snapshot = found ? { ...found } : null
      // Gancio per simulare la CORSA: il chiamante ha gia' letto, e qualcun
      // altro cambia la riga prima che l'update parta. Senza questo, la guardia
      // `.eq('stato','proposta')` non e' raggiungibile da nessun test.
      if (afterSelect) { afterSelect(); afterSelect = null }
      return { data: snapshot, error: null }
    },
    async single() {
      const found = rows.find(r => filters.every(([c, v]) => (r as unknown as Record<string, unknown>)[c] === v))
      return { data: found ?? null, error: found ? null : { message: 'not found' } }
    },
    then(resolve: (v: { data: Row[]; error: null }) => unknown) {
      let out = rows.filter(r => filters.every(([c, v]) => (r as unknown as Record<string, unknown>)[c] === v))
      out = out.sort((a, b) => (a.decisa_at ?? '').localeCompare(b.decisa_at ?? ''))
      if (!orderAsc) out.reverse()
      return Promise.resolve(resolve({ data: out.slice(0, limitN), error: null }))
    },
  }
  return api
}

// update(...).eq(...).eq(...) deve applicare la modifica alle righe che matchano
function makeUpdatingQuery(table: string) {
  if (table !== 'cervellone_regole') throw new Error('tabella inattesa: ' + table)
  return {
    select: () => makeQuery(table),
    insert: (p: Partial<Row>) => makeQuery(table).insert(p),
    update(payload: Partial<Row>) {
      const filters: Array<[string, unknown]> = []
      const applica = () => {
        if (updateError) return { data: null, error: { message: updateError } }
        const hit: Row[] = []
        for (const r of rows) {
          if (filters.every(([c, v]) => (r as unknown as Record<string, unknown>)[c] === v)) {
            Object.assign(r, payload)
            hit.push(r)
          }
        }
        // Come supabase-js: .select() dopo update ritorna le righe TOCCATE.
        return { data: hit.map(r => ({ id: r.id })), error: null }
      }
      const chain = {
        eq(col: string, val: unknown) { filters.push([col, val]); return chain },
        select() {
          return { then: (res: (v: unknown) => unknown) => Promise.resolve(res(applica())) }
        },
        then(resolve: (v: unknown) => unknown) { return Promise.resolve(resolve(applica())) },
      }
      return chain
    },
  }
}

/** Quando valorizzato, ogni update fallisce: simula rete/RLS che cade. */
let updateError: string | null = null

/** Eseguito una volta sola, subito dopo la prossima lettura: simula la corsa. */
let afterSelect: (() => void) | null = null

vi.mock('./supabase', () => ({
  supabase: { from: (t: string) => makeUpdatingQuery(t) },
}))

import {
  proponiRegola, confermaRegola, rifiutaRegola, rimuoviRegola, anteprimaRegola,
  buildRegoleContext, formatRegoleList, splitRegolePerPrompt,
  PROPOSTA_TTL_MS, REGOLE_MAX_ATTIVE, REGOLE_MAX_CHARS,
} from './regole-proposte'

beforeEach(() => { rows = []; seq = 0; updateError = null; afterSelect = null })

/** Scorciatoia: propone e attiva, per costruire uno stato di partenza. */
async function attiva(testo: string) {
  const p = await proponiRegola(testo, 'setup')
  await confermaRegola(p!.id)
  return p!.id
}

describe('regole proposte dal bot', () => {
  it('una regola proposta NON entra nel prompt finche non e confermata', async () => {
    const p = await proponiRegola('Verifica sempre le fonti ufficiali.', 'incidente Fable')
    expect(p).not.toBeNull()

    // il confine: proposta != attiva
    expect(await buildRegoleContext()).toBe('')

    const esito = await confermaRegola(p!.id)
    expect(esito.ok).toBe(true)

    const ctx = await buildRegoleContext()
    expect(ctx).toContain('Verifica sempre le fonti ufficiali.')
  })

  it('una proposta rifiutata non entra mai nel prompt', async () => {
    const p = await proponiRegola('Regola sbagliata.', 'prova')
    await rifiutaRegola(p!.id)

    expect(await buildRegoleContext()).toBe('')
    // e non e piu confermabile dopo il no
    const tardi = await confermaRegola(p!.id)
    expect(tardi.ok).toBe(false)
  })

  it('una proposta non si puo confermare due volte', async () => {
    const p = await proponiRegola('Regola buona.', 'prova')
    expect((await confermaRegola(p!.id)).ok).toBe(true)
    expect((await confermaRegola(p!.id)).ok).toBe(false)
  })

  it('una proposta vecchia scade e non si attiva piu', async () => {
    const p = await proponiRegola('Regola dimenticata.', 'prova')
    // invecchia la riga oltre il TTL
    rows[0].created_at = new Date(Date.now() - PROPOSTA_TTL_MS - 60_000).toISOString()

    const esito = await confermaRegola(p!.id)
    expect(esito.ok).toBe(false)
    expect(esito.message).toContain('scaduta')
    expect(await buildRegoleContext()).toBe('')
  })

  it('rimuovere una regola la toglie dal prompt ma non cancella la riga', async () => {
    const p = await proponiRegola('Regola da togliere.', 'prova')
    await confermaRegola(p!.id)
    expect(await buildRegoleContext()).toContain('Regola da togliere.')

    const esito = await rimuoviRegola(p!.id)
    expect(esito.ok).toBe(true)
    expect(await buildRegoleContext()).toBe('')
    // la traccia resta: si sa che quella regola c'e' stata
    expect(rows).toHaveLength(1)
    expect(rows[0].stato).toBe('rimossa')
  })

  it('le regole restano nell ordine in cui sono state confermate', async () => {
    // L'ordine non e' estetica: quando il budget di caratteri e' saturo decide
    // QUALI regole vengono tagliate. Ascendente = le piu' vecchie hanno la
    // precedenza e l'insieme e' stabile fra un messaggio e l'altro; invertirlo
    // farebbe cambiare il prompt a ogni nuova conferma.
    await attiva('Prima in ordine.')
    await attiva('Seconda in ordine.')
    await attiva('Terza in ordine.')

    const ctx = await buildRegoleContext()
    expect(ctx.indexOf('Prima in ordine.')).toBeLessThan(ctx.indexOf('Seconda in ordine.'))
    expect(ctx.indexOf('Seconda in ordine.')).toBeLessThan(ctx.indexOf('Terza in ordine.'))
  })

  it('le regole si accumulano invece di sovrascriversi', async () => {
    const a = await proponiRegola('Prima regola.', 'x')
    await confermaRegola(a!.id)
    const b = await proponiRegola('Seconda regola.', 'y')
    await confermaRegola(b!.id)

    const ctx = await buildRegoleContext()
    expect(ctx).toContain('Prima regola.')
    expect(ctx).toContain('Seconda regola.')
  })

  it('un testo vuoto non diventa una proposta', async () => {
    expect(await proponiRegola('   ', 'x')).toBeNull()
    expect(rows).toHaveLength(0)
  })
})

/**
 * Il difetto piu' pericoloso di questo meccanismo non e' che non funzioni: e'
 * che dica "✅ attiva" per una regola che non entrera' mai nel prompt. Sarebbe
 * la stessa malattia che questo lavoro nasce per curare.
 */
describe('non deve mai dichiarare attiva una regola che non entra nel prompt', () => {
  it('oltre il tetto, la conferma viene RIFIUTATA invece di sparire in silenzio', async () => {
    for (let i = 0; i < REGOLE_MAX_ATTIVE; i++) await attiva(`Regola numero ${i}.`)

    const p = await proponiRegola('Regola di troppo.', 'x')
    const esito = await confermaRegola(p!.id)

    expect(esito.ok).toBe(false)
    expect(esito.message).not.toContain('✅')
    expect(rows.find(r => r.id === p!.id)!.stato).toBe('proposta')
    expect(await buildRegoleContext()).not.toContain('Regola di troppo.')
  })

  it('le ULTIME confermate non vengono scartate a favore delle piu vecchie', async () => {
    // Con `.order(ascending).limit(30)` restavano le 30 piu VECCHIE e l'ultima
    // confermata spariva senza dirlo: il caso peggiore, perche' e' quella che
    // l'Ingegnere ha appena chiesto.
    for (let i = 0; i < REGOLE_MAX_ATTIVE - 1; i++) await attiva(`Vecchia ${i}.`)
    await attiva('Ultima confermata.')

    expect(await buildRegoleContext()).toContain('Ultima confermata.')
  })

  it('una regola lunga non fa sparire quelle corte che ci starebbero', async () => {
    // Con `break` al superamento del budget, tutto cio' che seguiva la prima
    // regola troppo grande veniva scartato anche se ci sarebbe entrato.
    // NB: proponiRegola tronca a 1000 char, quindi il budget lo satura solo un
    // insieme di regole, mai una sola: e' proprio il caso che `break` rovinava.
    const LUNGA = 1000
    for (let i = 0; i < 4; i++) await attiva('L'.repeat(LUNGA - 3) + `_${i}`)
    await attiva('Corta ma importante.')

    const { dentro, fuori } = await splitRegolePerPrompt()
    expect(fuori.length).toBeGreaterThan(0) // il budget e' davvero saturo
    expect(dentro.map(r => r.testo)).toContain('Corta ma importante.')
    expect(await buildRegoleContext()).toContain('Corta ma importante.')
  })

  it('/regole segnala quelle che NON entrano nel prompt', async () => {
    for (let i = 0; i < 4; i++) await attiva('X'.repeat(997) + `_${i}`)
    await attiva('Questa entra perche corta.')

    const { fuori } = await splitRegolePerPrompt()
    expect(fuori.length).toBeGreaterThan(0)

    const lista = await formatRegoleList()
    expect(lista).toContain('NON entrano nel prompt')
    // elenco e iniezione non possono divergere: cio' che /regole marca come
    // fuori, il prompt non lo contiene
    const ctx = await buildRegoleContext()
    for (const r of fuori) expect(ctx).not.toContain(r.testo)
  })
})

describe('la revoca deve verificare di aver revocato', () => {
  it('se la scrittura fallisce, NON dice di aver rimosso', async () => {
    const id = await attiva('Regola dannosa.')
    updateError = 'connection reset'

    const esito = await rimuoviRegola(id)

    expect(esito.ok).toBe(false)
    expect(esito.message).not.toContain('Rimossa:')
    // ed e' onesto: la regola e' ancora li'
    updateError = null
    expect(await buildRegoleContext()).toContain('Regola dannosa.')
  })

  it('se la conferma fallisce per errore, lo dice come errore', async () => {
    // Senza questo, un errore di scrittura veniva riportato come "risulta gia'
    // decisa": stesso esito ma diagnosi sbagliata, e l'Ingegnere riproverebbe
    // credendo di aver gia' confermato.
    const p = await proponiRegola('Regola con rete rotta.', 'x')
    updateError = 'connection reset'

    const esito = await confermaRegola(p!.id)

    expect(esito.ok).toBe(false)
    expect(esito.message).toContain('connection reset')
    expect(esito.message).not.toContain('già decisa')
  })

  it('se la scrittura fallisce, NON dice di aver scartato la proposta', async () => {
    const p = await proponiRegola('Proposta da scartare.', 'x')
    updateError = 'connection reset'

    const esito = await rifiutaRegola(p!.id)
    expect(esito.ok).toBe(false)
  })

  it('due conferme in corsa non attivano due volte la stessa regola', async () => {
    // LA CORSA VERA: la lettura vede 'proposta', e solo DOPO qualcun altro la
    // decide. Il controllo sulla lettura non basta — l'unica difesa e' il filtro
    // `.eq('stato','proposta')` sull'update. Un test che cambia lo stato PRIMA
    // della lettura esce dal ramo iniziale e non tocca mai quella guardia:
    // sarebbe verde per il motivo sbagliato.
    const p = await proponiRegola('Regola contesa.', 'x')
    afterSelect = () => { rows.find(r => r.id === p!.id)!.stato = 'rifiutata' }

    const esito = await confermaRegola(p!.id)

    expect(esito.ok).toBe(false)
    expect(esito.message).not.toContain('✅')
    expect(rows[0].stato).toBe('rifiutata') // la decisione altrui ha tenuto
    expect(await buildRegoleContext()).toBe('')
  })

  it('rimuovere una regola gia rimossa non dice di averla rimossa', async () => {
    const id = await attiva('Regola doppia rimozione.')
    afterSelect = () => { rows.find(r => r.id === id)!.stato = 'rimossa' }

    const esito = await rimuoviRegola(id)
    expect(esito.ok).toBe(false)
    expect(esito.message).not.toContain('Rimossa:')
  })

  it('rifiutare una proposta gia decisa non dice di averla scartata', async () => {
    const p = await proponiRegola('Proposta contesa.', 'x')
    afterSelect = () => { rows.find(r => r.id === p!.id)!.stato = 'attiva' }

    const esito = await rifiutaRegola(p!.id)
    expect(esito.ok).toBe(false)
  })
})

describe('anteprima prima di attivare', () => {
  it('mostra il testo letto dalla riga e non attiva niente', async () => {
    const p = await proponiRegola('Testo vero della regola.', 'motivo vero')

    const a = await anteprimaRegola(p!.id)

    expect(a.ok).toBe(true)
    expect(a.message).toContain('Testo vero della regola.')
    expect(a.message).toContain(`/regola_ok2_${p!.id}`)
    // il passo 1 NON attiva
    expect(rows[0].stato).toBe('proposta')
    expect(await buildRegoleContext()).toBe('')
  })

  it('non fa vedere l anteprima di una proposta scaduta', async () => {
    const p = await proponiRegola('Vecchia proposta.', 'x')
    rows[0].created_at = new Date(Date.now() - PROPOSTA_TTL_MS - 1000).toISOString()

    const a = await anteprimaRegola(p!.id)
    expect(a.ok).toBe(false)
    expect(a.message).toContain('scaduta')
  })
})
