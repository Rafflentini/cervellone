/**
 * src/lib/fic-modifica.ts — MODIFICARE un documento gia' creato su Fatture in
 * Cloud, invece di cancellarlo e rifarlo.
 *
 * PERCHE' ESISTE (15 settembre 2026). Il bot sapeva COMPILARE un'autofattura
 * (`compila_autofattura`) e sapeva CANCELLARLA (`elimina_bozza_fic`). Non
 * sapeva modificarla. Quindi un documento con un dato sbagliato — la data, un
 * imponibile, il riferimento alla fattura estera — si poteva solo cancellare e
 * rifare, e su una serie di numerazione fiscale questo lascia un BUCO: il
 * numero bruciato non torna. Le parole dell'Ingegnere: «vorrei che il tool
 * sapesse anche modificarle, le autofatture».
 *
 * COSA DICE L'API. L'unico verbo di modifica e'
 * `PUT /c/{company_id}/issued_documents/{document_id}`, corpo `{ data: {...} }`
 * (`modifyIssuedDocument`). Non esiste un PATCH.
 *
 * ⚠️ **LA SEMANTICA DEL PUT NON E' DOCUMENTATA**, ed e' il vincolo che decide
 * la forma di tutto questo file: la documentazione ufficiale non dichiara se
 * il PUT sostituisca il documento INTERO o accetti un aggiornamento PARZIALE
 * (lo stesso dubbio scritto in testa a `fic-pagamenti.ts`). Quindi qui si
 * rilegge il documento intero, gli si applicano SOPRA le sole modifiche
 * richieste, e si rispedisce l'oggetto completo meno i campi di sola lettura:
 * e' l'unica forma il cui esito e' lo stesso sotto ENTRAMBE le semantiche.
 *
 * ⚠️ Sui PAGAMENTI delle fatture emesse si e' fatta la scelta OPPOSTA
 * (`soloPagamenti` in `fic-pagamenti.ts`: si manda solo `payments_list`), e non
 * e' una contraddizione: li' il documento e' trasmesso e bloccato, e si sta
 * registrando un INCASSO, non modificando la fattura. Qui il documento NON e'
 * trasmesso — se lo fosse questo tool rifiuterebbe — e si sta cambiando il
 * documento davvero. Sono due casi diversi, con due forme diverse.
 *
 * 🚨 UN DOCUMENTO TRASMESSO NON SI TOCCA. Se risulta `locked`, o se lo stato
 * SdI non e' uno di quelli che significano «mai partita», il tool RIFIUTA: una
 * fattura elettronica trasmessa si corregge con una nota di variazione, non
 * riscrivendola. Non e' un avviso, e' un rifiuto.
 *
 * 🚨 L'ESITO NON E' LA RISPOSTA DELLA PUT. Si legge, si scrive, si RILEGGE, e
 * si riportano i valori VERI riletti da Fatture in Cloud. Se un campo non
 * risulta cambiato, lo si dice, invece di dichiarare successo.
 */

import { ficGet, ficPut, getCompanyId } from './fatture-in-cloud'
import { getSocieta, type CodiceSocieta } from './societa'
import { CAMPI_NON_SCRIVIBILI_EMESSA, type EsitoFic } from './fic-pagamenti'

/** Una riga del documento, come la legge l'Ingegnere. */
export interface RigaLetta {
  descrizione: string
  importo: number
}

