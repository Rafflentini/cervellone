/**
 * src/lib/fatture-in-cloud.cerca-anagrafica.test.ts
 *
 * ⚠️ **Il difetto che questa ricerca chiudeva a metà.**
 *
 * Fino al 13 set 2026 `fic_cerca_anagrafica` cercava **solo per nome**. Il nome
 * è la chiave meno affidabile che esista: «Rossi Mario» e «Mario Rossi» sono la
 * stessa persona, e una ricerca `name contains` non li unisce.
 *
 * Su un ospite ricorrente de La Real Estate questo voleva dire concludere «non
 * c'è» e creargli **la seconda scheda** — cioè il doppione, esattamente il
 * difetto che `fic_crea_cliente` era appena nato per evitare. Una guardia a
 * valle non serve a niente se il passo a monte dice il falso.
 *
 * Parole di Raffaele, 13 set 2026: *«prima di andare a creare una nuova
 * anagrafica va nell'anagrafica clienti e vede se il cliente è già in
 * anagrafica con i suoi dati, codice fiscale o partita IVA»*.
 *
 * Nessuna chiamata vera a Fatture in Cloud.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

const stato = {
  /** Le query inviate, in ordine: è quello che il test deve poter guardare. */
  query: [] as string[],
  /** Cosa risponde FIC, per query. */
  risposte: new Map<string, Record<string, unknown>[]>(),
}

vi.mock('@supabase/supabase-js', () => {
  const chain: Record<string, unknown> = {}
  for (const m of ['select', 'eq', 'insert', 'update', 'upsert', 'delete', 'order', 'limit', 'in', 'ilike']) chain[m] = () => chain
  chain.single = () => Promise.resolve({ data: null, error: null })
  chain.then = (res: (v: unknown) => unknown) => res({ data: [], error: null })
  return { createClient: () => ({ from: () => chain }) }
})

/**
 * `fetch` finto: `executeFicTool` passa da `ficGet`, che usa fetch. Mockare
 * fetch invece di ficGet prova anche che la query venga COSTRUITA bene, non
 * solo passata.
 */
const fetchFinto = vi.fn(async (url: string) => {
  const q = new URL(url).searchParams.get('q') ?? ''
  if (q) stato.query.push(q)
  return {
    ok: true,
    status: 200,
    json: async () => ({ data: stato.risposte.get(q) ?? [] }),
  } as unknown as Response
})
vi.stubGlobal('fetch', fetchFinto)

beforeEach(() => {
  stato.query = []
  stato.risposte = new Map()
  process.env.FIC_ACCESS_TOKEN = 'finto'
  process.env.FIC_COMPANY_ID = '42'
  process.env.FIC_ACCESS_TOKEN_LAREALESTATE = 'finto'
  process.env.FIC_COMPANY_ID_LAREALESTATE = '43'
  fetchFinto.mockClear()
})

import { executeFicTool } from './fatture-in-cloud'

const cerca = async (input: Record<string, unknown>) => {
  const r = await executeFicTool('fic_cerca_anagrafica', { tipo: 'cliente', ...input }, 'restruktura')
  // `null` vorrebbe dire «questo esecutore non gestisce il tool»: qui sarebbe
  // un difetto vero, non un caso da assorbire in silenzio.
  if (r === null) throw new Error('executeFicTool non ha gestito fic_cerca_anagrafica')
  return JSON.parse(r)
}

describe('⭐ si cerca per CHIAVE FISCALE, non solo per nome', () => {
  it('col codice fiscale interroga tax_code', async () => {
    await cerca({ codice_fiscale: 'RSSMRA80A01H501U' })
    expect(stato.query.some((q) => q.includes("tax_code = 'RSSMRA80A01H501U'"))).toBe(true)
  })

  it('con la partita IVA interroga vat_number', async () => {
    await cerca({ partita_iva: '02087420762' })
    expect(stato.query.some((q) => q.includes("vat_number = '02087420762'"))).toBe(true)
  })

  it('il codice fiscale si normalizza: spazi e minuscole non fanno due persone', async () => {
    await cerca({ codice_fiscale: ' rssmra80a01h501u ' })
    expect(stato.query.some((q) => q.includes("tax_code = 'RSSMRA80A01H501U'"))).toBe(true)
  })

  it('⭐ con nome E codice fiscale cerca ENTRAMBI, non si ferma al primo', async () => {
    // Il punto: il nome da solo puo' non trovare («Rossi Mario» vs «Mario
    // Rossi»), e fermarsi li' significa creare il doppione. Le chiavi si
    // sommano.
    await cerca({ nome: 'Mario Rossi', codice_fiscale: 'RSSMRA80A01H501U' })
    expect(stato.query.some((q) => q.startsWith('tax_code'))).toBe(true)
    expect(stato.query.some((q) => q.startsWith('name contains'))).toBe(true)
  })

  it('lo stesso cliente trovato da due chiavi compare UNA volta sola', async () => {
    const riga = { id: 7, name: 'Mario Rossi', tax_code: 'RSSMRA80A01H501U' }
    stato.risposte.set("tax_code = 'RSSMRA80A01H501U'", [riga])
    stato.risposte.set("name contains 'Mario Rossi'", [riga])
    const r = await cerca({ nome: 'Mario Rossi', codice_fiscale: 'RSSMRA80A01H501U' })
    expect(r.count).toBe(1)
    expect(r.anagrafiche[0].id).toBe(7)
  })

  it('CONTROLLO POSITIVO — col solo nome NON interroga le chiavi fiscali', async () => {
    // Senza questo, i test sopra passerebbero anche se il tool interrogasse
    // sempre tutto a prescindere dall'input: proverebbero zero.
    await cerca({ nome: 'Rossi' })
    expect(stato.query.some((q) => q.startsWith('tax_code'))).toBe(false)
    expect(stato.query.some((q) => q.startsWith('vat_number'))).toBe(false)
    expect(stato.query.some((q) => q.startsWith('name contains'))).toBe(true)
  })
})

describe('un elenco vuoto e un DATO, e va detto come tale', () => {
  it('se non trova nessuno dice cosa fare, invece di sembrare un guasto', async () => {
    // «Non c'e'» e «non l'ho letto» sono due cose diverse: un vuoto senza
    // spiegazione fa concludere al modello che non ha potuto cercare, e si
    // ferma. E' la regola nata dalla fattura 2/1144.
    const r = await cerca({ codice_fiscale: 'XXXXXX00X00X000X' })
    expect(r.ok).toBe(true)
    expect(r.count).toBe(0)
    expect(r.cosa_faccio_adesso).toMatch(/fic_crea_cliente/)
  })

  it('se trova, dice di usare il cliente_id', async () => {
    stato.risposte.set("name contains 'Rossi'", [{ id: 7, name: 'Mario Rossi' }])
    const r = await cerca({ nome: 'Rossi' })
    expect(r.cosa_faccio_adesso).toMatch(/cliente_id/)
  })

  it('dichiara CON QUALE chiave ha trovato: serve a fidarsi del risultato', async () => {
    stato.risposte.set("tax_code = 'RSSMRA80A01H501U'", [{ id: 7, name: 'Mario Rossi' }])
    const r = await cerca({ nome: 'Bianchi', codice_fiscale: 'RSSMRA80A01H501U' })
    expect(r.trovato_per).toContain('tax_code')
    expect(r.cercato_per.length).toBe(2)
  })

  it('senza NESSUNA chiave rifiuta, invece di cercare tutto', async () => {
    const r = await cerca({})
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/almeno uno/i)
    expect(stato.query).toEqual([])
  })
})
