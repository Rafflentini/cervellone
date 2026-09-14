import { describe, it, expect, vi, beforeEach } from 'vitest'

// ⚠️ `vi.hoisted`: la factory di `vi.mock` e' issata sopra le `const` del
// modulo, e qui la factory dereferenzia subito la spia — senza `hoisted`
// esploderebbe in TDZ prima ancora di eseguire un test.
const { fotografaSchema } = vi.hoisted(() => ({ fotografaSchema: vi.fn() }))
vi.mock('@/lib/deriva-schema-db', () => ({ fotografaSchema }))

import { DERIVA_TOOLS, executeDerivaTools } from './deriva-schema-tools'

// ⚠️ CORPO A BLOCCO, non la freccia concisa: `mockReset()` restituisce la spia,
// e vitest scambia un ritorno FUNZIONE per un teardown — richiamando la spia
// dopo ogni test. Qui oggi e' innocuo, ma il giorno in cui una spia fosse
// istruita a sollevare, il rosso arriverebbe dallo smontaggio e non dal codice.
beforeEach(() => { fotografaSchema.mockReset() })

describe('verifica_deriva_schema', () => {
  it('il tool e dichiarato una volta sola e ha un nome stabile', () => {
    expect(DERIVA_TOOLS.map((t) => t.name)).toEqual(['verifica_deriva_schema'])
  })

  it('non risponde ai nomi che non sono suoi', async () => {
    expect(await executeDerivaTools('altro_tool', {})).toBeNull()
  })

  it('🚨 se la fotografia fallisce, il tool DICE che non ha potuto guardare', async () => {
    fotografaSchema.mockResolvedValue({ ok: false, errore: 'fotografia_schema: does not exist' })

    const testo = await executeDerivaTools('verifica_deriva_schema', {})

    expect(testo).toContain('NON')
    expect(testo).toContain('fotografia_schema')
    // E soprattutto: non deve MAI dire che va tutto bene.
    expect(testo?.toLowerCase()).not.toContain('nessuna deriva')
  })

  it('CONTROLLO POSITIVO: con una fotografia completa risponde e riporta i due numeri', async () => {
    // Costruita dagli attesi veri: qualunque cosa il repo prometta oggi, c-e.
    const ATTESI = (await import('@/lib/deriva-schema-attesi.json')).default
    const foto = {
      tabelle: [] as string[], colonne: [] as string[],
      chiaviPrimarie: {} as Record<string, string[]>, indici: [] as string[], chiaviConfig: [] as string[],
    }
    for (const o of ATTESI.oggetti as unknown[]) {
      const x = o as unknown as { tipo: string; tabella?: string; colonna?: string; nome?: string; chiave?: string; colonne?: string[] }
      if (x.tipo === 'tabella') foto.tabelle.push(x.tabella!)
      if (x.tipo === 'colonna') foto.colonne.push(`${x.tabella}.${x.colonna}`)
      if (x.tipo === 'indice') foto.indici.push(x.nome!)
      if (x.tipo === 'config') foto.chiaviConfig.push(x.chiave!)
      if (x.tipo === 'chiave_primaria') foto.chiaviPrimarie[x.tabella!] = x.colonne!
    }
    fotografaSchema.mockResolvedValue({ ok: true, foto })

    const testo = await executeDerivaTools('verifica_deriva_schema', {})

    expect(testo).toContain('Nessuna deriva')
    expect(testo?.toLowerCase()).toContain('non interpretat')
  })
})
