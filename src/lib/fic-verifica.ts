/**
 * src/lib/fic-verifica.ts — VERIFICARE un documento gia' compilato su Fatture
 * in Cloud: dire cosa non va, regola per regola.
 *
 * PERCHE' ESISTE (15 settembre 2026). Il bot sapeva CREARE un'autofattura TD17
 * e una spesa di fornitore estero, e da poco sapeva MODIFICARLE. Non sapeva
 * GUARDARLE. Le parole dell'Ingegnere: «fai in modo che se gli chiedo di
 * verificare una spesa o autofattura gia' compilata sappia rilevare cosa e'
 * sbagliato e correggere».
 *
 * Il caso vero: un documento nato mesi fa, o nato da un tool che allora
 * sbagliava (le prime integrazioni sono uscite con `Codice destinatario
 * XXXXXXX`, che e' quello dei destinatari ESTERI, e con un piano pagamenti
 * `not_paid` che le faceva comparire nello scadenzario come da sollecitare al
 * fornitore estero). Nessuno se ne accorge guardando il PDF: si vede solo
 * aprendo i campi uno per uno, che e' esattamente quello che questo file fa.
 *
 * 🚨 TRE COSE CHE NON SI NEGOZIANO, e che spiegano la forma del file.
 *
 * 1. **Verificare e' LEGGERE.** Qui dentro non c'e' una sola scrittura. La
 *    verifica si puo' chiamare senza conferma perche' non puo' fare danni; la
 *    correzione e' un altro atto, passa da `modifica_documento_fic` e dalla
 *    conferma di casa. Sono due verbi diversi e restano separati.
 *
 * 2. **Un controllo che non si e' potuto fare NON e' un controllo passato.**
 *    Ogni regola ha TRE esiti, non due: `a_norma`, `rilievo`, e
 *    `non_verificato`. Se `ei_raw` non si legge, il TD17 non e' «a posto»: e'
 *    «non l'ho visto». E' il difetto peggiore che questo progetto conosce — un
 *    guasto travestito da esito buono — e qui il tipo lo vieta.
 *
 * 3. **L'esito e' un ELENCO PER REGOLA**, non un «tutto ok» e nemmeno un «ci
 *    sono problemi». Ogni voce dice: cosa pretende la regola, cosa c'e'
 *    DAVVERO sul documento, e se si corregge via API si' o no. Un riassunto
 *    che non porta il dettaglio non e' una verifica, e' un'opinione.
 *
 * ⬜ QUELLO CHE NON SI PUO' VERIFICARE, E CHE VA DETTO INVECE DI TACERE. Le due
 * RILEVAZIONI contabili — «Rileva ricavo» sull'autofattura e «Rileva IVA a
 * debito» sulla spesa — non stanno nel modello ufficiale dell'SDK
 * (`IssuedDocument`, `IssuedDocumentEiData`): cercate, non ci sono. Quindi non
 * si leggono e non si correggono da qui. Il tool le ELENCA come «da
 * controllare a mano su Fatture in Cloud», con scritto cosa succede se sono
 * sbagliate — perche' un controllo che il tool non fa e di cui non parla e'
 * un controllo che non fa nessuno.
 *
 * FONTI DELLE REGOLE. Non sono opinioni: vengono dalla specifica funzionale
 * Rev.02 dell'Ingegnere (guida ufficiale Fatture in Cloud «Registra documento
 * estero o reverse charge interno e relativa autofattura») e dall'XML di una
 * TD17 vera e valida (integrazione di una fattura Dropbox Irlanda).
 */

import { leggiDocumentoEmesso, documentoModificabile, datiDocumento } from './fic-modifica'
import { leggiFatturaRicevuta, type EsitoFic } from './fic-pagamenti'
import { getSocieta, type CodiceSocieta } from './societa'

/**
 * 🚨 Il codice TD17 NON sta nel campo `type`: sta in `ei_raw`.
 *
 * `type` sceglie la FORMA del documento su Fatture in Cloud; il tipo documento
 * dell'XML SdI e' un'altra cosa, e senza questa struttura il documento non e'
 * un'integrazione TD17 — e' una normale autofattura, corretta in apparenza e
 * sbagliata nella sostanza. Era il punto su cui questo lavoro poteva essere
 * silenziosamente sbagliato (documentazione ufficiale FIC, FAQ sviluppatori).
 *
 * TD17 = integrazione/autofattura per acquisto di servizi dall'estero,
 * art. 17 c.2 DPR 633/72, servizio generico ex art. 7-ter.
 *
 * ⚠️ Sta QUI, e non accanto al codice che crea le autofatture, perche' chi
 * CREA e chi VERIFICA devono leggere lo stesso valore dallo stesso posto: due
 * costanti uguali in due file sono due costanti che un giorno divergono, e il
 * giorno in cui divergono la verifica dice «a norma» a un documento sbagliato.
 */
