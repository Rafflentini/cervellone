/**
 * src/lib/fic-verifica-formale.ts — la VERIFICA FORMALE di Fatture in Cloud:
 * chiedere a FIC se l'XML dell'e-fattura che abbiamo appena creato passerebbe
 * i controlli del Sistema di Interscambio.
 *
 * 🚨 PERCHE' ESISTE (15 settembre 2026, ed e' la difesa piu' importante della
 * giornata).
 *
 * La mattina del 15 settembre `compila_autofattura` ha creato QUATTRO
 * integrazioni TD17 con dentro degli attributi `2.1.6` sciolti, che rendevano
 * l'XML non valido: blocchi `DatiFattureCollegate` senza `IdDocumento`. Lo SdI
 * le avrebbe scartate tutte e quattro. Il tool, nel frattempo, aveva detto
 * «AUTOFATTURE CREATE: 4 su 4» — perche' erano nate davvero, e la rilettura
 * confermava id e tipo.
 *
 * Il difetto e' stato scoperto dall'Ingegnere aprendo a mano la «Verifica
 * formale» sul gestionale, e riparato a mano su quattro documenti — quegli
 * attributi, una volta scritti via API, dall'interfaccia di FIC non sono ne'
 * modificabili ne' eliminabili: si cancella e si rifa'.
 *
 * Quella verifica **e' un endpoint dell'API**. Chiamarla dopo ogni creazione
 * costa una GET e avrebbe intercettato il difetto PRIMA della riparazione a
 * mano. E' l'unico controllo di questo repo che non guarda i nostri campi uno
 * per uno ma chiede al destinatario se il documento gli va bene.
 *
 * ⛔ **QUI NON SI TRASMETTE NIENTE, E NON PER PROMESSA: PER FORMA.**
 *
 * La trasmissione allo SdI e' un POST, con un corpo, sotto lo stesso ramo
 * `e_invoice` del documento emesso, e ha pure un'opzione per provarla «a
 * vuoto». Quel verbo e quel percorso **non compaiono in questo file**, e i
 * test di `fic-write-tools.elettronica.test.ts` li cercano in tutto `src/lib`
 * e falliscono se ricompaiono — e non si fermano al testo: chiamano questa
 * funzione con un `fetch` finto e guardano il metodo e l'URL VERI che escono.
 *
 * Qui si chiama SOLO
 * `GET /c/{company_id}/issued_documents/{document_id}/e_invoice/xml_verify`,
 * che la documentazione ufficiale (developers.fattureincloud.it, guida
 * «E-Invoice management», e `IssuedEInvoicesApi::verifyEInvoiceXml` negli SDK
 * ufficiali) descrive cosi': «Verifies the e-invoice XML format. Checks if all
 * of the mandatory fields are filled and compliant to the right format».
 * E' una GET, in sola lettura, e chiede lo scope `issued_documents.invoices:r`
 * — il permesso di LEGGERE. Una GET non manda una fattura allo SdI.
 *
 * Il brief indicava come prima strada l'endpoint di INVIO con l'opzione che lo
 * fa girare a vuoto. Questa e' migliore, e la differenza non e' di gusto: li'
 * la sicurezza dipende da un flag che qualcuno un giorno puo' togliere o
 * sbagliare; qui dipende dall'endpoint, che l'invio non lo sa fare.
 *
 * 🚨 TRE ESITI, MAI DUE. Come in `fic-verifica.ts`: `valido`, `errori`, e
 * `non_verificato`. Se la chiamata non si fa — token, scope mancante, rete,
 * 429 — il documento NON e' «verificato»: e' «non l'ho potuto controllare», e
 * chi legge deve saperlo. Un controllo che non si e' potuto fare non e' un
 * controllo passato: e' il difetto di famiglia di questa casa (il guasto che
 * invece di chiudere APRE) e qui lo vieta il tipo.
 */

import { getFicToken, getCompanyId } from './fatture-in-cloud'
import { getSocieta, type CodiceSocieta } from './societa'

const FIC_BASE = 'https://api-v2.fattureincloud.it'

/**
 * Il segmento dell'endpoint di VERIFICA. Sta in una costante sola perche' e'
 * l'unica stringa di questo repo che tocca `e_invoice`, e va potuta leggere in
 * un colpo solo quando qualcuno chiede «ma questo manda?».
 */
const PERCORSO_VERIFICA = 'xml_verify'

export type EsitoVerificaFormale =
  /** Fatture in Cloud dice che l'XML e' valido. */
  | { esito: 'valido' }
  /** Fatture in Cloud elenca cosa non va. `errori` non e' mai vuoto. */
  | { esito: 'errori'; errori: string[] }
  /** La verifica NON si e' potuta fare. Non e' un «va bene». */
  | { esito: 'non_verificato'; motivo: string }

/** Le stringhe di `error.validation_result.xml_errors`, se ci sono. */
function leggiXmlErrors(corpo: unknown): string[] | null {
  if (typeof corpo !== 'object' || corpo === null) return null
  const errore = (corpo as Record<string, unknown>).error
  if (typeof errore !== 'object' || errore === null) return null
  const risultato = (errore as Record<string, unknown>).validation_result
  // `validation_result` e' l'oggetto `{ xml_errors: string[] }` del modello
  // ufficiale, ma la guida ne mostra anche la forma «lista di stringhe»: si
  // accettano entrambe invece di scegliere quale sia quella vera.
  const lista = Array.isArray(risultato)
    ? risultato
    : typeof risultato === 'object' && risultato !== null
      ? (risultato as Record<string, unknown>).xml_errors
      : undefined
  if (!Array.isArray(lista)) return null
  const righe = lista.map((x) => String(x).trim()).filter((x) => x.length > 0)
  return righe.length > 0 ? righe : null
}