/** Quello che si puo' cambiare. Un campo assente NON viene toccato. */
export interface ModificheRichieste {
  /** Data del documento, YYYY-MM-DD. */
  data?: string
  /** Note del documento (sostituiscono le precedenti). */
  note?: string
  /** Righe ESISTENTI da correggere, per posizione (1 = la prima). */
  righe?: Array<{ riga: number; descrizione?: string; importo?: number }>
  /** Il riferimento strutturato alla fattura estera integrata (TD17). */
  fattura_collegata?: { numero: string; data: string }
  /**
   * Il CODICE DESTINATARIO SdI scritto sul DOCUMENTO (`entity.ei_code`).
   *
   * 🚨 Su un'integrazione TD17 e' il NOSTRO codice, non quello del fornitore
   * estero: l'integrazione torna a noi. Fatture in Cloud lo ricava
   * dall'anagrafica della controparte e, su un fornitore estero che un codice
   * SdI non ce l'ha, ripiega su `XXXXXXX` — il codice riservato ai
   * destinatari ESTERI.
   *
   * ⚠️ Si scrive QUI e non in anagrafica: e' un campo del documento. E a
   * documento gia' creato Fatture in Cloud NON lo lascia toccare a mano —
   * l'API e' l'unica strada, ed e' il motivo per cui questo campo esiste.
   */
  codice_destinatario?: string
}

/** I dati del documento che contano per una modifica. */
export interface DatiDocumento {
  id: number
  tipo: string
  numero: string
  data: string
  controparte: string
  totale: number
  locked: boolean
  stato_sdi: string
  /** `undefined` = la rilettura non espone `ei_raw`, non «il documento non ce l'ha». */
  tipo_documento_sdi: string | undefined
  note: string
  righe: RigaLetta[]
  fattura_collegata: { numero: string; data: string } | null
  /** Il codice destinatario SdI scritto sul documento (`entity.ei_code`). */
  codice_destinatario: string
}

/** Un campo che l'Ingegnere ha chiesto di cambiare: prima -> dopo. */
export interface Cambio {
  campo: string
  prima: string
  dopo: string
}

/** Un campo riletto DOPO la scrittura: cosa c'e' davvero su Fatture in Cloud. */
export interface CambioVerificato extends Cambio {
  riletto: string
  confermato: boolean
}

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

/** Gli importi si confrontano come stringhe a due decimali: 218.4 === 218.40. */
function importo(n: number): string {
  return arrotonda(n).toFixed(2)
}

const DATA_ISO = /^\d{4}-\d{2}-\d{2}$/

/**
 * Gli stati SdI che sono PROVA che il documento e' partito.
 *
 * ⚠️ **Perche' una lista di «trasmesso» e non una di «non trasmesso».** La
 * prima versione faceva il contrario: ammetteva solo `''` e `not_sent`, e
 * qualunque altro valore — compreso uno sconosciuto — faceva rifiutare. Il
 * ragionamento era «si sbaglia dalla parte giusta», ed e' un ragionamento che
 * in questa casa ha gia' fatto danni: **una guardia che blocca il caso normale
 * e' peggio del buco che voleva chiudere.** L'elenco vero degli `ei_status` di
 * Fatture in Cloud non l'abbiamo mai visto: bastava che un documento appena
 * creato ne portasse uno diverso da questi due perche' il tool rifiutasse
 * SEMPRE, su ogni documento, e nessun test se ne accorgesse — i test non
 * parlano con FIC.
 *
 * La difesa vera non e' questa lista: e' `locked`, che Fatture in Cloud impone
 * dal proprio lato e che viene controllato PRIMA. Un documento trasmesso e'
 * bloccato, e se anche qualcosa sfuggisse e' FIC a rifiutare il PUT — e il suo
 * rifiuto lo riportiamo testualmente, che e' un'informazione migliore di una
 * nostra congettura.
 *
 * Quindi: si rifiuta su PROVA di trasmissione. Uno stato sconosciuto non e'
 * una prova, e non blocca — ma viene riportato nell'esito, cosi' se un giorno
 * ne compare uno che significa «trasmessa» lo si aggiunge qui avendolo VISTO.
 */
export const STATI_SDI_TRASMESSO: ReadonlySet<string> = new Set([
  'sent',
  'delivered',
  'not_delivered',
  'rejected',
  'accepted',
  'expired_terms',
  'attempt_failed',
])

/**
 * Il `TipoDocumento` SdI del documento, o `undefined` se la rilettura non
 * espone `ei_raw`. Come in `fic-write-tools.ts`: `undefined` vuol dire «non
 * l'ho visto», non «non c'e'».
 */
