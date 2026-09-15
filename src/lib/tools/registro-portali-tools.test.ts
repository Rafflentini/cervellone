/**
 * src/lib/tools/registro-portali-tools.test.ts — «a che punto siamo?» e
 * «questa riga dice la verita'?».
 *
 * 🚨 La riconciliazione e' la difesa contro il registro che invecchia male: il
 * registro NON e' la verita', Fatture in Cloud lo e'. Una riga che dice
 * `td17_generata` e punta a un documento cancellato a mano DEVE essere
 * scoperta, e il test che conta piu' di tutti e' quello.
 *
 * ⚠️ Ogni difesa col suo CONTROLLO POSITIVO: un tool che grida sempre
 * «divergenza» passerebbe ogni test sulle guardie ed sarebbe inutile.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

type Riga = Record<string, unknown>

const db = {
  righe: [] as Riga[],
  errore: null as { message: string } | null,
  /** I filtri visti sull'ultima query, per provare che il filtro societa c'e'. */
  filtri: [] as Record<string, unknown>[],
}

const fic = {
  /** path -> risposta. Assente = 404. */
  documenti: new Map<string, Record<string, unknown>>(),
  /** Se valorizzato, ogni GET fallisce cosi' (token, rete): NON e' un 404. */
  guasto: null as string | null,
  letture: [] as string[],
}

