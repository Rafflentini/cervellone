/**
 * Task 15 — scremare un GRUPPO di fatture per la modalita' che ha scritto il
 * fornitore, distinguendo 'non l'ha messa' da 'non l'ho letta'.
 *
 * Le parole di Raffaele (12 set 2026): «se io ti dico di controllare, se c'e',
 * tu devi saperlo fare e dirmelo, in modo da scremare le fatture». Il Task 14
 * legge UNA fattura per chiamata; qui si cammina sull'INSIEME (Task 13:
 * `cercaFattureRicevute`) e si legge l'allegato di ognuna (Task 14:
 * `leggiAllegatoFatturaRicevuta`), a gruppi di 5, con un tetto di 30.
 *
 * ⭐ Il punto di tutto il task: `non_dichiarata` (letta, il fornitore non l'ha
 * scritta: un DATO) e `non_leggibile` (non sono riuscito a leggere l'allegato:
 * un GUASTO) sono due esiti diversi. Confonderli e' esattamente il difetto che
 * e' costato tre ore il 12 set 2026.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// pdf-parse non va mai invocato per davvero: qui non si esercita nessun
// percorso PDF, ma drive.ts lo importa a livello di modulo.
vi.mock('pdf-parse', () => ({
  PDFParse: class {
    async getText() { return { text: 'pagamento contanti', numpages: 1 } }
    async destroy() {}
  },
}))

const { risultatoRicerca } = vi.hoisted(() => ({
  risultatoRicerca: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    current: null as any,
  },
}))

// Si sostituisce SOLO `cercaFattureRicevute` (Task 13): tutto il resto del
// modulo (datiFattura, EsitoFic, FiltriRicerca...) resta quello vero, quindi
// si fa lo spread di `importOriginal` invece di dare il minimo indispensabile.
vi.mock('./fic-pagamenti', async (importOriginal) => {
  const reale = await importOriginal<typeof import('./fic-pagamenti')>()
  return {
    ...reale,
    cercaFattureRicevute: async () => risultatoRicerca.current,
  }
})

import { modalitaDichiarateDalFornitore, modalitaPerDocumenti, MAX_ALLEGATI } from './fic-allegato'

/* ---------- fetch finto, che instrada per id estratto dall'URL ---------- */

interface ConfigAllegato {
  attachmentUrl?: string
  attachmentBuffer?: string | Buffer
  attachmentStatus?: number
  dettaglioStatus?: number
}

const configPerId = new Map<number, ConfigAllegato>()
let inVolo = 0
let massimoInVolo = 0

function rispostaJson(body: unknown, status = 200): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: () => null },
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response
}

function rispostaBinaria(contenuto: string | Buffer, status = 200): Response {
  const buf = Buffer.isBuffer(contenuto) ? contenuto : Buffer.from(contenuto, 'utf-8')
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: () => null },
    arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
    text: async () => buf.toString('utf-8'),
  } as unknown as Response
}

async function fetchRouter(url: string): Promise<Response> {
  const mDett = /received_documents\/(\d+)/.exec(url)
  if (mDett) {
    const id = Number(mDett[1])
    const cfg = configPerId.get(id) ?? {}
    if (cfg.dettaglioStatus && cfg.dettaglioStatus !== 200) return rispostaJson({}, cfg.dettaglioStatus)
    return rispostaJson({ data: { id, attachment_url: cfg.attachmentUrl } })
  }
  const mAtt = /alleg-(\d+)/.exec(url)
  const id = mAtt ? Number(mAtt[1]) : -1
  const cfg = configPerId.get(id) ?? {}
  if (cfg.attachmentStatus && cfg.attachmentStatus !== 200) return rispostaBinaria('', cfg.attachmentStatus)
  return rispostaBinaria(cfg.attachmentBuffer ?? '')
}

const fetchFinto = vi.fn(async (url: string) => {
  inVolo++
  massimoInVolo = Math.max(massimoInVolo, inVolo)
  // Un piccolo ritardo reale: senza di esso non c'e' modo di osservare
  // sovrapposizione fra chiamate concorrenti.
  await new Promise((r) => setTimeout(r, 3))
  const risposta = await fetchRouter(url)
  inVolo--
  return risposta
})

const AMBIENTE_ORIGINALE = { ...process.env }

beforeEach(() => {
  configPerId.clear()
  inVolo = 0
  massimoInVolo = 0
  fetchFinto.mockClear()
  vi.stubGlobal('fetch', fetchFinto)
  process.env.FIC_COMPANY_ID = '111'
  process.env.FIC_ACCESS_TOKEN = 'token-restruktura'
  risultatoRicerca.current = null
})
afterEach(() => {
  process.env = { ...AMBIENTE_ORIGINALE }
  vi.unstubAllGlobals()
})