function tipoDocumentoSdi(doc: Record<string, unknown>): string | undefined {
  const body = oggetto(oggetto(doc.ei_raw).FatturaElettronicaBody)
  const generali = oggetto(oggetto(body.DatiGenerali).DatiGeneraliDocumento)
  const t = testo(generali.TipoDocumento)
  return t || undefined
}

function fatturaCollegataDi(doc: Record<string, unknown>): { numero: string; data: string } | null {
  const body = oggetto(oggetto(doc.ei_raw).FatturaElettronicaBody)
  const collegata = oggetto(oggetto(body.DatiGenerali).DatiFattureCollegate)
  const num = testo(collegata.IdDocumento)
  const data = testo(collegata.Data)
  return num || data ? { numero: num, data } : null
}

/** Estrae dal documento tutto cio' su cui questo tool ragiona. */
export function datiDocumento(doc: Record<string, unknown>): DatiDocumento {
  const righe = (Array.isArray(doc.items_list) ? doc.items_list.map(oggetto) : []).map((r) => ({
    descrizione: testo(r.name),
    importo: arrotonda(numero(r.net_price) ?? 0),
  }))
  return {
    id: numero(doc.id) ?? 0,
    tipo: testo(doc.type),
    numero: `${testo(doc.number)}${testo(doc.numeration)}` || '(senza numero)',
    data: testo(doc.date),
    controparte: testo(oggetto(doc.entity).name) || '(controparte non indicata)',
    totale: arrotonda(numero(doc.amount_gross) ?? 0),
    locked: doc.locked === true,
    stato_sdi: testo(doc.ei_status),
    tipo_documento_sdi: tipoDocumentoSdi(doc),
    note: testo(doc.notes),
    righe,
    fattura_collegata: fatturaCollegataDi(doc),
    codice_destinatario: testo(oggetto(doc.entity).ei_code),
  }
}

/**
 * 🚨 LA GUARDIA CHE NON SI NEGOZIA: un documento trasmesso non si riscrive.
 *
 * Due prove indipendenti, e basta che una dica «fermo»: il flag `locked` di
 * Fatture in Cloud, e lo stato verso il Sistema di Interscambio. Il blocco
 * vero lo fa rispettare FIC, ma qui si rifiuta PRIMA — un PUT su una fattura
 * trasmessa che per qualche motivo passasse sarebbe un danno che nessuna
 * rilettura ripara.
 */
export function documentoModificabile(
  dati: DatiDocumento,
): { ok: true } | { ok: false; motivo: string } {
  if (dati.locked) {
    return {
      ok: false,
      motivo: `il documento ${dati.numero} e' BLOCCATO su Fatture in Cloud (locked): non lo riscrivo. `
        + 'Un documento bloccato e\' stato trasmesso o chiuso, e una fattura elettronica trasmessa si corregge '
        + 'con una NOTA DI VARIAZIONE, non modificandola.',
    }
  }
  const stato = dati.stato_sdi.toLowerCase()
  if (STATI_SDI_TRASMESSO.has(stato)) {
    return {
      ok: false,
      motivo: `il documento ${dati.numero} risulta gia' mandato al Sistema di Interscambio `
        + `(stato SdI «${dati.stato_sdi}»): non lo riscrivo. Una fattura elettronica trasmessa si corregge con una `
        + 'NOTA DI VARIAZIONE. Se questo stato NON significa «trasmessa», dimmelo: e\' un valore che non conosco.',
    }
  }
  return { ok: true }
}

/**
 * Il confronto campo per campo: TUTTI i campi richiesti, anche quelli che
 * risultano gia' uguali.
 *
 * Restituisce anche gli invariati di proposito: servono due volte. Prima della
 * conferma dicono che quel campo e' gia' cosi' (e se lo sono TUTTI non si
 * scrive niente); dopo la scrittura la stessa funzione, richiamata sul
 * documento RILETTO, dice se il valore nuovo c'e' davvero.
 */