export const TIPO_DOCUMENTO_SDI = 'TD17'

/**
 * Codice destinatario SdI dell'integrazione: e' il NOSTRO, non quello del
 * fornitore estero.
 *
 * Fatture in Cloud lo ricava dall'anagrafica della controparte, che su una
 * TD17 e' il fornitore estero: non avendo un codice SdI, FIC ripiega su
 * `XXXXXXX`, riservato ai destinatari ESTERI. Ma un'integrazione torna a noi.
 *
 * Letto da DUE fonti il 15 settembre 2026 — l'integrazione TD17 valida
 * dell'Ingegnere e il form di FIC che lo prefilla per La Real Estate — e poi
 * VERIFICATO sull'anteprima elettronica del documento generato da qui.
 */
export const CODICE_DESTINATARIO_INTEGRAZIONE = 'M5UXCR1'

/** Il codice che FIC mette quando la controparte non ha un codice SdI: gli ESTERI. */
export const CODICE_DESTINATARIO_ESTERI = 'XXXXXXX'

/** Lo stato che, su una voce del piano pagamenti, significa «stornato». */
export const STATO_STORNATO = 'reversed'

/** Lo stato che, su una voce del piano pagamenti, significa «saldata». */
export const STATO_SALDATO = 'paid'

/**
 * I tre esiti di una regola. `non_verificato` non e' un dettaglio di comodo:
 * e' il terzo stato che impedisce a un guasto di lettura di travestirsi da
 * esito buono.
 */
export type EsitoRegola = 'a_norma' | 'rilievo' | 'non_verificato'

/**
 * Quanto pesa un rilievo. `grave` = il documento non assolve l'adempimento per
 * cui e' nato; `importante` = e' formalmente sbagliato o produce un effetto
 * secondario indesiderato (una scadenza finta, un sollecito a un fornitore
 * estero); `avviso` = va sistemato ma non cambia la sostanza.
 */
export type Gravita = 'grave' | 'importante' | 'avviso'

/** La correzione PROPOSTA: la chiamata da fare, non una scrittura fatta. */
export interface CorrezioneProposta {
  /** Il tool che la esegue. Passa comunque dalla conferma: qui si propone e basta. */
  tool: string
  /** I parametri gia' pronti, quando li sappiamo TUTTI. */
  parametri: Record<string, unknown>
  /** Cosa manca perche' la chiamata sia completa, quando manca qualcosa. */
  serve_da_te: string | null
}

/** L'esito di UNA regola: cosa pretende, cosa c'e', si corregge o no. */
export interface EsitoControllo {
  /** Chiave breve e stabile della regola. */
  regola: string
  /** Cosa pretende la regola, in italiano. */
  dice: string
  /** Cosa c'e' DAVVERO sul documento. Mai una parafrasi: il valore letto. */
  trovato: string
  esito: EsitoRegola
  /** Valorizzata solo sui rilievi. */
  gravita: Gravita | null
  /** Cosa succede se resta cosi'. Valorizzato sui rilievi. */
  conseguenza: string | null
  correggibile_via_api: boolean
  /** Come si corregge — o perche' via API non si puo'. */
  come: string | null
  correzione: CorrezioneProposta | null
}

/** Una cosa che il tool NON puo' leggere e che quindi va guardata a mano. */
export interface DaControllareAMano {
  voce: string
  deve_essere: string
  se_sbagliato: string
  perche_non_via_api: string
}

export type TipoVerifica = 'autofattura' | 'spesa'

export interface EsitoVerifica {
  tipo: TipoVerifica
  documento: {
    id: number
    tipo: string
    numero: string
    data: string
    controparte: string
    totale: number
  }
  controlli: EsitoControllo[]
  /** Se il documento e' trasmesso: il motivo per cui NESSUNA correzione parte. */
  correzione_bloccata: string | null
  da_controllare_a_mano: DaControllareAMano[]
}

// ————————————————————————————————————————————————————————————————————————
// Letture grezze. `undefined` vuol dire «non l'ho visto», MAI «non c'e'».
// ————————————————————————————————————————————————————————————————————————

function oggetto(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {}
}

function testo(v: unknown): string {
  return typeof v === 'string' ? v.trim() : v === null || v === undefined ? '' : String(v)
}

function numero(v: unknown): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v.trim()) : NaN
  return Number.isFinite(n) ? n : null
}

