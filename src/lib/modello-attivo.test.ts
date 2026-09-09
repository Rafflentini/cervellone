/**
 * Il modello e' GLOBALE, ma si poteva vedere e cambiare solo da Telegram.
 *
 * `/opus`, `/sonnet` e `/modello` esistono solo li'. Il valore pero' sta in
 * `cervellone_config`, uno per tutto il sistema: chi lavora dalla chat web
 * subisce in silenzio il modello scelto su Telegram, senza modo di sapere
 * quale sia — ne' di riportarlo su Sonnet quando l'ora di Opus e' finita.
 *
 * Un tool, non un comando: `getToolDefinitions()` non conosce i canali, quindi
 * nasce equipollente per costruzione.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const scritture: Array<{ tabella: string; chiave?: string; valore?: unknown; op: string }> = []
let righeConfig: Array<{ key: string; value: string }> = []

const catena = {
  select: () => catena,
  in: async () => ({ data: righeConfig }),
  eq: async (_c: string, chiave: string) => {
    const ultima = scritture[scritture.length - 1]
    if (ultima) ultima.chiave = chiave
    return { error: null }
  },
  update: (riga: Record<string, unknown>) => { scritture.push({ tabella: 'cervellone_config', valore: riga.value, op: 'update' }); return catena },
  upsert: async (riga: Record<string, unknown>) => { scritture.push({ tabella: 'cervellone_config', chiave: String(riga.key), valore: riga.value, op: 'upsert' }); return { error: null } },
  delete: () => { scritture.push({ tabella: 'cervellone_config', op: 'delete' }); return catena },
}
vi.mock('./supabase', () => ({ supabase: { from: () => catena } }))
const cacheSvuotate: string[] = []
vi.mock('./claude', () => ({ invalidateConfigCache: () => { cacheSvuotate.push('config') } }))
vi.mock('./circuit-breaker', () => ({ invalidateCache: () => { cacheSvuotate.push('circuit-breaker') } }))

import { leggiModelloAttivo, impostaModello } from './modello-attivo'

beforeEach(() => {
  scritture.length = 0
  cacheSvuotate.length = 0
  righeConfig = [{ key: 'model_default', value: 'claude-sonnet-5' }]
})

describe('leggiModelloAttivo', () => {
  it('dice quale modello e attivo', async () => {
    const testo = await leggiModelloAttivo()
    expect(testo).toContain('sonnet')
  })

  it('con Opus in corso dice anche FINO A QUANDO', async () => {
    const fra30 = new Date(Date.now() + 30 * 60_000).toISOString()
    righeConfig = [
      { key: 'model_default', value: 'claude-opus-5' },
      { key: 'opus_until', value: fra30 },
    ]
    const testo = await leggiModelloAttivo()
    expect(testo).toContain('opus')
    expect(testo).toMatch(/\d{2}[:.]\d{2}/)
  })

  // Un'ora di Opus gia' scaduta non va annunciata come in corso: il cron la
  // riporta su Sonnet, e dire il contrario e' peggio che non dire niente.
  it('un ora di Opus gia scaduta non si annuncia come in corso', async () => {
    righeConfig = [
      { key: 'model_default', value: 'claude-opus-5' },
      { key: 'opus_until', value: new Date(Date.now() - 60_000).toISOString() },
    ]
    const testo = await leggiModelloAttivo()
    expect(testo).not.toContain('fino alle')
  })
})

describe('impostaModello', () => {
  it('opus scrive il modello e la scadenza', async () => {
    const testo = await impostaModello('opus', 90)
    expect(testo.toLowerCase()).toContain('opus')
    expect(scritture.some((s) => s.op === 'upsert' && s.chiave === 'opus_until')).toBe(true)
    expect(scritture.filter((s) => s.op === 'update')).toHaveLength(2)
  })

  it('sonnet toglie la scadenza di Opus', async () => {
    const testo = await impostaModello('sonnet')
    expect(testo.toLowerCase()).toContain('sonnet')
    expect(scritture.some((s) => s.op === 'delete')).toBe(true)
  })

  /**
   * ⭐ Senza svuotare le cache il cambio NON ha effetto fino alla loro
   * scadenza: il bot continuerebbe a usare il modello vecchio mentre il
   * database dice il contrario, e chi guarda `/modello` leggerebbe una cosa
   * diversa da quella che sta girando. Nessun test lo copriva: la mutazione
   * che toglieva le due chiamate sopravviveva.
   */
  it('le cache si svuotano, o il cambio non ha effetto', async () => {
    await impostaModello('opus', 60)
    expect(cacheSvuotate).toContain('config')
    expect(cacheSvuotate).toContain('circuit-breaker')
  })

  it('valgono anche tornando su Sonnet', async () => {
    await impostaModello('sonnet')
    expect(cacheSvuotate).toContain('config')
    expect(cacheSvuotate).toContain('circuit-breaker')
  })

  // CONTROLLO POSITIVO: senza, una funzione che non scrive niente
  // passerebbe i test qui sopra a mani basse.
  it('un modello sconosciuto non scrive niente', async () => {
    const testo = await impostaModello('gpt' as never)
    expect(scritture).toHaveLength(0)
    expect(cacheSvuotate).toHaveLength(0)
    expect(testo.toLowerCase()).toContain('non riconosc')
  })
})