export function confrontoModifiche(
  dati: DatiDocumento,
  m: ModificheRichieste,
): EsitoFic<Cambio[]> {
  const out: Cambio[] = []

  if (m.data !== undefined) {
    // ⚠️ Un campo VUOTO non vuol dire «cancella»: vuol dire che chi chiama ha
    // sbagliato, e su un documento fiscale non si indovina cosa intendeva.
    if (!DATA_ISO.test(m.data)) {
      return { ok: false, error: `la data "${m.data}" non e' nel formato YYYY-MM-DD: non la interpreto io` }
    }
    out.push({ campo: 'data', prima: dati.data, dopo: m.data })
  }

  if (m.note !== undefined) {
    if (!m.note.trim()) {
      return { ok: false, error: 'le note sono vuote: se volevi cancellarle dimmelo a parole, un campo vuoto non lo leggo come «cancella»' }
    }
    out.push({ campo: 'note', prima: dati.note, dopo: m.note.trim() })
  }

  for (const r of m.righe ?? []) {
    if (!Number.isInteger(r.riga) || r.riga < 1 || r.riga > dati.righe.length) {
      return {
        ok: false,
        error: `la riga ${r.riga} non esiste: il documento ha ${dati.righe.length} righe `
          + `(${dati.righe.map((x, i) => `#${i + 1} ${x.descrizione} ${importo(x.importo)}`).join(' · ') || 'nessuna'})`,
      }
    }
    const attuale = dati.righe[r.riga - 1]
    if (r.descrizione === undefined && r.importo === undefined) {
      return { ok: false, error: `della riga ${r.riga} non mi hai detto cosa cambiare: serve la descrizione o l'importo` }
    }
    if (r.descrizione !== undefined) {
      if (!r.descrizione.trim()) {
        return { ok: false, error: `la descrizione della riga ${r.riga} e' vuota: su un documento fiscale una riga senza descrizione non la scrivo` }
      }
      out.push({ campo: `riga ${r.riga} · descrizione`, prima: attuale.descrizione, dopo: r.descrizione.trim() })
    }
    if (r.importo !== undefined) {
      const n = numero(r.importo)
      if (n === null) {
        return { ok: false, error: `l'importo della riga ${r.riga} non e' un numero leggibile: non lo interpreto io` }
      }
      out.push({ campo: `riga ${r.riga} · importo`, prima: importo(attuale.importo), dopo: importo(n) })
    }
  }

  if (m.fattura_collegata !== undefined) {
    const num = testo(m.fattura_collegata.numero)
    const data = testo(m.fattura_collegata.data)
    // Un riferimento a meta' e' peggio di nessun riferimento, perche' sembra
    // compilato (stessa regola di `eiRawIntegrazione`).
    if (!num || !data) {
      return { ok: false, error: 'la fattura collegata vuole NUMERO e DATA insieme: un riferimento a meta\' sembra compilato e non lo e\'' }
    }
    if (!DATA_ISO.test(data)) {
      return { ok: false, error: `la data della fattura collegata "${data}" non e' nel formato YYYY-MM-DD: non la interpreto io` }
    }
    out.push({ campo: 'fattura collegata · numero', prima: dati.fattura_collegata?.numero ?? '(assente)', dopo: num })
    out.push({ campo: 'fattura collegata · data', prima: dati.fattura_collegata?.data ?? '(assente)', dopo: data })
  }

  if (m.codice_destinatario !== undefined) {
    const code = testo(m.codice_destinatario).toUpperCase()
    // 6 caratteri = Codice Univoco Ufficio della Pubblica Amministrazione,
    // 7 = codice destinatario privato (M5UXCR1, XXXXXXX). Fuori da queste due
    // misure non e' un codice SdI, e conviene dirlo qui che vederselo
    // rifiutare da Fatture in Cloud con un messaggio che non nomina il campo.
    if (!/^[A-Z0-9]{6,7}$/.test(code)) {
      return { ok: false, error: `«${m.codice_destinatario}» non e' un codice destinatario SdI (6 o 7 caratteri alfanumerici): non lo interpreto io` }
    }
    out.push({ campo: 'codice destinatario', prima: dati.codice_destinatario || '(assente)', dopo: code })
  }

  if (out.length === 0) {
    return { ok: false, error: 'non mi hai detto COSA cambiare: passa almeno uno fra data, note, righe, fattura_collegata e codice_destinatario' }
  }
  return { ok: true, valore: out }
}

