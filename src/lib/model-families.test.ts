/**
 * Riproduce l'incidente Fable 5.1 del 1 settembre 2026.
 *
 * L'elenco vero restituito da /v1/models quel giorno (verificato con la chiave
 * di produzione). Il report del bot ne mostrava solo tre famiglie, hardcoded, e
 * `claude-fable-5-1` — il modello PIU' RECENTE, uscito il 28 agosto — spariva.
 */
import { describe, it, expect } from 'vitest'
import {
  famigliaDi, raggruppaPerFamiglia, formatModelliDisponibili, migliorePerFamiglia,
} from './model-families'

/** Risposta reale di /v1/models, 2 settembre 2026. */
const MODELLI_VERI = [
  { id: 'claude-fable-5-1', created_at: '2026-08-28' },
  { id: 'claude-opus-5', created_at: '2026-07-24' },
  { id: 'claude-sonnet-5', created_at: '2026-06-30' },
  { id: 'claude-fable-5', created_at: '2026-06-10' },
  { id: 'claude-opus-4-8', created_at: '2026-05-20' },
  { id: 'claude-opus-4-7', created_at: '2026-04-15' },
  { id: 'claude-sonnet-4-6', created_at: '2026-03-01' },
  { id: 'claude-opus-4-6', created_at: '2026-02-10' },
  { id: 'claude-opus-4-5-20251101', created_at: '2025-11-01' },
  { id: 'claude-haiku-4-5-20251001', created_at: '2025-10-01' },
  { id: 'claude-sonnet-4-5-20250929', created_at: '2025-09-29' },
]

const IN_USO = ['sonnet', 'opus', 'haiku']

describe('famigliaDi', () => {
  it('ricava la famiglia dagli id, anche da quelli nuovi', () => {
    expect(famigliaDi('claude-fable-5-1')).toBe('fable')
    expect(famigliaDi('claude-opus-5')).toBe('opus')
    expect(famigliaDi('claude-haiku-4-5-20251001')).toBe('haiku')
    expect(famigliaDi('claude-sonnet-4-6')).toBe('sonnet')
  })

  it('regge gli id vecchi col numero prima del nome', () => {
    expect(famigliaDi('claude-3-opus-20240229')).toBe('opus')
    expect(famigliaDi('claude-3-5-sonnet-20241022')).toBe('sonnet')
  })

  it('una famiglia mai vista prima non sparisce', () => {
    // Il punto di tutto: nessuna lista scritta a mano da aggiornare.
    expect(famigliaDi('claude-qualcosa-9')).toBe('qualcosa')
  })
})

describe('elenco dei modelli disponibili', () => {
  it('mostra Fable, che il report vecchio nascondeva', () => {
    const out = formatModelliDisponibili(MODELLI_VERI, IN_USO)

    expect(out).toContain('claude-fable-5-1')
    expect(out).toContain('claude-fable-5')
  })

  it('non perde NESSUN modello restituito dall API', () => {
    const out = formatModelliDisponibili(MODELLI_VERI, IN_USO)
    for (const m of MODELLI_VERI) {
      expect(out).toContain(m.id)
    }
    // il totale stampato e' la sentinella: se un giorno il raggruppamento
    // perdesse qualcosa, il numero non tornerebbe con le righe elencate
    expect(out).toContain(`(${MODELLI_VERI.length} dall'API Anthropic)`)
  })

  it('dice che una famiglia esiste ma non e in uso, invece di ometterla', () => {
    const out = formatModelliDisponibili(MODELLI_VERI, IN_USO)

    expect(out).toContain('ESISTONO ma che la configurazione non usa')
    expect(out).toContain('fable')
    // la distinzione che e' mancata nell'incidente
    expect(out).toContain('non le sto usando, è diverso')
  })

  it('quando tutte le famiglie sono in uso non avvisa di niente', () => {
    const solite = MODELLI_VERI.filter(m => famigliaDi(m.id) !== 'fable')
    const out = formatModelliDisponibili(solite, IN_USO)
    expect(out).not.toContain('ESISTONO ma')
  })

  it('un elenco vuoto lo dice, non finge', () => {
    expect(formatModelliDisponibili([], IN_USO)).toContain('Nessun modello')
  })
})

describe('scelta del migliore per famiglia', () => {
  it('prende il piu recente per data, non il primo alfabetico', () => {
    expect(migliorePerFamiglia(MODELLI_VERI, 'opus')).toBe('claude-opus-5')
    expect(migliorePerFamiglia(MODELLI_VERI, 'sonnet')).toBe('claude-sonnet-5')
    expect(migliorePerFamiglia(MODELLI_VERI, 'fable')).toBe('claude-fable-5-1')
  })

  it('una famiglia assente ritorna null invece di inventare', () => {
    expect(migliorePerFamiglia(MODELLI_VERI, 'mythos')).toBeNull()
  })

  it('raggruppa ogni modello in una sola famiglia', () => {
    const gruppi = raggruppaPerFamiglia(MODELLI_VERI)
    const totale = [...gruppi.values()].reduce((n, g) => n + g.length, 0)
    expect(totale).toBe(MODELLI_VERI.length)
  })
})
