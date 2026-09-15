/**
 * src/lib/fic-pagamenti.ts — segnare PAGATA una fattura RICEVUTA su Fatture in
 * Cloud, e provarlo rileggendola.
 *
 * PERCHE' ESISTE. Il codice sapeva già scrivere un pagamento — lo fa in
 * `creaDocumentoFIC`, costruendo `payments_list` quando EMETTE — ma nessuno
 * l'aveva collegato alle fatture ricevute. Risultato: i pagamenti in CONTANTI
 * non lasciavano traccia da nessuna parte. Nessun movimento bancario da
 * riconciliare, e su Fatture in Cloud il `payment_account` restava **vuoto** —
 * non «contanti»: vuoto, perché nessuno l'aveva mai scritto.
 *
 * COSA DICE L'API (letta, non dedotta — spec ufficiale:
 * https://developers.fattureincloud.it/api-reference/ , sorgente
 * https://github.com/fattureincloud/openapi-fattureincloud):
 *
 *  - `PUT /c/{company_id}/received_documents/{document_id}` è l'unico verbo di
 *    modifica (`modifyReceivedDocument`). Non esiste un PATCH.
 *  - Una voce di `payments_list` è
 *    `{ id, amount, due_date, paid_date, payment_terms:{days,type}, status,
 *       payment_account:{id,name,type,iban,sia,cuc,virtual} }`.
 *  - ⚠️ Per le fatture RICEVUTE lo `status` è tipizzato come stringa libera,
 *    SENZA enum: il valore `paid` viene dall'esempio ufficiale del PUT, e per
 *    le fatture emesse l'enum è `not_paid | paid | reversed`. È l'unico punto
 *    su cui la documentazione non è esplicita, e qui si usa `paid` perché è il
 *    valore che l'esempio dell'API mostra su questo stesso endpoint.
 *  - `paid_date` non è dichiarato obbligatorio dallo schema, ma sulle fatture
 *    emesse porta scritto «[Only if status is paid]»: è il campo che dice
 *    QUANDO. Qui si scrive sempre.
 *  - `payment_account` NON è obbligatorio. Ma è esattamente il campo vuoto che
 *    ha motivato questo lavoro, quindi qui si esige.
 *  - I conti di pagamento dell'azienda si elencano con
 *    `GET /c/{company_id}/info/payment_accounts` (`listPaymentAccounts`).
 *    `GET /c/{company_id}/settings/payment_accounts` NON esiste (quel path
 *    espone solo la POST di creazione).
 *
 * ⚠️ LA SEMANTICA DEL PUT NON E' DOCUMENTATA: non si sa se rimpiazzi il
 * documento intero o accetti un payload parziale. Per questo qui si rispedisce
 * il documento INTERO come riletto, meno i campi di sola lettura, col solo
 * `payments_list` cambiato: è l'unica forma corretta sotto ENTRAMBE le
 * semantiche. E poi si rilegge e si confronta ANCHE quello che non doveva
 * cambiare — fornitore, numero, data, importi: se il PUT fosse una
 * sostituzione integrale e la rilettura ci avesse dato meno campi di quanti ne
 * servono, il danno si vedrebbe lì.
 */

import { ficGet, ficPut, getCompanyId } from './fatture-in-cloud'
import { type CodiceSocieta } from './societa'

export type EsitoFic<T> = { ok: true; valore: T } | { ok: false; error: string }

/** Un conto di pagamento dell'azienda, come lo espone Fatture in Cloud. */
export interface ContoPagamentoFic {
  id: number
  nome: string
}

/** I dati della fattura che l'Ingegnere legge nell'anteprima. */
export interface FatturaRicevuta {
  id: number
  fornitore: string
  numero: string
  data: string
  importo: number
}

export interface FatturaDaSegnarePagata extends FatturaRicevuta {
  /** Data che verrà scritta come `paid_date`. */
  data_pagamento: string
  /** Importo della voce di pagamento che verrà scritta. */
  importo_pagamento: number
  /** Indice nel `payments_list` esistente. `null` = il piano è vuoto, la voce si crea. */
  voce: number | null
  /** Quante voci ha il piano pagamenti oggi. */
  voci: number
}

export interface FatturaEsclusa extends FatturaRicevuta {
  motivo: string
}

/**
 * Campi che NON si rispediscono nel PUT.
 *
 * `amount_gross`, `e_invoice`, `next_due_date`, `attachment_url`,
 * `attachment_preview_url`, `ei_reception_date`, `is_from_pending_expenses`
 * sono dichiarati `readOnly` nello schema. `id`, `created_at`, `updated_at` e
 * `locked` li gestisce il server e l'esempio ufficiale del PUT non li manda.
 */
const CAMPI_NON_SCRIVIBILI = new Set([
  'id',
  'amount_gross',
  'e_invoice',
  'next_due_date',
  'attachment_url',
  'attachment_preview_url',
  'ei_reception_date',
  'is_from_pending_expenses',
  'created_at',
  'updated_at',
  'locked',
])