export interface Preparata {
  dati: DatiDocumento
  /** Tutti i campi richiesti, invariati compresi: e' lo specchio dell'anteprima. */
  confronto: Cambio[]
  /** Solo quelli che cambiano davvero. Se e' vuoto non si scrive niente. */
  cambi: Cambio[]
}

/**
 * Tutte le difese in fila, nell'ordine in cui vanno fatte valere. Gira DUE
 * volte: quando si prepara l'anteprima e di nuovo prima di scrivere, perche'
 * fra le due passa del tempo e in mezzo il documento puo' essere stato
 * trasmesso.
 */
export function preparaModifica(
  doc: Record<string, unknown>,
  m: ModificheRichieste,
): EsitoFic<Preparata> {
  const dati = datiDocumento(doc)

  const modificabile = documentoModificabile(dati)
  if (!modificabile.ok) return { ok: false, error: modificabile.motivo }

  // 🚨 Il riferimento alla fattura estera vive dentro `ei_raw`, insieme al
  // TipoDocumento TD17. Se la rilettura NON espone `ei_raw` non sappiamo cosa
  // c'e' scritto: riscriverlo vorrebbe dire spedire un `ei_raw` fatto del solo
  // riferimento, e — se il PUT e' una sostituzione — CANCELLARE il TD17,
  // trasformando un'integrazione in una autofattura qualsiasi. Si rifiuta.
  if (m.fattura_collegata !== undefined && dati.tipo_documento_sdi === undefined) {
    return {
      ok: false,
      error: 'non riesco a leggere il blocco elettronico (ei_raw) di questo documento, e li\' dentro vive anche il '
        + 'tipo documento SdI: riscrivendolo per cambiare la fattura collegata rischierei di cancellare il TD17. '
        + 'La fattura collegata correggila su Fatture in Cloud.',
    }
  }

  // 🚨 Il codice destinatario vive DENTRO la controparte (`entity.ei_code`).
  // Se la rilettura non espone `entity`, scriverlo vorrebbe dire spedire una
  // controparte fatta del solo codice — e, se il PUT e' una sostituzione,
  // CANCELLARE il fornitore estero dal documento. Si rifiuta.
  if (m.codice_destinatario !== undefined && Object.keys(oggetto(doc.entity)).length === 0) {
    return {
      ok: false,
      error: 'non riesco a leggere la controparte (entity) di questo documento, e il codice destinatario vive li\' dentro: '
        + 'riscrivendola rischierei di cancellare il fornitore dal documento. Non tocco niente.',
    }
  }

  const confronto = confrontoModifiche(dati, m)
  if (!confronto.ok) return confronto

  const cambi = confronto.valore.filter((c) => c.prima !== c.dopo)
  if (cambi.length === 0) {
    return {
      ok: false,
      error: 'su Fatture in Cloud e\' gia\' scritto cosi\': '
        + confronto.valore.map((c) => `${c.campo} = ${c.dopo}`).join(', ')
        + '. Non tocco un documento fiscale per riscriverci gli stessi valori.',
    }
  }
  return { ok: true, valore: { dati, confronto: confronto.valore, cambi } }
}

/**
 * Il corpo del PUT: il documento INTERO come riletto, meno i campi di sola
 * lettura, con sopra le sole modifiche richieste.
 *
 * 🚨 E' la risposta al vincolo scritto in testa al file: siccome non sappiamo
 * se il PUT sostituisca tutto o accetti un pezzo, si rispedisce tutto. Un
 * campo che l'Ingegnere non ha nominato esce di qui esattamente com'era.
 */