function arrotonda(n: number): number {
  return Math.round(n * 100) / 100
}

/** Le voci del piano pagamenti, o `undefined` se `payments_list` non e' una lista. */
function pianoPagamenti(doc: Record<string, unknown>): Record<string, unknown>[] | undefined {
  return Array.isArray(doc.payments_list) ? doc.payments_list.map(oggetto) : undefined
}

/**
 * Il blocco `DatiGenerali` dell'XML SdI, o `undefined` se `ei_raw` non e'
 * leggibile.
 *
 * ⚠️ La distinzione che regge due regole: `ei_raw` ASSENTE vuol dire che la
 * rilettura non ce l'ha data, e allora non sappiamo niente del TD17 ne' della
 * fattura collegata (→ `non_verificato`). `ei_raw` PRESENTE ma senza il pezzo
 * che cerchiamo vuol dire che il pezzo sul documento non c'e' (→ rilievo).
 */
function datiGeneraliSdi(doc: Record<string, unknown>): Record<string, unknown> | undefined {
  const raw = doc.ei_raw
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const r = raw as Record<string, unknown>
  if (Object.keys(r).length === 0) return undefined
  return oggetto(oggetto(r.FatturaElettronicaBody).DatiGenerali)
}

// ————————————————————————————————————————————————————————————————————————
// Piccoli costruttori, perche' ogni voce esca con TUTTI i campi compilati.
// ————————————————————————————————————————————————————————————————————————

function aNorma(regola: string, dice: string, trovato: string): EsitoControllo {
  return {
    regola, dice, trovato,
    esito: 'a_norma',
    gravita: null,
    conseguenza: null,
    // Un controllo passato non ha niente da correggere: dire «correggibile»
    // qui vorrebbe dire invitare a riscrivere un documento a posto.
    correggibile_via_api: false,
    come: null,
    correzione: null,
  }
}

function nonVerificato(regola: string, dice: string, perche: string): EsitoControllo {
  return {
    regola, dice,
    trovato: `NON VERIFICATO: ${perche}`,
    esito: 'non_verificato',
    gravita: null,
    conseguenza: 'non so dire se questa regola sia rispettata: non contarla fra quelle passate',
    correggibile_via_api: false,
    come: 'guarda questo campo a mano su Fatture in Cloud: da qui non l\'ho letto',
    correzione: null,
  }
}

function rilievo(
  regola: string,
  dice: string,
  trovato: string,
  gravita: Gravita,
  conseguenza: string,
  come: string,
  correzione: CorrezioneProposta | null = null,
): EsitoControllo {
  return {
    regola, dice, trovato, esito: 'rilievo', gravita, conseguenza,
    correggibile_via_api: correzione !== null,
    come,
    correzione,
  }
}

// ————————————————————————————————————————————————————————————————————————
// LE REGOLE DELL'AUTOFATTURA TD17 (documento EMESSO)
// ————————————————————————————————————————————————————————————————————————

const DICE_TD17 = `il tipo documento SdI deve essere ${TIPO_DOCUMENTO_SDI} (sta in ei_raw, non nel campo «type»)`

/** REGOLA 1 — senza TD17 non e' un'integrazione. E' la cosa piu' grave. */
export function regolaTipoDocumento(doc: Record<string, unknown>): EsitoControllo {
  const generali = datiGeneraliSdi(doc)
  if (generali === undefined) {
    return nonVerificato('tipo_documento_sdi', DICE_TD17, 'il blocco elettronico (ei_raw) non e\' presente nella rilettura')
  }
  const tipo = testo(oggetto(generali.DatiGeneraliDocumento).TipoDocumento)
  if (tipo === TIPO_DOCUMENTO_SDI) {
    return aNorma('tipo_documento_sdi', DICE_TD17, TIPO_DOCUMENTO_SDI)
  }
  return rilievo(
    'tipo_documento_sdi',
    DICE_TD17,
    tipo || '(nessun TipoDocumento nel blocco elettronico)',
    'grave',
    `senza ${TIPO_DOCUMENTO_SDI} questo NON e' un'integrazione in reverse charge: e' una normale autofattura, `
    + 'giusta in apparenza e sbagliata nella sostanza, e l\'adempimento sull\'acquisto estero resta non assolto',
    'il tipo documento SdI non lo cambia nessun tool di questo repo: il documento va rifatto con compila_autofattura '
    + '(e quello vecchio eliminato), oppure corretto a mano su Fatture in Cloud se l\'interfaccia lo consente',
  )
}

const DICE_COLLEGATA = 'NON devono esserci attributi «dati fattura collegata» (2.1.6) scritti via API: FIC li serializza rotti e lo SdI scarta il documento'