/**
 * Campi di sola lettura di `IssuedDocument` (schema ufficiale, verificato
 * sull'openapi il 14 set 2026): oltre a quelli delle ricevute, gli importi —
 * che su una fattura EMESSA sono CALCOLATI dalle righe (`amount_net`,
 * `amount_vat`, ritenute, cassa, rivalsa), non scritti — e i campi che vivono
 * dopo l'emissione (`ei_status`, `seen_date`, `permanent_token`, gli url).
 * `amount_due_discount` invece e' SCRIVIBILE e si rispedisce com'e'.
 *
 * ⚠️ Esportato perche' lo usa anche `fic-modifica.ts`, che rispedisce il
 * documento INTERO: due elenchi di campi di sola lettura che possono divergere
 * sarebbero due verita' diverse su cosa Fatture in Cloud accetta.
 */
export const CAMPI_NON_SCRIVIBILI_EMESSA = new Set([
  ...CAMPI_NON_SCRIVIBILI,
  'amount_net',
  'amount_vat',
  'amount_withholding_tax',
  'amount_other_withholding_tax',
  'amount_cassa',
  'amount_cassa2',
  'amount_rivalsa',
  'url',
  'ei_status',
  'seen_date',
  'permanent_token',
  'has_ts_pay_pending_payment',
  'show_tspay_button',
  'dn_url',
  'ai_url',
])

/**
 * Il VERSO di una fattura: ricevuta da un fornitore o emessa a un cliente.
 *
 * Lo stesso motore serve tutti e due (14 set 2026: alle 00:20 il bot aveva
 * abbinato la fattura 19-ED al bonifico da €501,05 e non aveva il verbo per
 * scriverlo). Cambiano tre cose, e stanno tutte qui: l'endpoint, i campi di
 * sola lettura, e la DATA — una ricevuta in contanti si paga al ritiro (data
 * della fattura), un incasso ha la data del BONIFICO e nessun predefinito.
 */
export type Verso = 'ricevuta' | 'emessa'

const VERSI = {
  ricevuta: {
    endpoint: 'received_documents',
    tipo: 'expense',
    controparte: 'fornitore',
    nonScrivibili: CAMPI_NON_SCRIVIBILI,
    dataPredefinita: true,
    /**
     * Le ricevute si rispediscono INTERE, come prima. Non sono mai «locked»
     * (nessuno le trasmette allo SdI: le riceve), funzionano cosi' da sempre, e
     * cambiarle sarebbe rischio gratuito su un percorso che non ha il problema.
     */
    soloPagamenti: false,
  },
  emessa: {
    endpoint: 'issued_documents',
    tipo: 'invoice',
    controparte: 'cliente',
    nonScrivibili: CAMPI_NON_SCRIVIBILI_EMESSA,
    dataPredefinita: false,
    /**
     * 🚨 Sulle EMESSE si manda SOLO il piano pagamenti, e questo cambia tutto.
     *
     * Il 14 settembre 2026, al primo uso vero, FIC ha rifiutato: la fattura
     * 19-ED era gia' stata trasmessa allo SdI, quindi «locked». Il rifiuto e'
     * corretto — una fattura elettronica trasmessa NON si modifica — ma la
     * domanda era sbagliata: **noi non stiamo modificando la fattura, stiamo
     * registrando un incasso**, e dall'interfaccia di FIC si fa senza problemi.
     * Era il fatto di rispedire il documento INTERO a far scattare il blocco.
     *
     * Perche' prima si mandava tutto: il test lo diceva — «la semantica del PUT
     * non e' documentata: cosi' l'esito e' lo stesso sia che sostituisca tutto,
     * sia che accetti un payload parziale». Era prudenza sotto incertezza, ed
     * era ragionevole. Poi l'incertezza si e' sciolta in due modi: la
     * documentazione dichiara supportato l'aggiornamento PARZIALE, e mandare
     * tutto si e' rivelato l'unica forma che NON funziona sulle fatture vere.
     *
     * ⚠️ La rete di sicurezza resta e non si tocca: dopo il PUT la fattura si
     * RILEGGE e `verificaPagamento` controlla che non sia cambiato nient'altro.
     * Se un payload parziale azzerasse qualcosa, il tool lo DICE invece di
     * lasciare una fattura danneggiata in silenzio.
     */
    soloPagamenti: true,
  },
} as const

/** «fornitore» o «cliente»: la parola con cui si nomina la controparte. */
export function controparteDi(verso: Verso): string {
  return VERSI[verso].controparte
}

/** Lo stato che, su una voce del piano pagamenti, significa «pagata». */
export const STATO_PAGATO = 'paid'

/** Tolleranza sui confronti di importo: mezzo centesimo. */
const TOLLERANZA = 0.005

function arrotonda(n: number): number {
  return Math.round(n * 100) / 100
}