export function corpoModificato(
  doc: Record<string, unknown>,
  m: ModificheRichieste,
): Record<string, unknown> {
  const corpo: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(doc)) {
    if (!CAMPI_NON_SCRIVIBILI_EMESSA.has(k)) corpo[k] = v
  }
  const entity = oggetto(doc.entity)
  if (Object.keys(entity).length > 0) {
    const { created_at: _c, updated_at: _u, ...resto } = entity
    void _c; void _u
    // Si tocca SOLO `ei_code`: nome, partita IVA e indirizzo del fornitore
    // escono di qui esattamente come sono entrati. E se la controparte non
    // si e' letta non si inventa: `preparaModifica` ha gia' rifiutato, e qui
    // l'assenza di `entity` lascia il campo dov'era invece di crearne una
    // fatta del solo codice.
    corpo.entity = m.codice_destinatario !== undefined
      ? { ...resto, ei_code: testo(m.codice_destinatario).toUpperCase() }
      : resto
  }

  if (m.data !== undefined) corpo.date = m.data
  if (m.note !== undefined) corpo.notes = m.note.trim()

  if (m.righe && m.righe.length > 0) {
    const righe = Array.isArray(doc.items_list) ? doc.items_list.map(oggetto) : []
    corpo.items_list = righe.map((riga, i) => {
      const richiesta = m.righe!.find((x) => x.riga === i + 1)
      if (!richiesta) return riga
      const nuova: Record<string, unknown> = { ...riga }
      if (richiesta.descrizione !== undefined) nuova.name = richiesta.descrizione.trim()
      if (richiesta.importo !== undefined) {
        nuova.net_price = arrotonda(Number(richiesta.importo))
        // `gross_price` e' DERIVATO dal netto e dall'IVA: rispedirlo vecchio
        // accanto a un netto nuovo vorrebbe dire dare a Fatture in Cloud due
        // verita' in contraddizione, e non sappiamo quale sceglierebbe.
        delete nuova.gross_price
      }
      return nuova
    })
  }

  if (m.fattura_collegata) {
    const raw = oggetto(doc.ei_raw)
    const body = oggetto(raw.FatturaElettronicaBody)
    const generali = oggetto(body.DatiGenerali)
    corpo.ei_raw = {
      ...raw,
      FatturaElettronicaBody: {
        ...body,
        DatiGenerali: {
          ...generali,
          // Gli altri blocchi di DatiGenerali — DatiGeneraliDocumento col TD17
          // in testa — restano quelli letti: qui si tocca un blocco solo.
          DatiFattureCollegate: {
            IdDocumento: testo(m.fattura_collegata.numero),
            Data: testo(m.fattura_collegata.data),
          },
        },
      },
    }
  }

  return corpo
}

/** Rilegge un documento EMESSO, fieldset detailed. */
export async function leggiDocumentoEmesso(
  id: number,
  societa: CodiceSocieta,
): Promise<EsitoFic<Record<string, unknown>>> {
  const company = await getCompanyId(societa)
  if (!company.ok) return { ok: false, error: company.error }

  const r = await ficGet(
    `/c/${company.id}/issued_documents/${encodeURIComponent(String(id))}`,
    { fieldset: 'detailed' },
    societa,
  )
  const nonEsiste = `il documento ${id} non esiste su Fatture in Cloud`
  if (!r.ok) {
    // Un 404 non e' un guasto: e' «quel documento non c'e'». Dirlo come
    // «errore FIC 404» manda a cercare un problema che non esiste.
    if (r.error.includes('404')) return { ok: false, error: nonEsiste }
    return { ok: false, error: r.error }
  }
  const doc = oggetto(r.data?.data ?? r.data)
  if (!doc.id) return { ok: false, error: nonEsiste }
  return { ok: true, valore: doc }
}

