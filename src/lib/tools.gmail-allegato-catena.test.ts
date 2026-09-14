/**
 * src/lib/tools.gmail-allegato-catena.test.ts — un tool registrato dev'essere
 * anche RAGGIUNGIBILE.
 *
 * ⚠️ Il 14 settembre 2026 `gmail_leggi_allegato` era scritto, importato in
 * `tools.ts`, presente in `ALL_TOOLS`, agganciato a `EXECUTORS` e dentro il
 * perimetro della segretaria in `mappa-officina.ts`. Cinque verifiche su cinque
 * dicevano «c'e'». E in produzione il modello, chiamandolo, si sentiva
 * rispondere «Tool gmail_leggi_allegato non riconosciuto».
 *
 * Il motivo: `executeGmailWrapper` rivendica OGNI nome che comincia per
 * `gmail_` e, per quelli che non conosce, restituiva una STRINGA invece di
 * `null`. `executeTool` si ferma al primo risultato non nullo — e il wrapper
 * sta al posto 22 della catena, l'esecutore degli allegati al 33. Il tool non
 * veniva mai raggiunto.
 *
 * Nessun test di registrazione poteva accorgersene: guardavano l'elenco, non
 * la catena. Questo chiama `executeTool` come lo chiama il modello.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const { spiaReadMessage, spiaScarica, spiaTestoDaPdf } = vi.hoisted(() => ({
  spiaReadMessage: vi.fn(async () => ({
    subject: 'Your Booking.com invoice',
    attachments: [{ filename: 'invoice.pdf', attachmentId: 'ATT-1', sizeBytes: 12_345 }],
  })),
  spiaScarica: vi.fn(async () => Buffer.from('%PDF-finto').toString('base64')),
  spiaTestoDaPdf: vi.fn(async () => ({ ok: true, pagine: 1, testo: 'Commission fee 123,45 EUR' })),
}))

// Mock parziale: gmail-tools e drive esportano decine di funzioni che altri
// esecutori della catena importano davvero. Si sostituiscono le tre che
// toccherebbero la rete, non il modulo intero.
vi.mock('./gmail-tools', async (importOriginal) => {
  const vero = await importOriginal<typeof import('./gmail-tools')>()
  return { ...vero, readMessage: spiaReadMessage, scaricaAllegato: spiaScarica }
})
vi.mock('./drive', async (importOriginal) => {
  const vero = await importOriginal<typeof import('./drive')>()
  return { ...vero, testoDaPdf: spiaTestoDaPdf }
})

import { executeTool } from './tools'
import { executeGmailWrapper } from './tools/mail'

beforeEach(() => {
  spiaReadMessage.mockClear()
  spiaScarica.mockClear()
  spiaTestoDaPdf.mockClear()
})

describe('gmail_leggi_allegato arriva davvero al suo esecutore', () => {
  it('🚨 la catena lo esegue: restituisce il testo del PDF, non «non riconosciuto»', async () => {
    const esito = await executeTool('gmail_leggi_allegato', {
      casella: 'larealestate',
      message_id: 'MSG-1',
    })

    expect(esito).not.toContain('non riconosciuto')
    expect(esito).toContain('Commission fee 123,45 EUR')
    // La prova che l'esecutore VERO e' stato raggiunto, non che qualcuno abbia
    // improvvisato una risposta plausibile.
    expect(spiaReadMessage).toHaveBeenCalledWith('larealestate', 'MSG-1')
  }, 30_000)

  it('🚨 il wrapper gmail non rivendica piu un nome che non e suo', async () => {
    // Il difetto in un sola riga: prima qui tornava una stringa.
    expect(await executeGmailWrapper('gmail_leggi_allegato', {})).toBeNull()
  })

  it('CONTROLLO POSITIVO: un nome gmail inesistente viene ancora RIFIUTATO, non ingoiato', async () => {
    // Senza questo, un wrapper che tornasse sempre null passerebbe il test qui
    // sopra e farebbe sparire in silenzio ogni errore di battitura del modello.
    const esito = await executeTool('gmail_inventato_di_sana_pianta', {})

    expect(esito).toContain('non riconosciuto')
    expect(spiaReadMessage).not.toHaveBeenCalled()
  }, 30_000)
})
