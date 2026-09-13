/**
 * src/lib/prompts.principio-fondamentale.test.ts
 *
 * Il principio fondamentale, dettato da Raffaele il 13 set 2026:
 *
 *   «Se l'attrezzo non gli basta per svitare una vite deve poter avere la
 *    capacita' di utilizzare mezzi esterni. Non e' che la vite rimane non
 *    svitata perche' il tool magari non funziona: lui deve essere sempre
 *    un'IA, quindi deve trovare una soluzione alternativa. Deve essere libero
 *    e snello, deve potersi andare a prendere un altro attrezzo o costruirlo.»
 *
 * ⚠️ **Perche' questo test esiste.** La memoria del progetto dichiarava, da
 * giorni, che *«il principio fondamentale e' codice morto»*: la regola viveva
 * in un file che nessuno importava. Il 13 set l'ho misurato e confermato —
 * assente dal prompt vivo di **entrambi** i canali.
 *
 * Una regola che non arriva nel prompt vivo non e' una regola: e' una
 * speranza con l'aria di una difesa. Questo test la tiene viva.
 *
 * E tiene vivo anche il suo BORDO, che conta quanto la regola: la liberta' e'
 * sul metodo, mai sul dato. Questo repo ha gia' pagato una pratica INPS in cui
 * i dati mancanti erano stati "ragionevolmente" inventati — ogni operaio a 40
 * ore, sempre — e un segnaposto firmato che attestava un allegato assente.
 */
import { describe, it, expect, vi } from 'vitest'

vi.mock('./supabase', () => ({
  supabase: {
    from: vi.fn(() => {
      const b: Record<string, unknown> = {}
      b.select = vi.fn(() => b)
      b.eq = vi.fn(() => b)
      b.maybeSingle = vi.fn(() => Promise.resolve({ data: null, error: null }))
      b.order = vi.fn(() => b)
      b.limit = vi.fn(() => Promise.resolve({ data: [], error: null }))
      b.insert = vi.fn(() => ({ select: vi.fn().mockResolvedValue({ data: [], error: null }) }))
      return b
    }),
    rpc: vi.fn().mockResolvedValue({ data: [], error: null }),
  },
}))
vi.mock('./skills', () => ({ matchSkills: vi.fn().mockResolvedValue('') }))

import { getChatSystemPrompt, getTelegramSystemPrompt } from './prompts'

/** I due prompt vivi. Se una regola non e' in TUTTI E DUE, non vale su un canale. */
async function prompts(): Promise<Array<[string, string]>> {
  return [
    ['chat web', await getChatSystemPrompt('ciao', [])],
    ['Telegram', await getTelegramSystemPrompt('ciao', [])],
  ]
}

describe('il principio fondamentale arriva nel prompt VIVO di entrambi i canali', () => {
  it('c\'e\' il blocco, e si chiama cosi\'', async () => {
    for (const [canale, p] of await prompts()) {
      expect(p, `manca su ${canale}`).toContain('IL PRINCIPIO FONDAMENTALE')
    }
  })

  it('dice che i tool sono attrezzi, non limiti', async () => {
    for (const [canale, p] of await prompts()) {
      expect(p, `manca su ${canale}`).toMatch(/attrezzi, non i tuoi limiti/i)
    }
  })

  it('vieta di rispondere "non posso" e impone di trovare un\'altra strada', async () => {
    for (const [canale, p] of await prompts()) {
      expect(p, `manca su ${canale}`).toMatch(/non ti fermi e non dici "non posso"/i)
      expect(p, `manca su ${canale}`).toMatch(/trovi un'altra strada/i)
    }
  })

  it('dice che puo\' CHIEDERE cio\' che non ha, invece di rifiutare', async () => {
    for (const [canale, p] of await prompts()) {
      expect(p, `manca su ${canale}`).toMatch(/mi servirebbe/i)
    }
  })
})

describe('il BORDO del principio: libero sul metodo, mai sul dato', () => {
  it('vieta di inventare un dato mancante', async () => {
    for (const [canale, p] of await prompts()) {
      expect(p, `manca su ${canale}`).toMatch(/non inventare mai un dato che non hai/i)
    }
  })

  it('vieta le azioni irreversibili da solo', async () => {
    for (const [canale, p] of await prompts()) {
      expect(p, `manca su ${canale}`).toMatch(/azione irreversibile/i)
    }
  })

  it('dice che un segnaposto non e\' una dichiarazione (pratica INPS, 9 set 2026)', async () => {
    for (const [canale, p] of await prompts()) {
      expect(p, `manca su ${canale}`).toMatch(/segnaposto non e' una dichiarazione/i)
    }
  })
})

describe('puo\' migliorare i propri attrezzi, e sa dove guardare', () => {
  it('lo invita a proporre miglioramenti quando un attrezzo lo fa faticare', async () => {
    for (const [canale, p] of await prompts()) {
      expect(p, `manca su ${canale}`).toMatch(/proponi come migliorarlo/i)
    }
  })

  it('gli dice DOVE sta la sua esperienza: il registro delle chiamate', async () => {
    // Senza questa riga «proponi miglioramenti» e' un invito senza dati.
    // Il registro esiste dall'11 set 2026 ed e' quello che il 12 ha permesso
    // di scoprire 29 chiamate al dettaglio di una fattura per cercare un campo
    // che quel dettaglio non contiene.
    for (const [canale, p] of await prompts()) {
      expect(p, `manca su ${canale}`).toContain('cervellone_tool_calls')
    }
  })
})