export interface EsitoModifica {
  stato: 'modificato' | 'non_modificato' | 'da_verificare'
  messaggio: string
  /**
   * Vero se la PUT e' partita e Fatture in Cloud l'ha accettata. Da qui in poi
   * NON si ritenta da soli: il documento potrebbe essere gia' cambiato.
   */
  scritto: boolean
  cambi: CambioVerificato[]
  id: number | null
}

/** I campi che una modifica NON deve muovere, per nessun motivo. */
function invarianti(d: DatiDocumento): Record<string, string> {
  return {
    numero: d.numero,
    tipo: d.tipo,
    controparte: d.controparte,
    stato_sdi: d.stato_sdi,
    // `undefined` = non l'abbiamo visto, ne' prima ne' dopo: si confronta
    // com'e', cosi' un TD17 che SPARISSE dalla rilettura si vede.
    tipo_documento_sdi: String(d.tipo_documento_sdi),
  }
}

function riga(c: CambioVerificato): string {
  return c.confermato
    ? `✅ ${c.campo}: ${c.prima || '(vuoto)'} → ${c.riletto}`
    : `❌ ${c.campo}: chiesto ${c.prima || '(vuoto)'} → ${c.dopo}, ma rileggendo c'e' «${c.riletto}»`
}

/**
 * Modifica il documento e lo PROVA rileggendolo.
 *
 * L'ordine e' tutto: rilegge (il documento di ADESSO, non quello
 * dell'anteprima), ricontrolla le difese, controlla che il PRIMA sia ancora
 * quello che l'Ingegnere ha letto, scrive, RILEGGE, e confronta.
 *
 * `attesi` sono i valori «prima» mostrati nell'anteprima: se nel frattempo il
 * documento e' cambiato, la modifica NON parte — un «confermo» vale per quello
 * che si e' letto, non per quello che c'e' adesso.
 */
