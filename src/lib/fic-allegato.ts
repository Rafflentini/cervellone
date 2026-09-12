/**
 * src/lib/fic-allegato.ts — leggere l'ALLEGATO di una fattura RICEVUTA.
 *
 * Task 14, dal fatto di produzione del 12 set 2026: per tre ore il bot ha
 * risposto che sulla fattura non c'era scritta nessuna modalità di pagamento.
 * L'esercente aveva scritto «pagamento contanti». Il bot guardava
 * `payments_list[].payment_account` — il CONTO con cui NOI registriamo il
 * pagamento — e riportava la sua assenza come assenza della
 * `ModalitaPagamento` dell'XML SDI, cioè quello che scrive il FORNITORE.
 * Sono due dati diversi.
 *
 * Ricerca già fatta (v. task-14-brief.md): `ModalitaPagamento` non è esposta
 * da NESSUN campo di `ReceivedDocument` — niente `payment_method`, `ei_data`,
 * `ei_raw`, `notes`. Gli endpoint `e_invoice/xml` esistono solo sotto
 * `issued_documents`. L'unica via è `attachment_url` (temporaneo, readOnly):
 * il file della fattura conservato da Fatture in Cloud.
 *
 * ⚠️ Non verificabile in locale: se per una fattura ricevuta via SDI
 * `attachment_url` punti all'XML originale o a un PDF di cortesia. Il codice
 * gestisce ENTRAMBI i casi e dichiara sempre quale ha trovato nel campo
 * `formato` — la prima chiamata vera in produzione lo dirà.
 */
import { testoDaPdf } from './drive'
import { ficGet, getCompanyId } from './fatture-in-cloud'
import { cercaFattureRicevute, datiFattura, type EsitoFic, type FiltriRicerca } from './fic-pagamenti'
import type { CodiceSocieta } from './societa'

export type EsitoAllegato =
  | { ok: true; formato: 'xml' | 'pdf' | 'altro'; testo: string; modalita_sdi?: string; modalita_leggibile?: string }
  | { ok: false; motivo: 'nessun_allegato' | 'scaricamento' | 'illeggibile'; messaggio: string }

/** Traduzione dei codici `ModalitaPagamento` dell'XML SDI più comuni nelle
 *  fatture ricevute da Restruktura/La Real Estate. Un codice fuori da questa
 *  tabella NON va nascosto: si restituisce grezzo e si dichiara come tale. */
const TABELLA_MODALITA_SDI: Record<string, string> = {
  MP01: 'contanti',
  MP02: 'assegno',
  MP03: 'assegno circolare',
  MP05: 'bonifico',
  MP08: 'carta di pagamento',
  MP12: 'RIBA',
}

const TETTO_BYTE = 10 * 1024 * 1024 // 10 MB
const TIMEOUT_MS = 15_000

function mbLeggibile(byte: number): string {
  return `${(byte / 1024 / 1024).toFixed(1)} MB`
}

/**
 * Scarica l'allegato. `attachment_url` è già firmato/temporaneo: niente
 * token FIC negli header. Un tetto di dimensione e un timeout, e SE scattano
 * lo si dichiara — mai un testo vuoto che si spaccia per "niente da leggere".
 */