function numero(v: unknown): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v.replace(',', '.')) : NaN
  return Number.isFinite(n) ? n : null
}

function testo(v: unknown): string {
  return typeof v === 'string' ? v.trim() : v === null || v === undefined ? '' : String(v)
}

function oggetto(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {}
}

function voci(doc: Record<string, unknown>): Record<string, unknown>[] {
  const lista = doc.payments_list
  return Array.isArray(lista) ? lista.map(oggetto) : []
}

/** Normalizza per il confronto dei nomi: minuscolo, spazi compressi. */
function chiave(s: string): string {
  return s.toLowerCase().replace(/\s+/g, ' ').trim()
}

/**
 * Estrae dal documento i quattro dati che l'Ingegnere legge prima di confermare.
 *
 * Il campo si chiama `fornitore` per storia (il motore è nato per le ricevute);
 * su una fattura EMESSA contiene il CLIENTE. Il numero di una emessa è
 * `number` + `numeration` (19 + "-ED" = "19-ED"), non `invoice_number`.
 */
export function datiFattura(doc: Record<string, unknown>, verso: Verso = 'ricevuta'): FatturaRicevuta {
  const num = verso === 'emessa'
    ? `${testo(doc.number)}${testo(doc.numeration)}`
    : testo(doc.invoice_number)
  return {
    id: numero(doc.id) ?? 0,
    fornitore: testo(oggetto(doc.entity).name) || `(${controparteDi(verso)} non indicato)`,
    numero: num || '(senza numero)',
    data: testo(doc.date),
    importo: arrotonda(numero(doc.amount_gross) ?? 0),
  }
}

/**
 * I conti di pagamento dell'azienda, LETTI DA FATTURE IN CLOUD.
 *
 * Mai una lista scritta a mano qui dentro: i conti li crea l'Ingegnere sul
 * gestionale, e una lista cablata inviterebbe a scegliere un id che su
 * quell'azienda significa un altro conto — o non esiste.
 */
export async function elencoContiPagamentoFic(
  societa: CodiceSocieta,
): Promise<EsitoFic<ContoPagamentoFic[]>> {
  const company = await getCompanyId(societa)
  if (!company.ok) return { ok: false, error: company.error }

  const r = await ficGet(`/c/${company.id}/info/payment_accounts`, undefined, societa)
  if (!r.ok) return { ok: false, error: r.error }

  const lista = Array.isArray(r.data?.data) ? r.data.data as unknown[] : []
  const conti: ContoPagamentoFic[] = []
  for (const riga of lista) {
    const o = oggetto(riga)
    const id = numero(o.id)
    const nome = testo(o.name)
    if (id !== null && nome) conti.push({ id, nome })
  }
  return { ok: true, valore: conti }
}

/**
 * Trova il conto richiesto fra quelli che FIC espone.
 *
 * Non indovina: se la richiesta combacia con più di un conto lo dichiara e
 * chiede, invece di prenderne uno. La modalità di pagamento finisce scritta su
 * un documento fiscale.
 */
export function risolviContoPagamento(
  conti: ContoPagamentoFic[],
  richiesta: string,
): EsitoFic<ContoPagamentoFic> {
  const elenco = conti.map((c) => `${c.nome} (id ${c.id})`).join(', ') || 'nessuno'
  const cercato = chiave(richiesta)
  if (!cercato) {
    return { ok: false, error: `modalita_pagamento richiesta. Conti disponibili su Fatture in Cloud: ${elenco}` }
  }

  const perId = numero(cercato) !== null ? conti.filter((c) => c.id === numero(cercato)) : []
  if (perId.length === 1) return { ok: true, valore: perId[0] }

  const esatti = conti.filter((c) => chiave(c.nome) === cercato)
  if (esatti.length === 1) return { ok: true, valore: esatti[0] }
  if (esatti.length > 1) {
    return { ok: false, error: `"${richiesta}" corrisponde a ${esatti.length} conti di Fatture in Cloud: ${elenco}. Dimmi quale (anche con l'id).` }
  }

  const parziali = conti.filter((c) => chiave(c.nome).includes(cercato))
  if (parziali.length === 1) return { ok: true, valore: parziali[0] }
  if (parziali.length > 1) {
    return {
      ok: false,
      error: `"${richiesta}" corrisponde a ${parziali.length} conti di Fatture in Cloud `
        + `(${parziali.map((c) => `${c.nome} (id ${c.id})`).join(', ')}): dimmi quale, non scelgo io.`,
    }
  }

  return { ok: false, error: `"${richiesta}" non è fra i conti di pagamento di Fatture in Cloud. Disponibili: ${elenco}` }
}

