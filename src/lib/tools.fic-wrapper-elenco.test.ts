/**
 * src/lib/tools.fic-wrapper-elenco.test.ts — un wrapper rivendica per ELENCO,
 * non per prefisso.
 *
 * ⚠️ `executeFicWrapper` era l'unico dei wrapper contabili a rivendicare con
 * `startsWith('fic_')` invece che con `nomiDi(...)`. Siccome `executeFicTool`,
 * per un nome che non conosce, risponde con una STRINGA («tool FIC
 * sconosciuto») invece che con `null`, e `executeTool` si ferma al primo
 * risultato non nullo, ogni tool `fic_*` scritto in un altro file e registrato
 * dopo di lui era IRRAGGIUNGIBILE.
 *
 * La stessa trappola, sul wrapper gemello di Gmail, e' costata una giornata il
 * 14 settembre 2026: `gmail_leggi_allegato` era registrato in cinque posti e
 * in produzione rispondeva «non riconosciuto».
 *
 * Reggeva solo grazie all'ORDINE di `EXECUTORS`. Questo test rende il
 * contratto indipendente dall'ordine: chi lo rompesse se ne accorge qui.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('./societa-attiva', () => ({
  leggiSocietaAttiva: async () => ({ ok: true, codice: 'restruktura', esplicita: true }),
  getSocietaAttiva: async () => 'restruktura',
  setSocietaAttiva: async () => ({ ok: true }),
  bloccoSocietaAttiva: () => '',
}))

const { spiaFic } = vi.hoisted(() => ({ spiaFic: vi.fn(async () => '{"ok":true}') }))
vi.mock('./fatture-in-cloud', async (importOriginal) => {
  const vero = await importOriginal<typeof import('./fatture-in-cloud')>()
  return { ...vero, executeFicTool: spiaFic }
})

import { executeTool } from './tools'

beforeEach(() => spiaFic.mockClear())

describe('il wrapper contabile dei tool fic_ rivendica per elenco', () => {
  it('🚨 un nome fic_ che NON e suo non viene rivendicato: la catena prosegue', async () => {
    // Prima della cura questo tornava «tool FIC sconosciuto» e la catena si
    // fermava qui — che e' esattamente il motivo per cui un tool fic_ nuovo,
    // scritto altrove, non veniva mai eseguito.
    const esito = await executeTool('fic_scritto_in_un_altro_file', {}, 'conv-1')

    expect(esito).not.toContain('tool FIC sconosciuto')
    expect(spiaFic).not.toHaveBeenCalled()
    expect(esito).toContain('non riconosciuto')
  }, 30_000)

  it('CONTROLLO POSITIVO: i nomi VERI di FIC_READ_TOOLS continuano ad arrivargli', async () => {
    // Senza questo, un wrapper che non rivendica piu' niente passerebbe il
    // test qui sopra e spegnerebbe in silenzio tutta la lettura di Fatture in
    // Cloud.
    const esito = await executeTool('fic_fatture_emesse', {}, 'conv-1')

    expect(spiaFic).toHaveBeenCalledTimes(1)
    expect(esito).not.toContain('non riconosciuto')
  }, 30_000)

  it("🚨 fic_aggiorna_anagrafica arriva al SUO esecutore, non al tappo dei fic_", async () => {
    // Si chiama fic_* ma vive in fic-anagrafica.ts: se il wrapper contabile di
    // FIC rivendicasse per prefisso — o se qualcuno lo rimettesse davanti in
    // EXECUTORS — questo tool sarebbe REGISTRATO E IRRAGGIUNGIBILE, e la
    // risposta sarebbe «tool FIC sconosciuto» invece della modifica.
    // Senza id il tool rifiuta subito: nessuna chiamata a Fatture in Cloud.
    const esito = await executeTool('fic_aggiorna_anagrafica', {}, 'conv-1')

    expect(spiaFic).not.toHaveBeenCalled()
    expect(esito).not.toContain('tool FIC sconosciuto')
    expect(esito).not.toContain('non riconosciuto')
    expect(esito).toContain('fic_cerca_anagrafica')
  }, 30_000)
})
