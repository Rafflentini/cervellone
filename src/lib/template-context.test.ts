// src/lib/template-context.test.ts — test injection deterministica modelli documento
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { CampoModello } from './document-templates'

// ── Mock di document-templates (listTemplatesForInjection) ──

type InjectionRow = {
  slug: string
  titolo: string
  parole_chiave: string[]
  campi: CampoModello[]
  dati_fissi: Record<string, unknown>
}

let mockedRows: InjectionRow[] = []

vi.mock('./document-templates', () => ({
  listTemplatesForInjection: vi.fn(async () => mockedRows),
}))

import {
  buildTemplateContext,
  invalidateTemplateInjectionCache,
} from './template-context'
import { listTemplatesForInjection } from './document-templates'

const listMock = listTemplatesForInjection as ReturnType<typeof vi.fn>

beforeEach(() => {
  mockedRows = []
  invalidateTemplateInjectionCache()
  listMock.mockClear()
})

// ── Test: nessun template → stringa vuota ──

describe('buildTemplateContext — nessun template', () => {
  it('ritorna stringa vuota quando non ci sono template', async () => {
    mockedRows = []
    const out = await buildTemplateContext('prepara un CIGO')
    expect(out).toBe('')
  })

  it('ritorna stringa vuota con query vuota', async () => {
    mockedRows = [
      {
        slug: 'cigo',
        titolo: 'CIGO Allegato 10',
        parole_chiave: ['cigo', 'cassa integrazione'],
        campi: [],
        dati_fissi: {},
      },
    ]
    const out = await buildTemplateContext('')
    expect(out).toBe('')
  })
})

// ── Test: match trovato → blocco contiene slug e compila_modello ──

describe('buildTemplateContext — keyword match', () => {
  it('ritorna blocco con slug e riferimento a compila_modello', async () => {
    mockedRows = [
      {
        slug: 'cigo',
        titolo: 'CIGO Allegato 10',
        parole_chiave: ['cigo', 'cassa integrazione'],
        campi: [
          { nome: 'periodo_dal', label: 'Data inizio periodo', tipo: 'data', obbligatorio: true },
          { nome: 'periodo_al', label: 'Data fine periodo', tipo: 'data', obbligatorio: true },
          { nome: 'azienda_cf', label: 'Codice fiscale azienda', tipo: 'testo', obbligatorio: true },
        ],
        dati_fissi: {},
      },
    ]

    const out = await buildTemplateContext('prepara il cigo per il mese di maggio')
    expect(out).toContain('cigo')
    expect(out).toContain('compila_modello')
    expect(out).toContain('NON scrivere il documento in prosa')
    expect(out).toContain('MODELLO DOCUMENTO DISPONIBILE')
  })

  it('match via seconda keyword (parola intera)', async () => {
    mockedRows = [
      {
        slug: 'cigo',
        titolo: 'CIGO Allegato 10',
        parole_chiave: ['cigo', 'cassa integrazione'],
        campi: [],
        dati_fissi: {},
      },
    ]

    const out = await buildTemplateContext('ho bisogno della cassa integrazione')
    expect(out).toContain('cigo')
    expect(out).toContain('compila_modello')
  })

  it('nessun match se keyword non e una parola intera', async () => {
    mockedRows = [
      {
        slug: 'cigo',
        titolo: 'CIGO Allegato 10',
        parole_chiave: ['cigo'],
        campi: [],
        dati_fissi: {},
      },
    ]

    // "acigo" contiene "cigo" come sottostringa ma NON come word-boundary
    const out = await buildTemplateContext('pratica acigo richiesta')
    expect(out).toBe('')
  })
})

// ── Test: campi obbligatori esclusi se presenti in dati_fissi ──