/** Rilegge una fattura, fieldset detailed, dall'endpoint del suo verso. */
export async function leggiFattura(
  id: number,
  societa: CodiceSocieta,
  verso: Verso,
): Promise<EsitoFic<Record<string, unknown>>> {
  const company = await getCompanyId(societa)
  if (!company.ok) return { ok: false, error: company.error }

  const v = VERSI[verso]
  const r = await ficGet(
    `/c/${company.id}/${v.endpoint}/${id}`,
    { type: v.tipo, fieldset: 'detailed' },
    societa,
  )
  const nonEsiste = `la fattura ${verso} ${id} non esiste su Fatture in Cloud`
  if (!r.ok) {
    // Un 404 non è un guasto: è «quella fattura non c'è». Va detto così,
    // perché un «errore FIC 404» manda a cercare un problema che non esiste.
    if (r.error.includes('404')) return { ok: false, error: nonEsiste }
    return { ok: false, error: r.error }
  }
  const doc = oggetto(r.data?.data ?? r.data)
  if (!doc.id) return { ok: false, error: nonEsiste }
  return { ok: true, valore: doc }
}

export function leggiFatturaRicevuta(id: number, societa: CodiceSocieta) {
  return leggiFattura(id, societa, 'ricevuta')
}

export function leggiFatturaEmessa(id: number, societa: CodiceSocieta) {
  return leggiFattura(id, societa, 'emessa')
}

export interface FiltriRicerca {
  fornitore?: string
  anno?: number
  mese?: number
}

/** Massimo di documenti che una sola conferma può coprire. */
export const TETTO_MASSIVO = 50

/** Pagina massima ammessa da FIC: serve poter VEDERE che sono più del tetto. */
const PER_PAGE = 100

/**
 * Quante pagine si cammina al massimo: 1.000 fatture, abbondante per un anno.
 *
 * NON esiste una fonte ufficiale che elenchi i campi filtrabili di
 * `received_documents` (a differenza della grammatica di `q`, che è
 * documentata): `entity.name`/`entity.id` come filtro server-side sarebbero
 * inferenza, non documentazione. Per questo qui si cammina sulle pagine e si
 * filtra il fornitore IN MEMORIA su tutte quelle lette, non solo sulla prima.
 */
const MAX_PAGINE = 10

function filtroData(anno?: number, mese?: number): string | undefined {
  if (!anno) return undefined
  const m = mese && mese >= 1 && mese <= 12 ? mese : undefined
  if (m) {
    const ultimo = new Date(anno, m, 0).getDate()
    const mm = String(m).padStart(2, '0')
    return `date >= '${anno}-${mm}-01' and date <= '${anno}-${mm}-${ultimo}'`
  }
  return `date >= '${anno}-01-01' and date <= '${anno}-12-31'`
}

/**
 * Le fatture ricevute che rientrano nella selezione.
 *
 * `elenco_troncato` non è un dettaglio: se la selezione tocca più pagine di
 * quante ne camminiamo, l'insieme che stiamo mostrando NON è l'insieme che
 * l'Ingegnere ha descritto, e un elenco incompleto che sembra completo è la
 * cosa peggiore che possa precedere una conferma unica per tutte.
 *
 * FIC dà la prima pagina di TUTTE le fatture ricevute del periodo, non solo
 * quelle del fornitore cercato (nessuna fonte ufficiale elenca i campi
 * filtrabili di `received_documents`, quindi non si scommette su un filtro
 * server-side): si cammina sulle pagine fino a un tetto, e si filtra il
 * fornitore IN MEMORIA su TUTTE le pagine lette, non solo sulla prima.
 * `elenco_troncato` guarda la nostra completezza — è vero solo se il tetto di
 * pagine è stato raggiunto E FIC ne dichiara ancora oltre.
 */
export async function cercaFatture(
  filtri: FiltriRicerca,
  societa: CodiceSocieta,
  verso: Verso,
): Promise<EsitoFic<{
  documenti: Record<string, unknown>[]
  /** Vero solo se abbiamo esaurito il tetto di pagine SENZA finire l'elenco. */
  elenco_troncato: boolean
  /** Quante pagine abbiamo letto: va nel messaggio, cosi' il limite e' visibile. */
  pagine_lette: number
}>> {
  const company = await getCompanyId(societa)
  if (!company.ok) return { ok: false, error: company.error }

  const cercato = chiave(filtri.fornitore ?? '')
  const documenti: Record<string, unknown>[] = []
  let pagineLette = 0
  let ultimaPagina = 1

  const v = VERSI[verso]
  for (let pagina = 1; pagina <= MAX_PAGINE; pagina++) {
    const r = await ficGet(`/c/${company.id}/${v.endpoint}`, {
      type: v.tipo,
      q: filtroData(filtri.anno, filtri.mese),
      per_page: PER_PAGE,
      page: pagina,
      sort: '-date',
      fieldset: 'detailed',
    }, societa)
    if (!r.ok) return { ok: false, error: r.error }

    const lista = Array.isArray(r.data?.data) ? (r.data.data as unknown[]).map(oggetto) : []
    pagineLette = pagina
    documenti.push(...(cercato
      ? lista.filter((d) => chiave(testo(oggetto(d.entity).name)).includes(cercato))
      : lista))

    ultimaPagina = numero(oggetto(r.data).last_page) ?? 1
    if (pagina >= ultimaPagina || lista.length === 0) break
  }

  const elenco_troncato = pagineLette >= MAX_PAGINE && ultimaPagina > MAX_PAGINE
  return { ok: true, valore: { documenti, elenco_troncato, pagine_lette: pagineLette } }
}