/* ---------- fixture ---------- */

function documento(id: number, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    type: 'expense',
    entity: { id: 5, name: 'EDIL LIMONGI SRL' },
    invoice_number: `n${id}`,
    date: '2026-03-04',
    amount_gross: 122,
    ...over,
  }
}

const XML_MP01 = `<?xml version="1.0" encoding="UTF-8"?>
<p:FatturaElettronica versione="FPR12">
  <FatturaElettronicaBody>
    <DatiPagamento>
      <DettaglioPagamento>
        <ModalitaPagamento>MP01</ModalitaPagamento>
        <ImportoPagamento>122.00</ImportoPagamento>
      </DettaglioPagamento>
    </DatiPagamento>
  </FatturaElettronicaBody>
</p:FatturaElettronica>`

const XML_SENZA_MODALITA = `<?xml version="1.0" encoding="UTF-8"?>
<p:FatturaElettronica versione="FPR12">
  <FatturaElettronicaBody>
    <DatiGenerali></DatiGenerali>
  </FatturaElettronicaBody>
</p:FatturaElettronica>`

/* ---------- i tre esiti ---------- */

describe('modalitaDichiarateDalFornitore: i TRE esiti, mai confusi', () => {
  beforeEach(() => {
    risultatoRicerca.current = {
      ok: true,
      valore: { documenti: [documento(1), documento(2), documento(3)], elenco_troncato: false, pagine_lette: 1 },
    }
    configPerId.set(1, { attachmentUrl: 'https://files.test/alleg-1.xml', attachmentBuffer: XML_MP01 })
    configPerId.set(2, { attachmentUrl: 'https://files.test/alleg-2.xml', attachmentBuffer: XML_SENZA_MODALITA })
    configPerId.set(3, { attachmentUrl: 'https://files.test/alleg-3.xml', attachmentStatus: 404 })
  })

  it('CONTROLLO POSITIVO — distingue i TRE esiti sulla stessa selezione', async () => {
    const esito = await modalitaDichiarateDalFornitore({ fornitore: 'Limongi', anno: 2026 }, 'restruktura')
    expect(esito.ok).toBe(true)
    if (!esito.ok) return
    const { righe } = esito.valore
    expect(righe.map((r) => r.esito)).toEqual(['dichiarata', 'non_dichiarata', 'non_leggibile'])
    expect(righe[0].modalita).toBe('contanti')
    expect(righe[0].codice_sdi).toBe('MP01')
    expect(righe[1].modalita).toBeNull() // non dichiarata: un dato, non un guasto
    expect(righe[2].perche).toBeTruthy() // non leggibile: il perche' si DICE
  })

  it('il conteggio dei non leggibili e separato, non sommato ai non dichiarati', async () => {
    const esito = await modalitaDichiarateDalFornitore({ fornitore: 'Limongi', anno: 2026 }, 'restruktura')
    expect(esito.ok).toBe(true)
    if (esito.ok) expect(esito.valore.non_leggibili).toBe(1)
  })
})

describe('non_leggibile copre anche la fattura senza nessun allegato', () => {
  it('senza allegato e non_leggibile (un guasto), non non_dichiarata (un dato)', async () => {
    risultatoRicerca.current = {
      ok: true,
      valore: { documenti: [documento(9)], elenco_troncato: false, pagine_lette: 1 },
    }
    // nessuna config per l'id 9: il dettaglio torna senza attachment_url
    const esito = await modalitaDichiarateDalFornitore({ anno: 2026 }, 'restruktura')
    expect(esito.ok).toBe(true)
    if (!esito.ok) return
    expect(esito.valore.righe[0].esito).toBe('non_leggibile')
    expect(esito.valore.righe[0].perche).toBeTruthy()
  })
})

describe('elenco_troncato viene dalla ricerca (Task 13), non deciso qui', () => {
  it('si propaga cosi com e', async () => {
    risultatoRicerca.current = {
      ok: true,
      valore: { documenti: [documento(1)], elenco_troncato: true, pagine_lette: 10 },
    }
    configPerId.set(1, { attachmentUrl: 'https://files.test/alleg-1.xml', attachmentBuffer: XML_MP01 })
    const esito = await modalitaDichiarateDalFornitore({ anno: 2026 }, 'restruktura')
    expect(esito.ok).toBe(true)
    if (esito.ok) expect(esito.valore.elenco_troncato).toBe(true)
  })
})

