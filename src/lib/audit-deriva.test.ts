import { describe, it, expect, vi, beforeEach } from 'vitest'

// ⚠️ `vi.hoisted`: la factory di `vi.mock` e' issata sopra le `const` del
// modulo, e qui la factory dereferenzia subito la spia — senza `hoisted`
// esploderebbe in TDZ prima ancora di eseguire un test.
const { executeDerivaTools } = vi.hoisted(() => ({ executeDerivaTools: vi.fn() }))
vi.mock('@/lib/tools/deriva-schema-tools', () => ({ executeDerivaTools, DERIVA_TOOLS: [] }))

import { sezioneDeriva } from './audit-deriva'

// ⚠️ CORPO A BLOCCO, non la freccia concisa. `mockReset()` restituisce la spia
// stessa, e vitest interpreta un valore di ritorno FUNZIONE come teardown: lo
// richiamerebbe dopo ogni test. Con `beforeEach(() => spia.mockReset())` il
// test «se il controllo esplode» falliva pur essendo verde nel corpo — a
// esplodere era la chiamata di smontaggio, non il codice in prova.
beforeEach(() => { executeDerivaTools.mockReset() })

describe('self-audit — la sezione sulla deriva', () => {
  it('🚨 c-e ANCHE quando non c-e nessuna deriva', async () => {
    // Un sorvegliante che parla solo quando c-e un guasto e- indistinguibile
    // da uno morto: e- il difetto che ha tenuto sei rapporti di autodiagnosi
    // nel cassetto per sei settimane.
    executeDerivaTools.mockResolvedValue('Nessuna deriva: 40 oggetti del repo sono presenti nel database.\nStatement non interpretati dal controllo: 12.')

    const s = await sezioneDeriva()

    expect(s).toContain('Deriva fra repository e database')
    expect(s).toContain('Nessuna deriva')
    expect(s).toContain('12')
  })

  it('riporta la deriva quando c-e', async () => {
    executeDerivaTools.mockResolvedValue('DERIVA: 3 oggetti su 40 promessi dal repo NON esistono nel database.')
    expect(await sezioneDeriva()).toContain('DERIVA: 3 oggetti')
  })

  it('se il controllo esplode, il rapporto lo DICE e non salta la sezione', async () => {
    executeDerivaTools.mockRejectedValue(new Error('rete giu'))

    const s = await sezioneDeriva()

    expect(s).toContain('Deriva fra repository e database')
    expect(s.toLowerCase()).toContain('non')
    expect(s).not.toContain('Nessuna deriva')
  })
})