async function scaricaAllegato(
  url: string,
): Promise<{ ok: true; buffer: Buffer } | { ok: false; messaggio: string }> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const res = await fetch(url, { signal: controller.signal })
    if (!res.ok) {
      return { ok: false, messaggio: `Download dell'allegato fallito: HTTP ${res.status}.` }
    }
    const lenHeader = res.headers.get('content-length')
    const lenDichiarata = lenHeader ? Number(lenHeader) : undefined
    if (lenDichiarata && lenDichiarata > TETTO_BYTE) {
      return {
        ok: false,
        messaggio: `Allegato troppo grande (${mbLeggibile(lenDichiarata)}, tetto ${mbLeggibile(TETTO_BYTE)}): non scaricato.`,
      }
    }
    const arrayBuffer = await res.arrayBuffer()
    const buffer = Buffer.from(arrayBuffer)
    if (buffer.length > TETTO_BYTE) {
      return {
        ok: false,
        messaggio: `Allegato troppo grande (${mbLeggibile(buffer.length)}, tetto ${mbLeggibile(TETTO_BYTE)}): scaricamento interrotto.`,
      }
    }
    return { ok: true, buffer }
  } catch (err) {
    const isTimeout = err instanceof Error && err.name === 'AbortError'
    if (isTimeout) {
      return { ok: false, messaggio: `Download dell'allegato scaduto oltre ${TIMEOUT_MS / 1000}s.` }
    }
    return { ok: false, messaggio: `Download dell'allegato fallito: ${err instanceof Error ? err.message : String(err)}.` }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Il formato si decide dal CONTENUTO, non dall'estensione dell'URL: un
 * `attachment_url` temporaneo può non avere estensione affidabile.
 */
function rilevaFormato(buffer: Buffer): 'xml' | 'pdf' | 'altro' {
  if (buffer.subarray(0, 4).toString('latin1') === '%PDF') return 'pdf'
  const testo = buffer.toString('utf-8')
  if (/<FatturaElettronica|<ModalitaPagamento/i.test(testo)) return 'xml'
  return 'altro'
}

function leggiXml(testo: string): EsitoAllegato {
  const m = /<ModalitaPagamento>\s*([^<\s]+)\s*<\/ModalitaPagamento>/i.exec(testo)
  if (!m) return { ok: true, formato: 'xml', testo }
  const codice = m[1].trim().toUpperCase()
  const nome = TABELLA_MODALITA_SDI[codice]
  return {
    ok: true,
    formato: 'xml',
    testo,
    modalita_sdi: codice,
    modalita_leggibile: nome ?? `${codice} (codice SDI non in tabella)`,
  }
}

/**
 * Legge l'allegato di una fattura RICEVUTA e ne estrae il testo (XML SDI →
 * anche la `ModalitaPagamento` tradotta; PDF → il testo, così il modello
 * legge «pagamento contanti» dov'è scritto davvero).
 *
 * `societa` è obbligatoria per lo stesso motivo di `ficGet`: un default
 * finirebbe in silenzio sull'account sbagliato.
 */
export async function leggiAllegatoFatturaRicevuta(
  id: number,
  societa: CodiceSocieta,
): Promise<EsitoAllegato> {
  const company = await getCompanyId(societa)
  if (!company.ok) return { ok: false, motivo: 'scaricamento', messaggio: company.error }

  const r = await ficGet(`/c/${company.id}/received_documents/${id}`, { fieldset: 'detailed' }, societa)
  if (!r.ok) return { ok: false, motivo: 'scaricamento', messaggio: r.error }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const dati = (r.data as any)?.data ?? r.data
  const url = typeof dati?.attachment_url === 'string' ? dati.attachment_url.trim() : ''
  if (!url) {
    return {
      ok: false,
      motivo: 'nessun_allegato',
      messaggio:
        `Fatture in Cloud non ha un file allegato per il documento ${id}. `
        + `Chiedi il file (XML o PDF) al fornitore, caricalo su Drive e leggilo con drive_read_pdf `
        + `o drive_read_document — o cerca l'XML SdI ricevuto via mail/PEC.`,
    }
  }

  const scarico = await scaricaAllegato(url)
  if (!scarico.ok) return { ok: false, motivo: 'scaricamento', messaggio: scarico.messaggio }

  const formato = rilevaFormato(scarico.buffer)
  if (formato === 'xml') {
    return leggiXml(scarico.buffer.toString('utf-8'))
  }
  if (formato === 'pdf') {
    const esito = await testoDaPdf(scarico.buffer, `allegato-fattura-ricevuta-${id}.pdf`)
    if (!esito.ok) {
      return { ok: false, motivo: 'illeggibile', messaggio: `Non sono riuscito a estrarre il testo del PDF: ${esito.errore}` }
    }
    return { ok: true, formato: 'pdf', testo: esito.testo }
  }
  // Formato non riconosciuto: si dichiara come tale invece di nasconderlo
  // dietro un errore o un testo vuoto (stessa regola del codice SDI ignoto).
  return { ok: true, formato: 'altro', testo: scarico.buffer.toString('utf-8') }
}

/* ------------------------------------------------------------------ *
 * Task 15 — scremare un INSIEME di fatture per la modalita' scritta
 * dal fornitore. Le parole di Raffaele, 12 set 2026: «se io ti dico di
 * controllare, se c'e', tu devi saperlo fare e dirmelo, in modo da
 * scremare le fatture».
 * ------------------------------------------------------------------ */

/** Una riga del prospetto: cosa ha scritto il fornitore su QUELLA fattura. */
export type ModalitaPerFattura = {
  id: number
  numero: string | null
  data: string | null
  importo: number | null
  /** Il codice SDI grezzo, quando c'e'. */
  codice_sdi: string | null
  /** L'etichetta leggibile, quando il codice e' in tabella. */
  modalita: string | null
  /**
   * TRE esiti distinti, MAI schiacciati in uno:
   *  - 'dichiarata'      → il fornitore l'ha scritta, ed e' in `modalita`
   *  - 'non_dichiarata'  → l'abbiamo letta e il fornitore NON l'ha messa:
   *                        e' un DATO, su cui decide l'Ingegnere
   *  - 'non_leggibile'   → non siamo riusciti a leggere l'allegato (nessun
   *                        allegato compreso): e' un GUASTO, e `perche` lo dice
   *
   * Confondere questi due ultimi esiti e' esattamente cio' che e' costato
   * tre ore il 12 set 2026: il bot diceva «non c'e'» quando il significato
   * vero era «non l'ho guardato».
   */
  esito: 'dichiarata' | 'non_dichiarata' | 'non_leggibile'
  perche?: string
}

/**
 * Tetto di allegati leggibili in una sola chiamata: una rete per fattura, e
 * oltre questo numero si RIFIUTA dichiarandolo invece di leggere solo in
 * parte — un elenco parziale che sembra completo e' il difetto peggiore
 * introducibile in una scrematura.
 */
export const MAX_ALLEGATI = 30

/**
 * Quante letture in volo insieme. Non tutte in parallelo: un burst di 30
 * richieste verso Fatture in Cloud e' un modo di farsi limitare (429).
 */
const DIMENSIONE_GRUPPO = 5

async function leggiRigaModalita(
  doc: Record<string, unknown>,
  societa: CodiceSocieta,
): Promise<ModalitaPerFattura> {
  const dati = datiFattura(doc)
  const base = {
    id: dati.id,
    numero: dati.numero || null,
    data: dati.data || null,
    importo: dati.importo,
  }

  const esito = await leggiAllegatoFatturaRicevuta(dati.id, societa)
  if (!esito.ok) {
    // Nessun allegato, download fallito, PDF illeggibile: sono tutti la
    // STESSA cosa dal punto di vista di questo prospetto — un guasto di
    // lettura, non un dato sul fornitore. `perche` porta il dettaglio.
    return { ...base, codice_sdi: null, modalita: null, esito: 'non_leggibile', perche: esito.messaggio }
  }
  if (esito.modalita_sdi) {
    return { ...base, codice_sdi: esito.modalita_sdi, modalita: esito.modalita_leggibile ?? null, esito: 'dichiarata' }
  }
  // Allegato letto (XML o PDF), ma nessuna ModalitaPagamento trovata dentro:
  // il fornitore non l'ha scritta. Questo E' un dato, non un guasto.
  return { ...base, codice_sdi: null, modalita: null, esito: 'non_dichiarata' }
}

/**
 * Legge la modalita' di pagamento scritta dal fornitore su un elenco di
 * fatture GIA' selezionato (id compresi) — usata sia da
 * `modalitaDichiarateDalFornitore` sotto, sia dal filtro
 * `solo_modalita_fornitore` di `segna_fatture_ricevute_pagate`, che ha gia'
 * la sua selezione in mano e non deve rifare la ricerca da capo.
 */
export async function modalitaPerDocumenti(
  documenti: Record<string, unknown>[],
  societa: CodiceSocieta,
): Promise<EsitoFic<{ righe: ModalitaPerFattura[]; non_leggibili: number }>> {
  if (documenti.length > MAX_ALLEGATI) {
    return {
      ok: false,
      error: `la selezione tocca ${documenti.length} fatture, oltre il tetto di ${MAX_ALLEGATI} allegati leggibili `
        + 'in una volta: restringi la selezione (per fornitore, anno o mese) e ripeti. Non ho letto nessun allegato.',
    }
  }

  const righe: ModalitaPerFattura[] = new Array(documenti.length)
  for (let i = 0; i < documenti.length; i += DIMENSIONE_GRUPPO) {
    const gruppo = documenti.slice(i, i + DIMENSIONE_GRUPPO)
    // eslint-disable-next-line no-await-in-loop
    const esitiGruppo = await Promise.all(gruppo.map((doc) => leggiRigaModalita(doc, societa)))
    esitiGruppo.forEach((riga, indice) => { righe[i + indice] = riga })
  }

  const non_leggibili = righe.filter((r) => r.esito === 'non_leggibile').length
  return { ok: true, valore: { righe, non_leggibili } }
}

/**
 * La funzione sull'INSIEME (Task 15): parte da un filtro (fornitore/anno/mese
 * — Task 13, `cercaFattureRicevute`) e per ognuna delle fatture trovate legge
 * l'allegato (Task 14, `leggiAllegatoFatturaRicevuta`) per sapere cosa ha
 * scritto il fornitore. E' l'operazione che Raffaele chiama «scremare»: si
 * parte da un gruppo e si divide in due (o tre, contando i non leggibili).
 */
export async function modalitaDichiarateDalFornitore(
  filtri: FiltriRicerca,
  societa: CodiceSocieta,
): Promise<EsitoFic<{ righe: ModalitaPerFattura[]; elenco_troncato: boolean; non_leggibili: number }>> {
  const trovate = await cercaFattureRicevute(filtri, societa)
  if (!trovate.ok) return trovate

  const esito = await modalitaPerDocumenti(trovate.valore.documenti, societa)
  if (!esito.ok) return esito

  return { ok: true, valore: { ...esito.valore, elenco_troncato: trovate.valore.elenco_troncato } }
}
