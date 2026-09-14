/**
 * `societaDellaConversazione` (tools.ts:844) chiamava `getSocietaAttiva`, che su
 * un errore di lettura database restituisce silenziosamente `restruktura`. Il
 * wrapper `contabile` (tools.ts:867) passa quel codice a CINQUE esecutori —
 * fic_* (lettura), FIC_WRITE_TOOLS, riconciliazione, prima nota, movimenti — che
 * emettono fatture e registrano pagamenti. Un guasto transitorio, mentre
 * l'Ingegnere lavora su un'altra societa, farebbe girare l'operazione contabile
 * sull'azienda SBAGLIATA, in silenzio: una fattura elettronica trasmessa non si
 * richiama.
 *
 * Venti righe sopra, per la conversazione assente, il codice gia' rifiuta
 * invece di indovinare (`senzaConversazione`). Questi test pinnano lo stesso
 * rifiuto per la lettura fallita: un errore non e' una societa'.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// Lo stato del finto database vive fuori dal mock, come in societa-attiva.test.ts
let esitoSocieta: unknown = { ok: true, codice: 'larealestate', esplicita: true }
vi.mock('./societa-attiva', () => ({
  leggiSocietaAttiva: async () => esitoSocieta,
  getSocietaAttiva: async () => 'restruktura',
  setSocietaAttiva: async () => ({ ok: true }),
  bloccoSocietaAttiva: () => '',
}))

// spiaEsecutore sostituisce UNO dei cinque esecutori contabili (fic_*, tramite
// executeFicTool). Mock parziale via importOriginal: fic-write-tools,
// riconciliazione-tools, fic-pagamenti e fic-allegato importano altri export
// dello stesso modulo (ficGet, getCompanyId, creaDocumentoFIC, ...) e vanno
// preservati, non solo il minimo che serve a QUESTO file.
const { spiaEsecutore } = vi.hoisted(() => ({ spiaEsecutore: vi.fn(async () => '{"ok":true}') }))
vi.mock('./fatture-in-cloud', async (importOriginal) => {
  const vero = await importOriginal<typeof import('./fatture-in-cloud')>()
  return { ...vero, executeFicTool: spiaEsecutore }
})

import { executeTool } from './tools'

beforeEach(() => {
  spiaEsecutore.mockClear()
  esitoSocieta = { ok: true, codice: 'larealestate', esplicita: true }
})

describe('un guasto nella lettura della societa non fa girare il tool sulla societa indovinata', () => {
  it('CONTROLLO POSITIVO — lettura della societa fallita: il tool contabile NON viene eseguito', async () => {
    esitoSocieta = { ok: false, errore: 'connessione persa' }
    const out = await executeTool('fic_fatture_emesse', {}, 'conv-1')
    const j = JSON.parse(String(out))
    expect(j.ok).toBe(false)
    expect(j.error).toContain('connessione persa')
    // la prova che conta: l'esecutore non e' stato chiamato
    expect(spiaEsecutore).not.toHaveBeenCalled()
  })

  it('CONTROLLO NEGATIVO — societa leggibile: il tool gira, e gira sulla societa GIUSTA', async () => {
    esitoSocieta = { ok: true, codice: 'larealestate', esplicita: true }
    await executeTool('fic_fatture_emesse', {}, 'conv-1')
    expect(spiaEsecutore).toHaveBeenCalledWith('fic_fatture_emesse', {}, 'larealestate')
  })

  it('senza conversazione rifiuta come prima (comportamento invariato)', async () => {
    const out = await executeTool('fic_fatture_emesse', {}, undefined)
    expect(JSON.parse(String(out)).ok).toBe(false)
    expect(spiaEsecutore).not.toHaveBeenCalled()
  })

  it('un tool NON contabile non e\' toccato da questa guardia', async () => {
    esitoSocieta = { ok: false, errore: 'connessione persa' }
    // imposta_societa_attiva non passa da `contabile`: deve continuare a
    // funzionare anche quando la societa attiva non si legge, altrimenti la
    // guardia bloccherebbe anche il caso normale (la guardia stessa che serve
    // a CAMBIARE societa smetterebbe di funzionare proprio quando serve di piu').
    const out = await executeTool('imposta_societa_attiva', { societa: 'restruktura' }, 'conv-1')
    expect(out).not.toBeNull()
    expect(String(out)).not.toContain('non riesco a leggere')
    expect(String(out)).toContain('Societa attiva')
  })

  it('i messaggi di rifiuto non contengono underscore ne comandi slash', async () => {
    esitoSocieta = { ok: false, errore: 'x' }
    const a = String(await executeTool('fic_fatture_emesse', {}, 'conv-1'))
    const b = String(await executeTool('fic_fatture_emesse', {}, undefined))
    for (const msg of [JSON.parse(a).error, JSON.parse(b).error]) {
      expect(msg).not.toMatch(/_/)
      expect(msg).not.toMatch(/\/[a-z]+/)
    }
  })
})