vi.mock('@/lib/supabase', () => {
  const costruisci = () => {
    const filtri: Record<string, unknown> = {}
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const b: any = {}
    b.select = () => b
    b.eq = (k: string, v: unknown) => { filtri[k] = v; return b }
    b.gte = () => b
    b.lt = () => b
    b.order = () => b
    b.limit = () => b
    const risolvi = () => {
      db.filtri.push({ ...filtri })
      if (db.errore) return { data: null, error: db.errore }
      const chiave = (n: unknown) => String(n ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '')
      const righe = db.righe.filter((r) =>
        Object.entries(filtri).every(([k, v]) => (k === 'numero_chiave' ? chiave(r.numero_fattura) === v : r[k] === v)))
      return { data: righe, error: null }
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    b.then = (ok: any, no: any) => Promise.resolve(risolvi()).then(ok, no)
    return b
  }
  return { supabase: { from: () => costruisci() } }
})

vi.mock('@/lib/fatture-in-cloud', () => ({
  getCompanyId: async () => ({ ok: true, id: '1614746' }),
  ficGet: async (path: string) => {
    fic.letture.push(path)
    if (fic.guasto) return { ok: false, error: fic.guasto }
    const doc = fic.documenti.get(path)
    if (!doc) return { ok: false, error: 'Errore FIC 404: not found' }
    return { ok: true, data: { data: doc } }
  },
  // Non usati da questo file ma importati da fic-write-tools.
  ficPost: async () => ({ ok: false, error: 'non previsto nel test' }),
  ficPut: async () => ({ ok: false, error: 'non previsto nel test' }),
  creaDocumentoFIC: async () => ({ ok: false, error: 'non previsto nel test' }),
  eliminaDocumentoFIC: async () => ({ ok: false, error: 'non previsto nel test' }),
  caricaAllegatoFIC: async () => ({ ok: false, error: 'non previsto nel test' }),
  creaSpesaFIC: async () => ({ ok: false, error: 'non previsto nel test' }),
  getFicToken: () => 'tok',
  aggiungiGiorniISO: (d: string) => d,
  GIORNI_SCADENZA_FIC: 30,
  FORMATI_ALLEGATO_FIC: ['pdf'],
  FIC_READ_TOOLS: [],
  executeFicTool: async () => null,
}))

import { situazioneRegistro, riconciliaRegistro } from './registro-portali-tools'

const RIGA_BASE = {
  id: 'riga-1',
  societa: 'larealestate',
  portale: 'booking',
  struttura: 'Blue Maison',
  numero_fattura: '2568745896',
  data_fattura: '2026-08-01',
  data_ricezione: '2026-08-03',
  imponibile: 218.44,
  iva: 48.06,
  regime: 'RC',
  stato: 'spesa_registrata',
  spesa_fic_id: '435116342',
  td17_fic_id: null,
  td17_numero: null,
  stato_sdi: null,
  scadenza_invio: '2026-09-15',
  note: null,
}

const SPESA_SU_FIC = {
  id: '435116342',
  type: 'expense',
  invoice_number: '2568745896',
  amount_net: 218.44,
}

beforeEach(() => {
  db.righe = []
  db.errore = null
  db.filtri = []
  fic.documenti = new Map()
  fic.guasto = null
  fic.letture = []
})

describe('registro_portali_situazione — a che punto siamo', () => {
  it('conta le righe per stato e nomina quelle IN RITARDO', async () => {
    db.righe = [
      { ...RIGA_BASE, id: 'r1', numero_fattura: 'A1', scadenza_invio: '2026-09-15', stato: 'spesa_registrata' },
      { ...RIGA_BASE, id: 'r2', numero_fattura: 'A2', scadenza_invio: '2026-08-15', stato: 'spesa_registrata' },
      { ...RIGA_BASE, id: 'r3', numero_fattura: 'A3', scadenza_invio: '2026-08-15', stato: 'sdi_consegnata' },
    ]
    const testo = await situazioneRegistro({}, 'larealestate', '2026-09-20')

    expect(testo).toContain('3 fatture')
    expect(testo).toContain('spesa_registrata: 2')
    expect(testo).toContain('sdi_consegnata: 1')
    expect(testo).toContain('IN RITARDO (2)')
    expect(testo).toContain('n.A1')
    expect(testo).toContain('n.A2')
    // 🚨 Quella gia' consegnata allo SdI NON e' in ritardo: e' stata spedita.
    expect(testo).not.toContain('n.A3 del')
  })

  it('CONTROLLO POSITIVO — con la scadenza ancora lontana nessuna e in ritardo', async () => {
    // Senza questo, un tool che dichiara «in ritardo» qualunque riga
    // passerebbe il test sopra.
    db.righe = [{ ...RIGA_BASE, scadenza_invio: '2026-12-15' }]
    const testo = await situazioneRegistro({}, 'larealestate', '2026-09-20')
    expect(testo).not.toContain('IN RITARDO')
    expect(testo).not.toContain('IN SCADENZA')
  })

  it('🚨 una riga senza data di ricezione si DICE: non ha scadenza calcolabile', async () => {
    db.righe = [{ ...RIGA_BASE, data_ricezione: null, scadenza_invio: null }]
    const testo = await situazioneRegistro({}, 'larealestate', '2026-09-20')
    expect(testo).toContain('SENZA SCADENZA CALCOLABILE (1)')
    expect(testo).toContain('manca la data di ricezione')
  })

  it('le da_verificare compaiono col MOTIVO, non solo col conteggio', async () => {
    db.righe = [{
      ...RIGA_BASE,
      stato: 'da_verificare',
      note: '[2026-09-15] integrazione TD17 NON confermata dalla rilettura: 404. Id 552625594.',
    }]
    const testo = await situazioneRegistro({}, 'larealestate', '2026-09-20')
    expect(testo).toContain('DA VERIFICARE (1)')
    expect(testo).toContain('552625594')
  })

  it('🚨 un registro che non si legge NON diventa un registro vuoto', async () => {
    db.errore = { message: 'timeout' }
    const testo = await situazioneRegistro({}, 'larealestate', '2026-09-20')
    expect(testo).toContain('NON sono riuscito a leggere')
    expect(testo).not.toContain('NESSUNA riga')
  })

  it('CONTROLLO POSITIVO — un registro leggibile e davvero vuoto lo dice diversamente', async () => {
    const testo = await situazioneRegistro({}, 'larealestate', '2026-09-20')
    expect(testo).toContain('NESSUNA riga')
    expect(testo).not.toContain('NON sono riuscito a leggere')
  })

  it('legge SOLO la societa della conversazione', async () => {
    db.righe = [{ ...RIGA_BASE }]
    await situazioneRegistro({}, 'restruktura', '2026-09-20')
    expect(db.filtri.at(-1)).toMatchObject({ societa: 'restruktura' })
  })

  it('un mese scritto male si rifiuta, e non si legge niente', async () => {
    const testo = await situazioneRegistro({ mese: 'agosto' }, 'larealestate', '2026-09-20')
    expect(testo).toContain('YYYY-MM')
    expect(db.filtri).toHaveLength(0)
  })
})

describe('registro_portali_riconcilia — il registro non e la verita', () => {
  it('🚨 scopre il documento SPARITO da Fatture in Cloud (cancellato a mano)', async () => {
    db.righe = [{ ...RIGA_BASE, stato: 'td17_generata', td17_fic_id: '552625594' }]
    fic.documenti.set('/c/1614746/received_documents/435116342', SPESA_SU_FIC)
    // L'integrazione NON c'e': 404.
    const testo = await riconciliaRegistro({ numero: '2568745896' }, 'larealestate')

    expect(testo).toContain("NON C'E' PIU'")
    expect(testo).toContain('552625594')
    expect(testo).toContain('DIVERGENZE')
    expect(testo).toContain('Non ho scritto niente')
  })

  it('CONTROLLO POSITIVO — con tutti e due i documenti al loro posto, COMBACIANO', async () => {
    db.righe = [{ ...RIGA_BASE, stato: 'td17_generata', td17_fic_id: '552625594' }]
    fic.documenti.set('/c/1614746/received_documents/435116342', SPESA_SU_FIC)
    fic.documenti.set('/c/1614746/issued_documents/552625594', {
      id: '552625594', type: 'self_supplier_invoice', number: 1, numeration: 'INT', ei_data: { status: 'sent' },
    })
    const testo = await riconciliaRegistro({ numero: '2568745896' }, 'larealestate')

    expect(testo).toContain('COMBACIANO')
    expect(testo).not.toContain('DIVERGENZE')
    // Lo stato SdI letto su FIC si riporta: e' il fatto che il registro non ha.
    expect(testo).toContain('«sent»')
  })

  it('🚨 «non riesco a leggerlo» NON e «non c e piu»', async () => {
    // Un token scaduto farebbe dichiarare cancellati tutti i documenti
    // dell'anno: il guasto che invece di chiudere APRE.
    db.righe = [{ ...RIGA_BASE, stato: 'td17_generata', td17_fic_id: '552625594' }]
    fic.guasto = 'Token FIC non valido/revocato: rigeneralo nelle Applicazioni collegate.'
    const testo = await riconciliaRegistro({ numero: '2568745896' }, 'larealestate')

    expect(testo).toContain('non sono riuscito a leggerla')
    expect(testo).not.toContain("NON C'E' PIU'")
    expect(testo).toContain('COMBACIANO su tutto quello che ho potuto leggere')
  })

  it('🚨 uno stato che promette un documento di cui la riga non porta l id e una divergenza', async () => {
    db.righe = [{ ...RIGA_BASE, stato: 'td17_generata', td17_fic_id: null }]
    fic.documenti.set('/c/1614746/received_documents/435116342', SPESA_SU_FIC)
    const testo = await riconciliaRegistro({ numero: '2568745896' }, 'larealestate')
    expect(testo).toContain('non porta nessun id dell\'integrazione TD17')
    expect(testo).toContain('DIVERGENZE')
  })

  it('un imponibile diverso da quello di FIC si dichiara', async () => {
    db.righe = [{ ...RIGA_BASE }]
    fic.documenti.set('/c/1614746/received_documents/435116342', { ...SPESA_SU_FIC, amount_net: 300 })
    const testo = await riconciliaRegistro({ numero: '2568745896' }, 'larealestate')
    expect(testo).toContain("l'imponibile e' 300,00 €")
    expect(testo).toContain('DIVERGENZE')
  })

  it('il numero si confronta NORMALIZZATO, e si trova la riga anche scrivendolo con la punteggiatura', async () => {
    db.righe = [{ ...RIGA_BASE }]
    fic.documenti.set('/c/1614746/received_documents/435116342', SPESA_SU_FIC)
    const testo = await riconciliaRegistro({ numero: '2568-745-896' }, 'larealestate')
    expect(testo).toContain('COMBACIANO')
  })

  it('senza numero ne id non legge niente e lo dice', async () => {
    const testo = await riconciliaRegistro({}, 'larealestate')
    expect(testo).toContain('Serve `numero`')
    expect(db.filtri).toHaveLength(0)
  })

  it('una fattura che il registro non conosce non si spaccia per «documento inesistente»', async () => {
    const testo = await riconciliaRegistro({ numero: 'MAI-VISTA' }, 'larealestate')
    expect(testo).toContain('non c\'e\' nessuna riga')
    expect(testo).toContain('Non vuol dire che il documento non esista')
  })
})
