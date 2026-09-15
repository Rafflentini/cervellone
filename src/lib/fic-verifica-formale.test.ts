/**
 * src/lib/fic-verifica-formale.test.ts — la VERIFICA FORMALE di Fatture in
 * Cloud, e le due cose che deve garantire.
 *
 * 🚨 UNO: che non TRASMETTA. L'invio allo SdI resta un gesto dell'Ingegnere.
 * Qui non basta il commento nel sorgente: si guarda il METODO e l'URL veri che
 * escono dalla funzione, con un `fetch` finto.
 *
 * 🚨 DUE: che un controllo NON FATTO non si travesta da controllo passato. Un
 * 403 (all'app manca lo scope), un 500, una rete che cade, un 200 che non dice
 * se l'XML e' valido: tutti `non_verificato`, mai `valido`. E' il difetto di
 * famiglia di questa casa — il guasto che invece di chiudere APRE — e qui il
 * tipo lo vieta, ma solo se questi test ci sono.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { verificaFormaleXml, rigaVerificaFormale } from './fic-verifica-formale'

const AMBIENTE_ORIGINALE = { ...process.env }
const fetchFinto = vi.fn()

function risposta(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  } as unknown as Response
}

beforeEach(() => {
  fetchFinto.mockReset()
  vi.stubGlobal('fetch', fetchFinto)
  process.env.FIC_COMPANY_ID_LAREALESTATE = '222'
  process.env.FIC_ACCESS_TOKEN_LAREALESTATE = 'token-finto'
})

afterEach(() => {
  process.env = { ...AMBIENTE_ORIGINALE }
  vi.unstubAllGlobals()
})

describe('⛔ la verifica LEGGE: non manda niente allo SdI', () => {
  it('chiama in GET l endpoint xml_verify dell azienda giusta', async () => {
    fetchFinto.mockResolvedValue(risposta(200, { data: { success: true } }))

    await verificaFormaleXml('552759661', 'larealestate')

    expect(fetchFinto).toHaveBeenCalledTimes(1)
    const [url, init] = fetchFinto.mock.calls[0]
    expect(String(url)).toBe('https://api-v2.fattureincloud.it/c/222/issued_documents/552759661/e_invoice/xml_verify')
    expect(init.method).toBe('GET')
    // ⛔ CONTROLLO POSITIVO AL CONTRARIO: nessun corpo, nessun POST, e il
    // percorso non e' quello dell'invio.
    expect(init.body).toBeUndefined()
    expect(String(url)).not.toMatch(/\/send$/)
  })

  it('senza token non chiama NIENTE e dice che non ha verificato', async () => {
    delete process.env.FIC_ACCESS_TOKEN_LAREALESTATE

    const esito = await verificaFormaleXml('1', 'larealestate')

    expect(esito.esito).toBe('non_verificato')
    expect(fetchFinto).not.toHaveBeenCalled()
  })
})

describe('🚨 tre esiti, mai due', () => {
  it('success true -> valido', async () => {
    fetchFinto.mockResolvedValue(risposta(200, { data: { success: true } }))

    expect(await verificaFormaleXml('1', 'larealestate')).toEqual({ esito: 'valido' })
  })

  it('gli xml_errors tornano INTERI, uno per riga', async () => {
    fetchFinto.mockResolvedValue(risposta(400, {
      error: {
        message: 'Validation XML',
        validation_result: { xml_errors: ['2.1.6: dovrebbe esserci l\'elemento IdDocumento', 'RegimeFiscale mancante'] },
      },
    }))

    const esito = await verificaFormaleXml('1', 'larealestate')

    expect(esito).toEqual({
      esito: 'errori',
      errori: ['2.1.6: dovrebbe esserci l\'elemento IdDocumento', 'RegimeFiscale mancante'],
    })
  })

  it('anche la forma «lista di stringhe» di validation_result viene letta', async () => {
    // La guida ufficiale mostra `validation_result` come lista; il modello
    // dell'SDK come `{ xml_errors: [...] }`. Si accettano entrambe invece di
    // scegliere quale sia quella vera — e se sbagliassimo a scegliere, gli
    // errori sparirebbero e il documento risulterebbe a posto.
    fetchFinto.mockResolvedValue(risposta(400, { error: { message: 'Validation XML', validation_result: ['manca IdDocumento'] } }))

    expect(await verificaFormaleXml('1', 'larealestate')).toEqual({ esito: 'errori', errori: ['manca IdDocumento'] })
  })

  it('🚨 403 (scope mancante) NON e un XML valido: e un controllo non fatto', async () => {
    fetchFinto.mockResolvedValue(risposta(403, { error: { message: 'insufficient scope' } }))

    const esito = await verificaFormaleXml('1', 'larealestate')

    expect(esito.esito).toBe('non_verificato')
    expect(esito.esito === 'non_verificato' && esito.motivo).toContain('issued_documents.invoices:r')
  })

  it('🚨 500 e rete caduta: non verificato, mai valido', async () => {
    fetchFinto.mockResolvedValue(risposta(500, 'boom'))
    expect((await verificaFormaleXml('1', 'larealestate')).esito).toBe('non_verificato')

    fetchFinto.mockRejectedValue(new Error('ECONNRESET'))
    expect((await verificaFormaleXml('1', 'larealestate')).esito).toBe('non_verificato')
  })

  it('🚨 un 200 che non dice success non vale come valido', async () => {
    fetchFinto.mockResolvedValue(risposta(200, { data: {} }))

    expect((await verificaFormaleXml('1', 'larealestate')).esito).toBe('non_verificato')
  })

  it('success false senza elenco resta un rilievo, non un silenzio', async () => {
    fetchFinto.mockResolvedValue(risposta(200, { data: { success: false } }))

    const esito = await verificaFormaleXml('1', 'larealestate')

    expect(esito.esito).toBe('errori')
  })

  it('un 4xx con solo il messaggio lo riporta come errore del documento', async () => {
    fetchFinto.mockResolvedValue(risposta(422, { error: { message: 'Il documento non e elettronico' } }))

    expect(await verificaFormaleXml('1', 'larealestate')).toEqual({
      esito: 'errori',
      errori: ['Il documento non e elettronico'],
    })
  })

  it('una risposta che non so leggere e «non verificato», non «errori»', async () => {
    // ⚠️ La differenza conta: un corpo illeggibile non prova che il documento
    // sia sbagliato, e dichiararlo tale renderebbe sospetta ogni autofattura
    // per un capriccio dell'API.
    fetchFinto.mockResolvedValue(risposta(418, 'sono una teiera'))

    expect((await verificaFormaleXml('1', 'larealestate')).esito).toBe('non_verificato')
  })
})

describe('la riga che legge l Ingegnere', () => {
  it('su un XML valido lo dice e basta', () => {
    expect(rigaVerificaFormale({ esito: 'valido' })).toContain('XML VALIDO')
  })

  it('su errori li elenca tutti, senza parafrasarli', () => {
    const riga = rigaVerificaFormale({ esito: 'errori', errori: ['manca IdDocumento', 'RegimeFiscale vuoto'] })

    expect(riga).toContain('NON VALIDO')
    expect(riga).toContain('manca IdDocumento')
    expect(riga).toContain('RegimeFiscale vuoto')
  })

  it('🚨 su «non verificato» NON scrive niente che somigli a un via libera', () => {
    const riga = rigaVerificaFormale({ esito: 'non_verificato', motivo: 'HTTP 500' })

    expect(riga).toContain('NON ESEGUITA')
    expect(riga).toContain('NON risulta controllato')
    expect(riga).not.toContain('VALIDO')
  })
})