/**
 * REGOLA 2 — i «dati fattura collegata» NON devono esserci.
 *
 * 🚨 Questa regola e' nata al contrario, e andava ribaltata prima di mergiarla.
 *
 * Il 15 settembre 2026 quel blocco era stato aggiunto ai documenti perche'
 * compare nell'XML di una TD17 valida. Ma passato via API dentro `ei_raw`,
 * Fatture in Cloud lo serializza come attributi SCIOLTI `2.1.6.x` e produce
 * blocchi `DatiFattureCollegate` SENZA `IdDocumento`: la Verifica formale
 * fallisce con «dovrebbe esserci l'elemento IdDocumento» e lo SdI SCARTA il
 * documento. Dall'interfaccia quegli attributi non si possono ne' correggere
 * ne' togliere: si ripara solo cancellando e rifacendo.
 *
 * Quindi la presenza e' il DIFETTO, non l'assenza. Il riferimento alla fattura
 * estera sta nella descrizione della riga e nelle note — per l'Agenzia delle
 * Entrate basta, `DatiFattureCollegate` e' consigliato, non obbligatorio
 * (specifica Rev.03, §8.1).
 *
 * ⚠️ E la «correzione» che questa regola proponeva era peggio del rilievo:
 * chiamava `modifica_documento_fic` per RIMETTERE il blocco, cioe' per
 * rompere l'XML di un documento sano. Una verifica che rompe quello che
 * controlla e' il difetto peggiore che si possa spedire.
 */
export function regolaFatturaCollegata(doc: Record<string, unknown>): EsitoControllo {
  const generali = datiGeneraliSdi(doc)
  if (generali === undefined) {
    return nonVerificato('fattura_collegata', DICE_COLLEGATA, 'il blocco elettronico (ei_raw) non e\' presente nella rilettura')
  }
  const collegata = oggetto(generali.DatiFattureCollegate)
  const num = testo(collegata.IdDocumento)
  const data = testo(collegata.Data)
  if (!num && !data && generali.DatiFattureCollegate === undefined) {
    return aNorma('fattura_collegata', DICE_COLLEGATA, 'nessun attributo 2.1.6: il riferimento sta nella riga e nelle note')
  }
  return rilievo(
    'fattura_collegata',
    DICE_COLLEGATA,
    `c'e' un blocco DatiFattureCollegate (IdDocumento «${num || '(vuoto)'}», Data «${data || '(vuoto)'}»)`,
    'grave',
    'la Verifica formale di Fatture in Cloud fallisce e lo SdI scarta il documento; dall\'interfaccia quegli attributi '
    + 'non si possono ne\' modificare ne\' eliminare',
    'NON si corregge: il documento va CANCELLATO e rifatto con compila_autofattura, che non li scrive piu\'',
  )
}

const DICE_EI_CODE = `il codice destinatario deve essere il NOSTRO (${CODICE_DESTINATARIO_INTEGRAZIONE}): un'integrazione torna a noi`

/** REGOLA 3 — il codice destinatario e' il nostro, non quello del fornitore estero. */
export function regolaCodiceDestinatario(doc: Record<string, unknown>): EsitoControllo {
  const entity = oggetto(doc.entity)
  // Entita' vuota = non l'abbiamo letta. Entita' con dentro qualcosa ma senza
  // `ei_code` = il codice sul documento non c'e', e su un documento
  // elettronico e' un difetto vero.
  if (Object.keys(entity).length === 0) {
    return nonVerificato('codice_destinatario', DICE_EI_CODE, 'la controparte (entity) non e\' presente nella rilettura')
  }
  const code = testo(entity.ei_code)
  if (code === CODICE_DESTINATARIO_INTEGRAZIONE) {
    return aNorma('codice_destinatario', DICE_EI_CODE, code)
  }
  const id = numero(doc.id)
  const esteri = code === CODICE_DESTINATARIO_ESTERI
  return rilievo(
    'codice_destinatario',
    DICE_EI_CODE,
    code || '(nessun codice destinatario sulla controparte)',
    'importante',
    esteri
      ? `${CODICE_DESTINATARIO_ESTERI} e' il codice riservato ai destinatari ESTERI: il Sistema di Interscambio potrebbe `
        + 'non restituirci l\'integrazione, che invece deve tornare a noi'
      : 'il codice destinatario non e\' il nostro: l\'integrazione potrebbe non tornarci dal Sistema di Interscambio',
    `si corregge con modifica_documento_fic, campo codice_destinatario. ⚠️ Su Fatture in Cloud questo campo, a documento `
    + 'gia\' creato, NON si tocca a mano: l\'API e\' l\'unica strada.',
    {
      tool: 'modifica_documento_fic',
      parametri: { id: id ?? 0, codice_destinatario: CODICE_DESTINATARIO_INTEGRAZIONE },
      serve_da_te: null,
    },
  )
}

