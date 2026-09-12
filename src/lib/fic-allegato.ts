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