export function cercaFattureRicevute(filtri: FiltriRicerca, societa: CodiceSocieta) {
  return cercaFatture(filtri, societa, 'ricevuta')
}

export function cercaFattureEmesse(filtri: FiltriRicerca, societa: CodiceSocieta) {
  return cercaFatture(filtri, societa, 'emessa')
}

export interface OpzioniClassifica {
  /** Data di pagamento imposta dall'Ingegnere. Se assente vale la data DELLA FATTURA. */
  data_pagamento?: string
  /** Indice della voce scelta, quando il piano ne ha più di una. Solo sul caso singolo. */
  voce?: number
}

export type Classifica =
  | { stato: 'da_scrivere'; fattura: FatturaDaSegnarePagata }
  | { stato: 'esclusa'; fattura: FatturaEsclusa }

/**
 * Decide se una fattura si può segnare pagata, e con quali valori.
 *
 * Le esclusioni non sono un ripiego: sono la difesa. Una fattura già pagata e
 * una fattura con più voci nel piano NON si toccano, e in nessun caso si
 * scompaiono — chi le esclude le deve elencare.
 *
 * ⚠️ La data di pagamento predefinita è la data DELLA FATTURA, non oggi: i
 * pagamenti in contanti che questo tool esiste per registrare avvengono al
 * ritiro, cioè il giorno della fattura. Scrivere «oggi» falserebbe la data di
 * un movimento contabile, ed è un dato inventato, non un default comodo.
 */
export function classificaFattura(
  doc: Record<string, unknown>,
  opzioni: OpzioniClassifica = {},
  verso: Verso = 'ricevuta',
): Classifica {
  const dati = datiFattura(doc, verso)
  const escludi = (motivo: string): Classifica => ({ stato: 'esclusa', fattura: { ...dati, motivo } })

  /**
   * 🚨 `locked` ESCLUDE SOLO LE RICEVUTE, e questa riga costa due giorni.
   *
   * Qui, fino al 14 settembre 2026, c'era un rifiuto secco per QUALUNQUE
   * documento bloccato: «non è modificabile via API». Sembrava un fatto su
   * Fatture in Cloud. **Era una nostra convinzione mai provata.**
   *
   * Cosa ha combinato: il tool nato apposta per registrare gli incassi delle
   * fatture emesse si rifiutava su **tutte quelle vere** — perché una fattura
   * emessa a un cliente viene trasmessa allo SdI, e da quel momento è `locked`.
   * Il bot riportava all'Ingegnere «FIC impedisce ogni scrittura via API»
   * dicendo «verificato ora», e verificava **questa riga**, non il gestionale.
   * Una richiesta a FIC non è mai partita.
   *
   * ⚠️ Il blocco di FIC è REALE, ma è sul DOCUMENTO: una fattura elettronica
   * trasmessa non si modifica. Registrare un incasso è un'altra cosa — dalla
   * sua interfaccia FIC lo fa senza problemi — e dal 14 set gliene mandiamo
   * solo il piano pagamenti (v. `soloPagamenti` in VERSI), non il documento.
   *
   * Quindi sulle EMESSE si PROVA, e si riporta la risposta VERA di FIC. Se
   * rifiuta, lo dirà lui con le sue parole: sarà una misura, non un'ipotesi
   * travestita da certezza. Se accetta, l'Ingegnere ha indietro un verbo che
   * credeva impossibile.
   *
   * Sulle RICEVUTE l'esclusione resta: lì si rispedisce il documento intero,
   * cioè esattamente quello che su un documento bloccato non si può fare. E una
   * ricevuta `locked` è comunque un caso che nessuno ha mai visto.
   *
   * ⚠️ Provarci non può rovinare niente: il blocco lo fa rispettare FIC, e dopo
   * il PUT la fattura si rilegge (`verificaPagamento`) per accertare che non sia
   * cambiato nient'altro.
   */
  if (doc.locked === true && verso === 'ricevuta') {
    return escludi('è bloccata su Fatture in Cloud (locked): non è modificabile via API')
  }

  const piano = voci(doc)
  const pagate = piano.filter((v) => testo(v.status).toLowerCase() === STATO_PAGATO)
  if (pagate.length > 0) {
    const quando = testo(pagate[0].paid_date)
    return escludi(
      `risulta GIÀ pagata${quando ? ` (pagamento del ${quando})` : ''}: `
      + 'un secondo pagamento sullo stesso documento è un errore contabile',
    )
  }

  // Un incasso su una fattura EMESSA ha la data del bonifico, e nessun
  // predefinito: la data della fattura sarebbe un dato inventato.
  const dataPagamento = testo(opzioni.data_pagamento) || (VERSI[verso].dataPredefinita ? dati.data : '')
  if (!dataPagamento) {
    return escludi(verso === 'emessa'
      ? 'manca la data del bonifico (data_pagamento): un incasso si registra alla data in cui e\' arrivato, non la invento'
      : 'non ha data documento e non mi è stata data una data di pagamento: non la invento')
  }

  if (piano.length > 1) {
    if (opzioni.voce === undefined) {
      const elenco = piano
        .map((v, i) => `#${i + 1} ${numero(v.amount) ?? '?'} scad. ${testo(v.due_date) || '?'} (${testo(v.status) || 'senza stato'})`)
        .join(' · ')
      return escludi(`il piano pagamenti ha ${piano.length} voci e non scelgo io quale segnare pagata: ${elenco}`)
    }
    const i = opzioni.voce - 1
    if (!Number.isInteger(i) || i < 0 || i >= piano.length) {
      return escludi(`la voce ${opzioni.voce} non esiste: il piano pagamenti ha ${piano.length} voci`)
    }
    const importoVoce = numero(piano[i].amount)
    if (importoVoce === null) return escludi(`la voce ${opzioni.voce} del piano pagamenti non ha importo leggibile`)
    return {
      stato: 'da_scrivere',
      fattura: { ...dati, data_pagamento: dataPagamento, importo_pagamento: arrotonda(importoVoce), voce: i, voci: piano.length },
    }
  }

  if (piano.length === 1) {
    const importoVoce = numero(piano[0].amount)
    if (importoVoce === null || importoVoce <= 0) {
      return escludi('l\'unica voce del piano pagamenti non ha un importo leggibile')
    }
    return {
      stato: 'da_scrivere',
      fattura: { ...dati, data_pagamento: dataPagamento, importo_pagamento: arrotonda(importoVoce), voce: 0, voci: 1 },
    }
  }

  // Piano vuoto: la voce si crea, e l'importo deve essere quello VERO.
  const ritenuta = (numero(doc.amount_withholding_tax) ?? 0) + (numero(doc.amount_other_withholding_tax) ?? 0)
  if (Math.abs(ritenuta) > TOLLERANZA) {
    return escludi(
      `ha una ritenuta di ${arrotonda(ritenuta)} e nessun piano pagamenti: l'importo da pagare non è il totale `
      + 'lordo e non lo calcolo io — registra questo pagamento a mano su Fatture in Cloud',
    )
  }
  if (dati.importo <= 0) {
    return escludi('non ha piano pagamenti e il totale del documento non è leggibile: non invento l\'importo')
  }
  return {
    stato: 'da_scrivere',
    fattura: { ...dati, data_pagamento: dataPagamento, importo_pagamento: dati.importo, voce: null, voci: 0 },
  }
}