const DICE_STORNATO = 'il piano pagamenti deve essere STORNATO (status «reversed»): su un reverse charge non c\'e\' niente da pagare'

/** REGOLA 4 — `not_paid` fa comparire l'integrazione nello scadenzario. */
export function regolaPagamentoStornato(doc: Record<string, unknown>): EsitoControllo {
  const voci = pianoPagamenti(doc)
  if (voci === undefined) {
    return nonVerificato('pagamento_stornato', DICE_STORNATO, 'payments_list non e\' una lista nella rilettura')
  }
  if (voci.length === 0) {
    return rilievo(
      'pagamento_stornato', DICE_STORNATO, '(piano pagamenti vuoto)', 'avviso',
      'senza voci nel piano non posso dire che l\'importo risulti stornato: controlla come compare nello scadenzario',
      'apri il documento su Fatture in Cloud e metti la voce del piano pagamenti su «stornato»',
    )
  }
  const stati = voci.map((v) => testo(v.status) || '(senza status)')
  if (stati.every((s) => s === STATO_STORNATO)) {
    return aNorma('pagamento_stornato', DICE_STORNATO, `${voci.length} voce/i, tutte «${STATO_STORNATO}»`)
  }
  return rilievo(
    'pagamento_stornato', DICE_STORNATO, stati.join(', '), 'importante',
    'il documento risulta SCADUTO nello scadenzario, col tasto «manda sollecito» puntato verso il fornitore ESTERO: '
    + 'un sollecito per un importo che nessuno deve pagare',
    'lo stato del piano pagamenti non lo cambia modifica_documento_fic: aprilo su Fatture in Cloud e metti la voce su '
    + '«stornato». (segna_fatture_emesse_pagate registra un INCASSO, cioe\' «paid»: non e\' questo il caso.)',
  )
}

const DICE_ELETTRONICA = 'il documento deve essere ELETTRONICO (e_invoice = true): una TD17 si assolve solo trasmettendola allo SdI'

/** REGOLA 5 — senza `e_invoice` non c'e' nemmeno il tasto per trasmettere. */
export function regolaElettronica(doc: Record<string, unknown>): EsitoControllo {
  if (doc.e_invoice === true) return aNorma('elettronica', DICE_ELETTRONICA, 'true')
  if (doc.e_invoice === false) {
    return rilievo(
      'elettronica', DICE_ELETTRONICA, 'false', 'grave',
      'il documento non si puo\' trasmettere al Sistema di Interscambio — Fatture in Cloud non mostra nemmeno il tasto '
      + 'per farlo — e l\'adempimento sull\'acquisto estero NON viene assolto',
      'nessun tool di questo repo cambia e_invoice su un documento gia\' creato: il documento va rifatto con '
      + 'compila_autofattura (che lo fa nascere elettronico) ed eliminato quello vecchio',
    )
  }
  return nonVerificato('elettronica', DICE_ELETTRONICA, `e_invoice non e' ne' true ne' false nella rilettura (vale «${testo(doc.e_invoice) || 'assente'}»)`)
}

const DICE_CEDENTE = 'la controparte e\' il fornitore ESTERO, e vuole partita IVA comunitaria e indirizzo valorizzati'

/** REGOLA 6 — senza i dati del cedente estero il documento e' formalmente incompleto. */
export function regolaCedenteEstero(doc: Record<string, unknown>): EsitoControllo {
  const entity = oggetto(doc.entity)
  if (Object.keys(entity).length === 0) {
    return nonVerificato('cedente_estero', DICE_CEDENTE, 'la controparte (entity) non e\' presente nella rilettura')
  }
  const nome = testo(entity.name)
  const piva = testo(entity.vat_number)
  const via = testo(entity.address_street)
  const citta = testo(entity.address_city)
  const mancano = [
    piva ? null : 'partita IVA',
    via ? null : 'indirizzo (via)',
    citta ? null : 'citta\'',
  ].filter(Boolean) as string[]

  const letto = `${nome || '(senza nome)'} — P.IVA «${piva || '(assente)'}», ${via || '(via assente)'}, ${citta || '(citta\' assente)'}`
  if (mancano.length === 0) return aNorma('cedente_estero', DICE_CEDENTE, letto)

  return rilievo(
    'cedente_estero', DICE_CEDENTE, letto,
    // La partita IVA manca → formalmente incompleto; manca solo l'indirizzo →
    // resta un difetto, ma non della stessa taglia.
    piva ? 'avviso' : 'importante',
    `mancano: ${mancano.join(', ')}. Il documento e' formalmente incompleto: l'integrazione deve riportare i dati del `
    + 'cedente estero',
    'questi dati stanno in ANAGRAFICA, non sul documento: correggi la scheda del fornitore su Fatture in Cloud. '
    + '⚠️ Correggere l\'anagrafica NON aggiorna da sola i documenti gia\' creati.',
  )
}