describe('se la ricerca fallisce, l errore si propaga senza leggere niente', () => {
  it('nessuna chiamata di lettura allegato viene fatta', async () => {
    risultatoRicerca.current = { ok: false, error: 'boom' }
    const esito = await modalitaDichiarateDalFornitore({ anno: 2026 }, 'restruktura')
    expect(esito.ok).toBe(false)
    if (esito.ok) return
    expect(esito.error).toBe('boom')
    expect(fetchFinto).not.toHaveBeenCalled()
  })
})

/* ---------- il tetto ---------- */

describe('MAX_ALLEGATI: una scrematura non legge a meta', () => {
  it('oltre il tetto di allegati rifiuta dichiarandolo, non legge a meta', async () => {
    risultatoRicerca.current = {
      ok: true,
      valore: {
        documenti: Array.from({ length: MAX_ALLEGATI + 1 }, (_, i) => documento(1000 + i)),
        elenco_troncato: false,
        pagine_lette: 1,
      },
    }
    const esito = await modalitaDichiarateDalFornitore({ fornitore: 'Limongi', anno: 2026 }, 'restruktura')
    expect(esito.ok).toBe(false)
    if (esito.ok) return
    expect(esito.error).toContain(String(MAX_ALLEGATI + 1))
    expect(esito.error).toContain(String(MAX_ALLEGATI))
    // La prova che conta: non ha letto NIENTE, non una parte.
    expect(fetchFinto).not.toHaveBeenCalled()
  })

  // Controllo positivo: esattamente al tetto, passa. Senza questo il test
  // sopra sarebbe verde anche con un tetto rotto che rifiuta sempre.
  it('esattamente al tetto, legge tutto', async () => {
    risultatoRicerca.current = {
      ok: true,
      valore: {
        documenti: Array.from({ length: MAX_ALLEGATI }, (_, i) => documento(2000 + i)),
        elenco_troncato: false,
        pagine_lette: 1,
      },
    }
    for (let i = 0; i < MAX_ALLEGATI; i++) {
      configPerId.set(2000 + i, { attachmentUrl: `https://files.test/alleg-${2000 + i}.xml`, attachmentBuffer: XML_MP01 })
    }
    const esito = await modalitaDichiarateDalFornitore({ fornitore: 'Limongi', anno: 2026 }, 'restruktura')
    expect(esito.ok).toBe(true)
    if (esito.ok) expect(esito.valore.righe).toHaveLength(MAX_ALLEGATI)
  })
})

/* ---------- i gruppi di 5 ---------- */

describe('le letture vanno a gruppi, non tutte insieme', () => {
  it('mai piu di 5 chiamate in volo, ma davvero in parallelo dentro il gruppo', async () => {
    const N = 12
    risultatoRicerca.current = {
      ok: true,
      valore: { documenti: Array.from({ length: N }, (_, i) => documento(3000 + i)), elenco_troncato: false, pagine_lette: 1 },
    }
    for (let i = 0; i < N; i++) {
      configPerId.set(3000 + i, { attachmentUrl: `https://files.test/alleg-${3000 + i}.xml`, attachmentBuffer: XML_MP01 })
    }
    const esito = await modalitaDichiarateDalFornitore({ fornitore: 'Limongi', anno: 2026 }, 'restruktura')
    expect(esito.ok).toBe(true)
    expect(massimoInVolo).toBeLessThanOrEqual(5)
    // Prova che non sia seriale (un burst di 30 e' vietato, ma anche uno alla
    // volta violerebbe "a gruppi").
    expect(massimoInVolo).toBeGreaterThan(1)
  })
})

/* ---------- modalitaPerDocumenti: la stessa lettura su un elenco gia in mano ---------- */

describe('modalitaPerDocumenti: la stessa lettura, senza dover ricercare', () => {
  it('legge gli esiti su una lista di documenti gia fornita (usata dal filtro di segna_fatture_ricevute_pagate)', async () => {
    configPerId.set(1, { attachmentUrl: 'https://files.test/alleg-1.xml', attachmentBuffer: XML_MP01 })
    const esito = await modalitaPerDocumenti([documento(1)], 'restruktura')
    expect(esito.ok).toBe(true)
    if (esito.ok) {
      expect(esito.valore.righe[0].esito).toBe('dichiarata')
      expect(esito.valore.non_leggibili).toBe(0)
    }
  })

  it('oltre il tetto rifiuta anche qui, senza leggere niente', async () => {
    const tanti = Array.from({ length: MAX_ALLEGATI + 1 }, (_, i) => documento(i))
    const esito = await modalitaPerDocumenti(tanti, 'restruktura')
    expect(esito.ok).toBe(false)
    expect(fetchFinto).not.toHaveBeenCalled()
  })
})