export function classificaFatturaRicevuta(doc: Record<string, unknown>, opzioni: OpzioniClassifica = {}): Classifica {
  return classificaFattura(doc, opzioni, 'ricevuta')
}

/** Il piano pagamenti da spedire, col pagamento registrato sulla voce scelta. */
export function pianoConPagamento(
  doc: Record<string, unknown>,
  fattura: FatturaDaSegnarePagata,
  conto: ContoPagamentoFic,
): Record<string, unknown>[] {
  const piano = voci(doc)
  const pagamento = {
    status: STATO_PAGATO,
    paid_date: fattura.data_pagamento,
    payment_account: { id: conto.id, name: conto.nome },
  }

  if (fattura.voce === null) {
    return [{
      amount: fattura.importo_pagamento,
      due_date: testo(doc.date) || fattura.data_pagamento,
      ...pagamento,
    }]
  }

  return piano.map((v, i) => (i === fattura.voce
    ? { ...v, amount: fattura.importo_pagamento, due_date: testo(v.due_date) || fattura.data_pagamento, ...pagamento }
    : v))
}

/** Il corpo del PUT: il documento INTERO riletto, meno i campi di sola lettura. */
export function corpoModifica(
  doc: Record<string, unknown>,
  piano: Record<string, unknown>[],
  verso: Verso = 'ricevuta',
): Record<string, unknown> {
  // Sulle emesse basta il piano pagamenti: rispedire il documento intero fa
  // scattare il blocco delle e-fatture trasmesse (v. `soloPagamenti` in VERSI).
  if (VERSI[verso].soloPagamenti) return { payments_list: piano }

  const corpo: Record<string, unknown> = {}
  const nonScrivibili: ReadonlySet<string> = VERSI[verso].nonScrivibili
  for (const [k, v] of Object.entries(doc)) {
    if (!nonScrivibili.has(k)) corpo[k] = v
  }
  const entity = oggetto(doc.entity)
  if (Object.keys(entity).length > 0) {
    const { created_at: _c, updated_at: _u, ...resto } = entity
    void _c; void _u
    corpo.entity = resto
  }
  corpo.payments_list = piano
  return corpo
}