// ————————————————————————————————————————————————————————————————————————
// LE REGOLE DELLA SPESA (documento RICEVUTO) del fornitore estero
// ————————————————————————————————————————————————————————————————————————

const DICE_SPESA_NON_ELETTRONICA = 'la spesa NON deve essere elettronica (e_invoice = false): la fattura del fornitore estero non transita da SdI'

/** REGOLA 7 — una fattura estera non passa dal Sistema di Interscambio. */
export function regolaSpesaNonElettronica(doc: Record<string, unknown>): EsitoControllo {
  if (doc.e_invoice === false) return aNorma('spesa_non_elettronica', DICE_SPESA_NON_ELETTRONICA, 'false')
  if (doc.e_invoice === true) {
    return rilievo(
      'spesa_non_elettronica', DICE_SPESA_NON_ELETTRONICA, 'true', 'importante',
      'la spesa risulta una fattura elettronica ricevuta dallo SdI, che per un fornitore estero non e\' mai successo: '
      + 'il documento racconta una provenienza falsa',
      'nessun tool di questo repo cambia e_invoice su una spesa gia\' registrata: si corregge su Fatture in Cloud',
    )
  }
  return nonVerificato('spesa_non_elettronica', DICE_SPESA_NON_ELETTRONICA, `e_invoice non e' ne' true ne' false nella rilettura (vale «${testo(doc.e_invoice) || 'assente'}»)`)
}

const DICE_ALLEGATO = 'ci vuole l\'allegato: il PDF della fattura del fornitore'

/** REGOLA 8 — la spesa senza il suo PDF e' una riga che nessuno puo' controllare. */
export function regolaAllegato(doc: Record<string, unknown>): EsitoControllo {
  const url = testo(doc.attachment_url)
  const token = testo(doc.attachment_token)
  if (url || token) {
    return aNorma('allegato', DICE_ALLEGATO, url ? 'allegato presente (attachment_url)' : 'allegato presente (attachment_token)')
  }
  // ⚠️ Qui l'assenza del campo E' il dato: la rilettura `detailed` porta
  // `attachment_url` quando un allegato c'e', e non lo porta quando non c'e'.
  // Non e' un campo che «non si e' potuto leggere», e' un allegato che manca.
  return rilievo(
    'allegato', DICE_ALLEGATO, 'nessun allegato (ne\' attachment_url ne\' attachment_token)', 'importante',
    'la spesa non ha il documento che la giustifica: in caso di controllo non c\'e\' niente da mostrare, e nessuno '
    + 'puo\' verificare importo e numero',
    'l\'allegato si carica su Fatture in Cloud, oppure si rifa\' la spesa con registra_spesa_fornitore, che prende il '
    + 'PDF dalla mail e lo allega. ⚠️ Rifarla crea un DOPPIONE se non elimini prima quella che c\'e\'.',
  )
}

const DICE_SPESA_SALDATA = 'il piano pagamenti deve esserci ed essere SALDATO (status «paid»): la spesa non deve finire nello scadenzario'

/** REGOLA 9 — la piattaforma trattiene le commissioni dal bonifico: non c'e' niente da pagare dopo. */
export function regolaSpesaSaldata(doc: Record<string, unknown>): EsitoControllo {
  const voci = pianoPagamenti(doc)
  if (voci === undefined) {
    return nonVerificato('spesa_saldata', DICE_SPESA_SALDATA, 'payments_list non e\' una lista nella rilettura')
  }
  const id = numero(doc.id)
  const correzione: CorrezioneProposta = {
    tool: 'segna_fatture_ricevute_pagate',
    parametri: { id: id ?? 0 },
    serve_da_te: 'il conto di pagamento su cui la spesa risulta saldata: lo scegli tu, il tool ti elenca quelli veri dell\'azienda',
  }
  if (voci.length === 0) {
    return rilievo(
      'spesa_saldata', DICE_SPESA_SALDATA, '(piano pagamenti vuoto)', 'importante',
      'senza piano pagamenti la spesa non risulta ne\' pagata ne\' da pagare: sparisce dai conti che l\'Ingegnere guarda',
      'si corregge con segna_fatture_ricevute_pagate',
      correzione,
    )
  }
  const stati = voci.map((v) => testo(v.status) || '(senza status)')
  if (stati.every((s) => s === STATO_SALDATO)) {
    return aNorma('spesa_saldata', DICE_SPESA_SALDATA, `${voci.length} voce/i, tutte «${STATO_SALDATO}»`)
  }
  return rilievo(
    'spesa_saldata', DICE_SPESA_SALDATA, stati.join(', '), 'importante',
    'la spesa compare nello scadenzario come da pagare, ma non c\'e\' niente da pagare: la piattaforma trattiene le '
    + 'commissioni direttamente dal bonifico dei soggiorni',
    'si corregge con segna_fatture_ricevute_pagate',
    correzione,
  )
}