describe('buildTemplateContext — filtro campi obbligatori', () => {
  it('esclude dalla lista i campi il cui nome e gia in dati_fissi', async () => {
    mockedRows = [
      {
        slug: 'cigo',
        titolo: 'CIGO Allegato 10',
        parole_chiave: ['cigo'],
        campi: [
          { nome: 'periodo_dal', label: 'Data inizio', tipo: 'data', obbligatorio: true },
          { nome: 'periodo_al', label: 'Data fine', tipo: 'data', obbligatorio: true },
          { nome: 'azienda_cf', label: 'Codice fiscale', tipo: 'testo', obbligatorio: true },
          { nome: 'note', label: 'Note', tipo: 'testo', obbligatorio: false },
        ],
        dati_fissi: { azienda_cf: 'ABCDEF12G34H567I' },
      },
    ]

    const out = await buildTemplateContext('cigo maggio')
    // azienda_cf e gia in dati_fissi -> non deve comparire in "da chiedere"
    expect(out).not.toContain('Codice fiscale')
    // periodo_dal e periodo_al devono comparire
    expect(out).toContain('Data inizio')
    expect(out).toContain('Data fine')
    // note e facoltativo -> non compare (solo obbligatori)
    expect(out).not.toContain('Note')
  })

  it('quando tutti i campi obbligatori sono in dati_fissi, mostra messaggio "nessuno"', async () => {
    mockedRows = [
      {
        slug: 'cigo',
        titolo: 'CIGO Allegato 10',
        parole_chiave: ['cigo'],
        campi: [
          { nome: 'azienda_cf', label: 'Codice fiscale', tipo: 'testo', obbligatorio: true },
        ],
        dati_fissi: { azienda_cf: 'ABCDEF12G34H567I' },
      },
    ]

    const out = await buildTemplateContext('cigo')
    expect(out).toContain('nessuno')
    // e deve comunque mostrare i dati fissi gia memorizzati
    expect(out).toContain('azienda_cf')
  })

  it('dati_fissi vuoti -> tutti i campi obbligatori compaiono, dati fissi = nessuno', async () => {
    mockedRows = [
      {
        slug: 'cigo',
        titolo: 'CIGO Allegato 10',
        parole_chiave: ['cigo'],
        campi: [
          { nome: 'periodo_dal', label: 'Data inizio', tipo: 'data', obbligatorio: true },
          { nome: 'periodo_al', label: 'Data fine', tipo: 'data', obbligatorio: true },
        ],
        dati_fissi: {},
      },
    ]

    const out = await buildTemplateContext('cigo')
    expect(out).toContain('Data inizio')
    expect(out).toContain('Data fine')
    expect(out).toContain('nessuno')
  })
})

// ── Test: cache non rompe la seconda chiamata ──

describe('buildTemplateContext — cache', () => {
  it('non richiama listTemplatesForInjection al secondo invocation (cache valida)', async () => {
    mockedRows = [
      {
        slug: 'cigo',
        titolo: 'CIGO Allegato 10',
        parole_chiave: ['cigo'],
        campi: [],
        dati_fissi: {},
      },
    ]

    await buildTemplateContext('cigo')
    const callsAfterFirst = listMock.mock.calls.length

    await buildTemplateContext('cigo')
    // La seconda chiamata non deve aver aggiunto chiamate al fetch
    expect(listMock.mock.calls.length).toBe(callsAfterFirst)
  })

  it('dopo invalidateTemplateInjectionCache ricarica i template', async () => {
    mockedRows = [
      {
        slug: 'cigo',
        titolo: 'CIGO Allegato 10',
        parole_chiave: ['cigo'],
        campi: [],
        dati_fissi: {},
      },
    ]

    await buildTemplateContext('cigo')
    const callsBefore = listMock.mock.calls.length

    invalidateTemplateInjectionCache()
    await buildTemplateContext('cigo')
    expect(listMock.mock.calls.length).toBeGreaterThan(callsBefore)
  })
})

// ── Test: nessun match -> stringa vuota ──

describe('buildTemplateContext — nessun match', () => {
  it('ritorna stringa vuota se la query non contiene nessuna parola chiave', async () => {
    mockedRows = [
      {
        slug: 'cigo',
        titolo: 'CIGO Allegato 10',
        parole_chiave: ['cigo', 'cassa integrazione'],
        campi: [],
        dati_fissi: {},
      },
    ]

    const out = await buildTemplateContext('voglio un preventivo')
    expect(out).toBe('')
  })
})

// ── Test: preferisce il template con piu hit ──

describe('buildTemplateContext — best match', () => {
  it('seleziona il template con piu keyword corrispondenti', async () => {
    mockedRows = [
      {
        slug: 'cigo',
        titolo: 'CIGO',
        parole_chiave: ['cigo', 'cassa integrazione', 'INPS'],
        campi: [],
        dati_fissi: {},
      },
      {
        slug: 'preventivo',
        titolo: 'Preventivo',
        parole_chiave: ['preventivo'],
        campi: [],
        dati_fissi: {},
      },
    ]

    // La query ha 2 parole chiave di cigo (cigo + cassa integrazione) e 0 di preventivo
    const out = await buildTemplateContext('prepara il cigo per la cassa integrazione')
    expect(out).toContain('cigo')
    expect(out).not.toContain('preventivo')
  })
})