/** Il `error.message`, quando c'e'. */
function leggiMessaggio(corpo: unknown): string | null {
  if (typeof corpo !== 'object' || corpo === null) return null
  const errore = (corpo as Record<string, unknown>).error
  if (typeof errore !== 'object' || errore === null) return null
  const messaggio = (errore as Record<string, unknown>).message
  return typeof messaggio === 'string' && messaggio.trim() ? messaggio.trim() : null
}

/**
 * Gli stati HTTP che parlano del NOSTRO accesso, non del documento.
 *
 * ⚠️ Vanno separati sempre: un 401 (token) o un 403 (all'app manca lo scope
 * `issued_documents.invoices:r`) NON dice niente sull'XML. Contarli come
 * «nessun errore trovato» vorrebbe dire dichiarare a norma un documento che
 * non abbiamo guardato — ed e' esattamente il modo in cui una guardia che
 * zittisce comincia a mentire.
 */
function guastoNostro(status: number): boolean {
  return status === 401 || status === 403 || status === 404 || status === 429 || status >= 500
}

/**
 * Chiede a Fatture in Cloud se l'XML del documento EMESSO passa i controlli.
 *
 * Non scrive niente e non trasmette niente: e' una GET.
 */
export async function verificaFormaleXml(
  documentoId: string,
  societa: CodiceSocieta,
): Promise<EsitoVerificaFormale> {
  const s = getSocieta(societa)
  const token = getFicToken(societa)
  if (!token) {
    return { esito: 'non_verificato', motivo: `${s.ficTokenEnv} non configurato (${s.denominazione})` }
  }
  const company = await getCompanyId(societa)
  if (!company.ok) return { esito: 'non_verificato', motivo: company.error }

  const id = String(documentoId || '').trim()
  if (!id) return { esito: 'non_verificato', motivo: 'id documento mancante' }

  const path = `/c/${company.id}/issued_documents/${encodeURIComponent(id)}/e_invoice/${PERCORSO_VERIFICA}`
  console.log(`[FIC] GET ${path}`) // audit (mai loggare il token)

  let res: Response
  let testo: string
  try {
    res = await fetch(FIC_BASE + path, {
      // 🚨 GET, esplicito. Non e' pigrizia del predefinito di `fetch`: chi
      // legge questa riga deve vedere che qui non si POSTa niente.
      method: 'GET',
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    })
    testo = await res.text()
  } catch (err) {
    return {
      esito: 'non_verificato',
      motivo: `la verifica formale non ha risposto (${err instanceof Error ? err.message : String(err)})`,
    }
  }

  let corpo: unknown = null
  try {
    corpo = testo ? JSON.parse(testo) : null
  } catch {
    corpo = null
  }

  if (res.ok) {
    const dati = typeof corpo === 'object' && corpo !== null
      ? (corpo as Record<string, unknown>).data
      : undefined
    const successo = typeof dati === 'object' && dati !== null
      ? (dati as Record<string, unknown>).success
      : undefined
    if (successo === true) return { esito: 'valido' }
    // Anche su 200 gli errori possono viaggiare nel corpo: si guardano prima
    // di concludere qualsiasi cosa.
    const elencati = leggiXmlErrors(corpo)
    if (elencati) return { esito: 'errori', errori: elencati }
    if (successo === false) {
      return {
        esito: 'errori',
        errori: ['Fatture in Cloud dice che l\'XML NON e\' valido, ma non elenca gli errori: aprilo sul gestionale e guarda la Verifica formale.'],
      }
    }
    // ⚠️ 200 senza `success`: non si conclude «valido». Un campo che non si
    // vede non e' un campo buono.
    return {
      esito: 'non_verificato',
      motivo: `Fatture in Cloud ha risposto 200 ma senza dire se l'XML e' valido (${testo.slice(0, 200) || 'corpo vuoto'})`,
    }
  }

  if (guastoNostro(res.status)) {
    const dettaglio = leggiMessaggio(corpo) ?? testo.slice(0, 200)
    return {
      esito: 'non_verificato',
      motivo: res.status === 403
        ? `Fatture in Cloud ha negato la verifica formale (403): all'app manca probabilmente lo scope issued_documents.invoices:r. ${dettaglio}`
        : `la verifica formale non si e' potuta fare (HTTP ${res.status}): ${dettaglio}`,
    }
  }

  const elencati = leggiXmlErrors(corpo)
  if (elencati) return { esito: 'errori', errori: elencati }

  const messaggio = leggiMessaggio(corpo)
  if (messaggio) return { esito: 'errori', errori: [messaggio] }

  return {
    esito: 'non_verificato',
    motivo: `la verifica formale ha risposto HTTP ${res.status} in una forma che non so leggere: ${testo.slice(0, 300) || 'corpo vuoto'}`,
  }
}

/**
 * La riga da mostrare all'Ingegnere accanto a un documento appena creato.
 * Il testo degli errori si riporta INTERO: parafrasarlo vorrebbe dire
 * cancellare proprio la parte che dice quale campo e' sbagliato.
 */
export function rigaVerificaFormale(esito: EsitoVerificaFormale): string {
  if (esito.esito === 'valido') return 'Verifica formale di Fatture in Cloud: XML VALIDO.'
  if (esito.esito === 'errori') {
    return `🚨 Verifica formale di Fatture in Cloud: XML NON VALIDO — ${esito.errori.length} `
      + `error${esito.errori.length === 1 ? 'e' : 'i'}:\n${esito.errori.map((e) => `   · ${e}`).join('\n')}`
  }
  return `⚠️ Verifica formale NON ESEGUITA (${esito.motivo}): il documento NON risulta controllato, `
    + 'aprilo su Fatture in Cloud e lancia la Verifica formale a mano prima di trasmetterlo.'
}
