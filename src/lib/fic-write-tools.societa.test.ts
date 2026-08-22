/**
 * Ogni conferma contabile deve dichiarare a nome di CHI sta per nascere il
 * documento.
 *
 * La difesa contro la società sbagliata non è il codice: è che l'Ingegnere legga
 * il nome errato PRIMA di dare il /ok. Se il nome non compare, quella difesa non
 * esiste — e una fattura elettronica trasmessa non si cancella, si corregge con
 * una nota di credito.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

let rigaInserita: Record<string, unknown> | null = null
let descrizioneSalvata = ''
/** Ogni .eq(colonna, valore) usato dalle query, per provare i filtri. */
const filtriUsati: Array<[string, unknown]> = []

vi.mock('./supabase', () => ({
  supabase: {
    from: () => ({
      insert: (row: Record<string, unknown>) => {
        rigaInserita = row
        return { select: () => ({ single: async () => ({ data: { id: 'bozza-1' }, error: null }) }) }
      },
      // catena di sola lettura che REGISTRA i filtri usati
      select: () => {
        const b: Record<string, unknown> = {}
        b.eq = (colonna: string, valore: unknown) => { filtriUsati.push([colonna, valore]); return b }
        b.order = () => b
        b.limit = () => b
        b.maybeSingle = async () => ({ data: { id: 'bozza-1', stato: 'annullata', fic_document_id: null, societa: 'restruktura' }, error: null })
        b.then = (risolvi: (v: { data: unknown[]; error: null }) => unknown) =>
          Promise.resolve({ data: [], error: null }).then(risolvi)
        return b
      },
      update: (row: Record<string, unknown>) => {
        if (typeof row.descrizione === 'string' && row.descrizione) descrizioneSalvata = row.descrizione
        return {
          eq: () => ({
            eq: () => ({
              eq: () => ({
                select: async () => ({ data: [{ id: 'bozza-1', societa: 'larealestate' }], error: null }),
              }),
            }),
            select: () => ({
              single: async () => ({
                data: { id: 'bozza-1', descrizione: descrizioneSalvata },
                error: null,
              }),
            }),
          }),
        }
      },
    }),
  },
}))

// Anagrafica e aliquote risolte senza rete
vi.mock('./fatture-in-cloud', () => ({
  // entrambe le aliquote: 10% per l'alloggio, 22% per i lavori
  ficGet: async () => ({ ok: true, data: { data: [{ id: 7, value: 10 }, { id: 3, value: 22 }] } }),
  getCompanyId: async () => ({ ok: true, id: '222' }),
  creaDocumentoFIC: async () => ({ ok: true, id: 'doc-1', url: null }),
  eliminaDocumentoFIC: async () => ({ ok: true }),
}))

import { executeFicWriteTool, confirmFicStep1 } from './fic-write-tools'

describe('le conferme dichiarano la societa', () => {
  beforeEach(() => {
    rigaInserita = null
    descrizioneSalvata = ''
  })

  it('la bozza porta con se la societa', async () => {
    await executeFicWriteTool(
      'compila_fattura_emessa',
      { cliente: 'Mario Rossi', righe: [{ descrizione: 'Soggiorno', quantita: 1, prezzo_unitario: 200, aliquota: 10 }] },
      'larealestate',
    )
    expect(rigaInserita?.societa).toBe('larealestate')
  })

  it('il testo che l Ingegnere legge nomina societa e partita IVA', async () => {
    const risposta = await executeFicWriteTool(
      'compila_fattura_emessa',
      { cliente: 'Mario Rossi', righe: [{ descrizione: 'Soggiorno', quantita: 1, prezzo_unitario: 200, aliquota: 10 }] },
      'larealestate',
    )

    expect(String(risposta)).toContain('LA REAL ESTATE SRLS')
    expect(String(risposta)).toContain('02232730768')
    expect(descrizioneSalvata).toContain('LA REAL ESTATE SRLS')
  })

  it('non mostra la societa sbagliata', async () => {
    const risposta = await executeFicWriteTool(
      'compila_fattura_emessa',
      { cliente: 'Mario Rossi', righe: [{ descrizione: 'Lavori', quantita: 1, prezzo_unitario: 100, aliquota: 22 }] },
      'restruktura',
    )
    expect(String(risposta)).toContain('RESTRUKTURA')
    expect(String(risposta)).not.toContain('LA REAL ESTATE')
  })

  // Una riga senza aliquota esplicita deve prendere quella della SOCIETA:
  // 10% per l'alloggio de La Real Estate, 22% per i lavori di Restruktura.
  // Prima era cablato 22 e una fattura alloggio sarebbe uscita con l'IVA
  // sbagliata su un documento fiscale vero.
  it('una riga senza aliquota usa quella della societa, non un 22 cablato', async () => {
    await executeFicWriteTool(
      'compila_fattura_emessa',
      { cliente: 'Mario Rossi', righe: [{ descrizione: 'Soggiorno 3 notti', quantita: 1, prezzo_unitario: 200 }] },
      'larealestate',
    )

    expect(descrizioneSalvata).toContain('IVA 10%')
    expect(descrizioneSalvata).not.toContain('IVA 22%')
  })

  it('e per Restruktura resta il 22%', async () => {
    await executeFicWriteTool(
      'compila_fattura_emessa',
      { cliente: 'Cliente', righe: [{ descrizione: 'Ponteggio', quantita: 1, prezzo_unitario: 100 }] },
      'restruktura',
    )

    expect(descrizioneSalvata).toContain('IVA 22%')
  })

  // L'elenco delle bozze era l'unica lettura contabile senza filtro societa:
  // mescolava le bozze delle due aziende.
  it('l elenco delle bozze filtra per societa', async () => {
    filtriUsati.length = 0
    await executeFicWriteTool('lista_bozze_fic', {}, 'larealestate')

    expect(filtriUsati).toContainEqual(['societa', 'larealestate'])
  })

  // Senza filtro, da un contesto Restruktura si poteva annullare — e cancellare
  // da Fatture in Cloud — una bozza de La Real Estate.
  it('la cancellazione di una bozza filtra per societa', async () => {
    filtriUsati.length = 0
    await executeFicWriteTool('elimina_bozza_fic', { id: 'bozza-1' }, 'restruktura')

    expect(filtriUsati).toContainEqual(['societa', 'restruktura'])
  })

  // L'ultimo passaggio prima della creazione: ultima occasione per accorgersene.
  it('la prima conferma ripete la societa della bozza', async () => {
    const msg = await confirmFicStep1('bozza-1')
    expect(msg).toContain('LA REAL ESTATE SRLS')
    expect(msg).toContain('02232730768')
  })
})