/** I campi che la scrittura di un pagamento NON deve cambiare. */
function invarianti(doc: Record<string, unknown>, verso: Verso): Record<string, string> {
  const dati = datiFattura(doc, verso)
  return {
    [controparteDi(verso)]: dati.fornitore,
    numero: dati.numero,
    data: dati.data,
    totale_netto: String(arrotonda(numero(doc.amount_net) ?? 0)),
    totale_iva: String(arrotonda(numero(doc.amount_vat) ?? 0)),
    totale_lordo: String(arrotonda(numero(doc.amount_gross) ?? 0)),
    // Su una emessa lo stato verso lo SdI e' la cosa che NON deve muoversi:
    // un PUT che lo cambiasse avrebbe toccato la fattura, non il pagamento.
    ...(verso === 'emessa' ? { stato_sdi: testo(doc.ei_status) } : {}),
  }
}

export type Verifica = { ok: true } | { ok: false; motivo: string }

/**
 * Campi che la rilettura puo' legittimamente mostrare diversi: il piano
 * pagamenti (che e' cio' che abbiamo scritto, e si controlla a parte), le
 * date di sistema, gli url temporanei, i flag che FIC deriva dal pagamento.
 */
const VOLATILI = new Set([
  'payments_list',
  'created_at',
  'updated_at',
  'next_due_date',
  'url',
  'attachment_url',
  'attachment_preview_url',
  'dn_url',
  'ai_url',
  'seen_date',
  'permanent_token',
  'has_ts_pay_pending_payment',
  'show_tspay_button',
  'is_marked',
])

/**
 * Forma canonica per il confronto: chiavi ordinate, `null`/`undefined`/''
 * assenti, numeri (anche scritti come stringa) arrotondati al centesimo, date
 * di sistema tolte a ogni profondita'. Serve a confrontare cio' che CONTA,
 * non come FIC lo serializza.
 */
function canonico(v: unknown): unknown {
  if (v === null || v === undefined || v === '') return undefined
  if (typeof v === 'number') return Math.round(v * 100) / 100
  if (typeof v === 'string') {
    return /^-?\d+([.,]\d+)?$/.test(v.trim()) ? Math.round(Number(v.trim().replace(',', '.')) * 100) / 100 : v
  }
  if (Array.isArray(v)) return v.map(canonico)
  if (typeof v === 'object') {
    const o: Record<string, unknown> = {}
    for (const k of Object.keys(v as object).sort()) {
      if (k === 'created_at' || k === 'updated_at') continue
      const c = canonico((v as Record<string, unknown>)[k])
      if (c !== undefined) o[k] = c
    }
    return o
  }
  return v
}

/**
 * Tutto cio' che e' cambiato fra prima e dopo FUORI dal pagamento scritto.
 *
 * La semantica del PUT non e' documentata: la rilettura e' l'unica prova, e
 * sette campi nominati non bastano — una riga sparita con totali uguali, o
 * `ei_data` alterato, passerebbero. Qui si confronta il documento INTERO,
 * meno i volatili, e del piano pagamenti le voci NON toccate.
 */
export function campiCambiati(
  prima: Record<string, unknown>,
  dopo: Record<string, unknown>,
  voce: number | null,
): string[] {
  const cambiati: string[] = []
  const chiavi = new Set([...Object.keys(prima), ...Object.keys(dopo)].filter((k) => !VOLATILI.has(k)))
  for (const k of [...chiavi].sort()) {
    if (JSON.stringify(canonico(prima[k])) !== JSON.stringify(canonico(dopo[k]))) cambiati.push(k)
  }
  const p = voci(prima)
  const d = voci(dopo)
  if (voce === null) {
    if (p.length !== 0 || d.length !== 1) cambiati.push(`payments_list (voci: ${p.length} → ${d.length}, attese 0 → 1)`)
  } else if (p.length !== d.length) {
    cambiati.push(`payments_list (voci: ${p.length} → ${d.length})`)
  } else {
    p.forEach((v, i) => {
      if (i !== voce && JSON.stringify(canonico(v)) !== JSON.stringify(canonico(d[i]))) {
        cambiati.push(`payments_list[${i + 1}] (voce non toccata)`)
      }
    })
  }
  return cambiati
}

/**
 * La parte più importante di tutto il tool: l'esito si legge dalla RILETTURA,
 * non dalla risposta della PUT.
 *
 * Controlla due cose distinte: che il pagamento ci sia davvero, e che tutto il
 * resto del documento sia rimasto come prima. Il secondo controllo esiste
 * perché la semantica del PUT non è documentata: se fosse una sostituzione
 * integrale e la rilettura avesse restituito meno campi del necessario, il
 * danno comparirebbe proprio qui.
 */