const DICE_CHIAVE = 'numero e data della fattura del fornitore devono essere valorizzati: sono la chiave anti-doppione'

/** REGOLA 10 — senza numero e data, la stessa fattura si registra due volte. */
export function regolaChiaveAntiDoppione(doc: Record<string, unknown>): EsitoControllo {
  const num = testo(doc.invoice_number)
  const data = testo(doc.date)
  const letto = `numero «${num || '(assente)'}», data «${data || '(assente)'}»`
  if (num && data) return aNorma('chiave_anti_doppione', DICE_CHIAVE, letto)
  return rilievo(
    'chiave_anti_doppione', DICE_CHIAVE, letto, 'grave',
    'la chiave con cui si riconosce una spesa gia\' registrata non c\'e\': la stessa fattura del fornitore puo\' essere '
    + 'registrata una seconda volta senza che nessuno se ne accorga',
    'modifica_documento_fic lavora sui documenti EMESSI, non sulle spese: numero e data vanno messi a mano su Fatture '
    + 'in Cloud',
  )
}

// ————————————————————————————————————————————————————————————————————————
// ⬜ Le RILEVAZIONI contabili: non si leggono e non si correggono da qui.
// ————————————————————————————————————————————————————————————————————————

/**
 * 🚨 Queste due voci sono il motivo per cui questo blocco esiste.
 *
 * Non stanno nel modello ufficiale dell'SDK (`IssuedDocument`,
 * `IssuedDocumentEiData`): cercate, non ci sono. Quindi il tool non le legge e
 * non le corregge — e proprio per questo le DEVE nominare. Un controllo che il
 * tool non fa e di cui non parla e' un controllo che non fa nessuno, e sono i
 * due che sbagliano i NUMERI: uno gonfia il fatturato, l'altro conta l'IVA due
 * volte in liquidazione.
 */
export function daControllareAMano(tipo: TipoVerifica): DaControllareAMano[] {
  const perche = 'il campo non esiste nel modello ufficiale dell\'SDK di Fatture in Cloud (IssuedDocument, '
    + 'IssuedDocumentEiData): da qui non si legge e non si scrive'
  if (tipo === 'autofattura') {
    return [{
      voce: '«Rileva ricavo» sull\'autofattura',
      deve_essere: 'NO (non spuntato)',
      se_sbagliato: 'l\'imponibile dell\'integrazione diventa un RICAVO fittizio e gonfia il fatturato: i conti dicono '
        + 'che hai incassato un importo che non ha pagato nessuno',
      perche_non_via_api: perche,
    }]
  }
  return [{
    voce: '«Rileva IVA a debito» sulla spesa',
    deve_essere: 'NO (non spuntato)',
    se_sbagliato: 'il 22% viene contato DUE VOLTE in liquidazione — una qui e una sull\'autofattura — e si versa IVA '
      + 'che non e\' dovuta',
    perche_non_via_api: perche,
  }]
}

// ————————————————————————————————————————————————————————————————————————
// L'orchestrazione: legge, applica le regole, non scrive NIENTE.
// ————————————————————————————————————————————————————————————————————————

/** Le sei regole dell'autofattura TD17, nell'ordine della specifica. */
export function controlliAutofattura(doc: Record<string, unknown>): EsitoControllo[] {
  return [
    regolaTipoDocumento(doc),
    regolaFatturaCollegata(doc),
    regolaCodiceDestinatario(doc),
    regolaPagamentoStornato(doc),
    regolaElettronica(doc),
    regolaCedenteEstero(doc),
  ]
}

/** Le quattro regole della spesa ricevuta, nell'ordine della specifica. */
export function controlliSpesa(doc: Record<string, unknown>): EsitoControllo[] {
  return [
    regolaSpesaNonElettronica(doc),
    regolaAllegato(doc),
    regolaSpesaSaldata(doc),
    regolaChiaveAntiDoppione(doc),
  ]
}