export async function modificaDocumento(
  id: number,
  m: ModificheRichieste,
  societa: CodiceSocieta,
  attesi: Cambio[] | null,
): Promise<EsitoModifica> {
  const s = getSocieta(societa)
  const non = (motivo: string): EsitoModifica => ({
    stato: 'non_modificato',
    messaggio: `DOCUMENTO NON MODIFICATO su ${s.denominazione} (id ${id}): ${motivo}`,
    scritto: false,
    cambi: [],
    id: null,
  })

  const prima = await leggiDocumentoEmesso(id, societa)
  if (!prima.ok) return non(`${prima.error}. Non ho scritto niente.`)

  const preparata = preparaModifica(prima.valore, m)
  if (!preparata.ok) return non(`${preparata.error} Non ho scritto niente.`)
  const { dati, confronto, cambi } = preparata.valore

  if (attesi) {
    for (const atteso of attesi) {
      const adesso = confronto.find((c) => c.campo === atteso.campo)
      if (adesso && adesso.prima !== atteso.prima) {
        return non(
          `il documento e' CAMBIATO da quando hai letto l'anteprima: ${atteso.campo} era «${atteso.prima}» `
          + `e adesso e' «${adesso.prima}». Non scrivo: rifai la modifica e ricontrolla il prima/dopo.`,
        )
      }
    }
  }

  const company = await getCompanyId(societa)
  if (!company.ok) return non(`${company.error}. Non ho scritto niente.`)

  const scritto = await ficPut(
    `/c/${company.id}/issued_documents/${encodeURIComponent(String(id))}`,
    corpoModificato(prima.valore, m),
    societa,
  )
  if (!scritto.ok) {
    // 🚨 La risposta di Fatture in Cloud si riporta COM'E', stato e testo, senza
    // interpretarla: il 14 settembre 2026 un 403 ha prodotto tre spiegazioni
    // inventate diverse e ore perse.
    return non(`Fatture in Cloud ha rifiutato la modifica. Risposta testuale: «${scritto.error}». Il documento e' rimasto com'era.`)
  }

  const dopo = await leggiDocumentoEmesso(id, societa)
  if (!dopo.ok) {
    return {
      stato: 'da_verificare',
      messaggio: `MODIFICA DA VERIFICARE su ${s.denominazione}: documento ${dati.numero} (id ${id}).\n\n`
        + `Fatture in Cloud ha accettato la modifica, ma NON riesco a rileggere il documento per provarlo (${dopo.error}). `
        + 'Controllalo a mano su Fatture in Cloud: non lo conto fra i riusciti e non ritento.',
      scritto: true,
      cambi: [],
      id,
    }
  }

  const datiDopo = datiDocumento(dopo.valore)
  const riletto = confrontoModifiche(datiDopo, m)
  // Lo stesso `m` ha gia' passato la validazione qui sopra: se fallisse ora
  // sarebbe un guasto nostro, e si dichiara invece di dire «fatto».
  if (!riletto.ok) {
    return {
      stato: 'da_verificare',
      messaggio: `MODIFICA DA VERIFICARE su ${s.denominazione}: documento ${dati.numero} (id ${id}).\n\n`
        + `Fatture in Cloud ha accettato la modifica, ma rileggendo non riesco a confrontare i campi (${riletto.error}). `
        + 'Controllalo a mano su Fatture in Cloud.',
      scritto: true,
      cambi: [],
      id,
    }
  }

  const verificati: CambioVerificato[] = cambi.map((c) => {
    const adesso = riletto.valore.find((x) => x.campo === c.campo)
    const valore = adesso ? adesso.prima : '(non riletto)'
    return { ...c, riletto: valore, confermato: valore === c.dopo }
  })

  const primaInv = invarianti(dati)
  const dopoInv = invarianti(datiDopo)
  const mossi = Object.keys(primaInv).filter((k) => primaInv[k] !== dopoInv[k])

  // I totali li ricalcola Fatture in Cloud dalle righe: cambiano SE e solo se
  // abbiamo toccato le righe. Se si muovono senza che le righe siano state
  // toccate, qualcosa e' successo e va detto.
  const righeToccate = (m.righe?.length ?? 0) > 0
  const totaleMosso = importo(dati.totale) !== importo(datiDopo.totale)

  const nonConfermati = verificati.filter((c) => !c.confermato)
  const coda = [
    `Documento ${dati.numero} del ${datiDopo.data} — ${dati.controparte} (id ${id}).`,
    verificati.map(riga).join('\n'),
    righeToccate
      ? `Totale ricalcolato da Fatture in Cloud: ${importo(dati.totale)} → ${importo(datiDopo.totale)}.`
      : totaleMosso
        ? `⚠️ Il totale e' cambiato (${importo(dati.totale)} → ${importo(datiDopo.totale)}) senza che io abbia toccato le righe: controllalo.`
        : `Totale invariato: ${importo(datiDopo.totale)}.`,
    mossi.length > 0
      ? `⚠️ E' cambiato anche cio' che NON doveva: ${mossi.map((k) => `${k} era «${primaInv[k]}», ora «${dopoInv[k]}»`).join('; ')}.`
      : null,
    'Il documento NON e\' stato trasmesso allo SdI: la trasmissione la fai tu da Fatture in Cloud.',
  ].filter(Boolean).join('\n\n')

  if (nonConfermati.length > 0 || mossi.length > 0 || (!righeToccate && totaleMosso)) {
    return {
      stato: 'da_verificare',
      messaggio: `MODIFICA DA VERIFICARE su ${s.denominazione}: Fatture in Cloud ha risposto ok, ma la RILETTURA non conferma tutto.\n\n${coda}`,
      scritto: true,
      cambi: verificati,
      id,
    }
  }

  return {
    stato: 'modificato',
    messaggio: `DOCUMENTO MODIFICATO su ${s.denominazione}, verificato rileggendolo da Fatture in Cloud.\n\n${coda}`,
    scritto: true,
    cambi: verificati,
    id,
  }
}