export function verificaPagamento(
  primaDoc: Record<string, unknown>,
  dopoDoc: Record<string, unknown>,
  fattura: FatturaDaSegnarePagata,
  conto: ContoPagamentoFic,
  verso: Verso = 'ricevuta',
): Verifica {
  const prima = invarianti(primaDoc, verso)
  const dopo = invarianti(dopoDoc, verso)
  for (const campo of Object.keys(prima)) {
    if (prima[campo] !== dopo[campo]) {
      return {
        ok: false,
        motivo: `l'API ha risposto ok ma rileggendo il documento è CAMBIATO ${campo}: era "${prima[campo]}", ora "${dopo[campo]}". Controlla la fattura su Fatture in Cloud.`,
      }
    }
  }

  const altro = campiCambiati(primaDoc, dopoDoc, fattura.voce)
  if (altro.length > 0) {
    return {
      ok: false,
      motivo: `l'API ha risposto ok ma rileggendo il documento è CAMBIATO fuori dal pagamento: ${altro.join(', ')}. `
        + 'Controlla la fattura su Fatture in Cloud (righe, totali, dati SdI).',
    }
  }

  const piano = voci(dopoDoc)
  const pagata = piano.find((v) => {
    if (testo(v.status).toLowerCase() !== STATO_PAGATO) return false
    if (testo(v.paid_date) !== fattura.data_pagamento) return false
    const importo = numero(v.amount)
    if (importo === null || Math.abs(importo - fattura.importo_pagamento) > TOLLERANZA) return false
    return numero(oggetto(v.payment_account).id) === conto.id
  })

  if (!pagata) {
    const visto = piano.length === 0
      ? 'il piano pagamenti è vuoto'
      : piano
        .map((v) => `[${testo(v.status) || 'senza stato'} ${numero(v.amount) ?? '?'} paid_date ${testo(v.paid_date) || '—'} conto ${testo(oggetto(v.payment_account).name) || '—'}]`)
        .join(' ')
    return {
      ok: false,
      motivo: `l'API ha risposto ok ma rileggendo il pagamento non risulta: atteso ${fattura.importo_pagamento} `
        + `del ${fattura.data_pagamento} su "${conto.nome}"; riletto ${visto}.`,
    }
  }

  return { ok: true }
}

export type EsitoScrittura = { ok: true } | { ok: false; motivo: string }

/**
 * Scrive il pagamento su UNA fattura e lo verifica rileggendola.
 *
 * Rilegge il documento prima di scrivere anche se il chiamante lo ha già
 * letto: fra l'anteprima e la conferma passa del tempo, e nel frattempo quella
 * fattura può essere stata pagata da FIC o dall'Ingegnere. La classificazione
 * si rifà su ciò che c'è ADESSO.
 */
export async function segnaPagataFattura(
  id: number,
  conto: ContoPagamentoFic,
  opzioni: OpzioniClassifica,
  societa: CodiceSocieta,
  verso: Verso,
): Promise<EsitoScrittura & { fattura?: FatturaRicevuta }> {
  const prima = await leggiFattura(id, societa, verso)
  if (!prima.ok) return { ok: false, motivo: prima.error }

  const classifica = classificaFattura(prima.valore, opzioni, verso)
  if (classifica.stato === 'esclusa') {
    return { ok: false, motivo: classifica.fattura.motivo, fattura: classifica.fattura }
  }
  const fattura = classifica.fattura

  const company = await getCompanyId(societa)
  if (!company.ok) return { ok: false, motivo: company.error, fattura }

  const piano = pianoConPagamento(prima.valore, fattura, conto)
  const scritto = await ficPut(
    `/c/${company.id}/${VERSI[verso].endpoint}/${id}`,
    corpoModifica(prima.valore, piano, verso),
    societa,
  )
  if (!scritto.ok) return { ok: false, motivo: scritto.error, fattura }

  // La risposta della PUT NON e' la prova: si rilegge.
  const dopo = await leggiFattura(id, societa, verso)
  if (!dopo.ok) {
    return {
      ok: false,
      motivo: `l'API ha risposto ok ma non riesco a rileggere la fattura per verificarlo (${dopo.error}): controllala su Fatture in Cloud.`,
      fattura,
    }
  }

  const verifica = verificaPagamento(prima.valore, dopo.valore, fattura, conto, verso)
  if (!verifica.ok) return { ok: false, motivo: verifica.motivo, fattura }
  return { ok: true, fattura }
}

export function segnaPagataFatturaRicevuta(id: number, conto: ContoPagamentoFic, opzioni: OpzioniClassifica, societa: CodiceSocieta) {
  return segnaPagataFattura(id, conto, opzioni, societa, 'ricevuta')
}

export function segnaPagataFatturaEmessa(id: number, conto: ContoPagamentoFic, opzioni: OpzioniClassifica, societa: CodiceSocieta) {
  return segnaPagataFattura(id, conto, opzioni, societa, 'emessa')
}