/**
 * 🚨 Un documento TRASMESSO non si tocca: la VERIFICA si fa lo stesso, la
 * CORREZIONE no.
 *
 * Si riusa la stessa guardia di `fic-modifica.ts` (`locked` +
 * `STATI_SDI_TRASMESSO`), non una copia: una seconda guardia scritta qui
 * sarebbe un secondo posto dove un giorno diverge, e il giorno in cui diverge
 * questo tool propone di riscrivere una fattura gia' partita.
 *
 * Vale solo sui documenti EMESSI: una spesa RICEVUTA non la trasmette nessuno.
 */
function correzioneBloccata(doc: Record<string, unknown>): string | null {
  const esito = documentoModificabile(datiDocumento(doc))
  return esito.ok ? null : esito.motivo
}

/** Spegne ogni correzione proposta, lasciando il RILIEVO al suo posto. */
function senzaCorrezioni(controlli: EsitoControllo[], motivo: string): EsitoControllo[] {
  return controlli.map((c) => c.correzione === null ? c : {
    ...c,
    correggibile_via_api: false,
    correzione: null,
    come: `${motivo} Percio' NON propongo di riscriverlo: qui serve una NOTA DI VARIAZIONE.`,
  })
}

function identitaEmessa(doc: Record<string, unknown>): EsitoVerifica['documento'] {
  const d = datiDocumento(doc)
  return { id: d.id, tipo: d.tipo, numero: d.numero, data: d.data, controparte: d.controparte, totale: d.totale }
}

function identitaSpesa(doc: Record<string, unknown>): EsitoVerifica['documento'] {
  return {
    id: numero(doc.id) ?? 0,
    tipo: testo(doc.type) || 'expense',
    numero: testo(doc.invoice_number) || '(senza numero)',
    data: testo(doc.date),
    controparte: testo(oggetto(doc.entity).name) || '(fornitore non indicato)',
    totale: arrotonda(numero(doc.amount_gross) ?? 0),
  }
}

/**
 * Verifica un documento gia' creato su Fatture in Cloud. NON scrive niente.
 *
 * ⚠️ `tipo` e' obbligatorio e non si indovina: gli id dei documenti EMESSI e
 * quelli delle spese RICEVUTE vivono in due registri diversi e si
 * SOVRAPPONGONO. Provare l'uno e poi l'altro vorrebbe dire, prima o poi,
 * verificare un documento che non e' quello di cui l'Ingegnere sta parlando —
 * e dirgli che e' a norma.
 */
export async function verificaDocumento(
  id: number,
  tipo: TipoVerifica,
  societa: CodiceSocieta,
): Promise<EsitoFic<EsitoVerifica>> {
  if (tipo === 'spesa') {
    const letto = await leggiFatturaRicevuta(id, societa)
    if (!letto.ok) return { ok: false, error: letto.error }
    return {
      ok: true,
      valore: {
        tipo,
        documento: identitaSpesa(letto.valore),
        controlli: controlliSpesa(letto.valore),
        // Una spesa ricevuta non e' mai stata trasmessa da noi: non c'e'
        // niente da bloccare.
        correzione_bloccata: null,
        da_controllare_a_mano: daControllareAMano(tipo),
      },
    }
  }

  const letto = await leggiDocumentoEmesso(id, societa)
  if (!letto.ok) return { ok: false, error: letto.error }
  const doc = letto.valore
  const bloccata = correzioneBloccata(doc)
  const controlli = controlliAutofattura(doc)
  return {
    ok: true,
    valore: {
      tipo,
      documento: identitaEmessa(doc),
      controlli: bloccata ? senzaCorrezioni(controlli, bloccata) : controlli,
      correzione_bloccata: bloccata,
      da_controllare_a_mano: daControllareAMano(tipo),
    },
  }
}

/** Il conto per esito. Accompagna l'elenco, non lo sostituisce. */
export function riepilogo(controlli: EsitoControllo[]): { a_norma: number; rilievi: number; non_verificati: number } {
  return {
    a_norma: controlli.filter((c) => c.esito === 'a_norma').length,
    rilievi: controlli.filter((c) => c.esito === 'rilievo').length,
    non_verificati: controlli.filter((c) => c.esito === 'non_verificato').length,
  }
}

/** La societa' in chiaro, per l'intestazione dell'esito. */
export function intestazione(societa: CodiceSocieta): { societa: string; partita_iva: string } {
  const s = getSocieta(societa)
  return { societa: s.denominazione, partita_iva: s.piva }
}
