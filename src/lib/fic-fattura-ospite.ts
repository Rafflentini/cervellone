/**
 * src/lib/fic-fattura-ospite.ts — LA FATTURA AL CLIENTE PER UN SOGGIORNO
 * prenotato su Booking, su Fatture in Cloud, per LA REAL ESTATE SRLS.
 *
 * ⛔ **QUI NON SI TRASMETTE NIENTE ALLO SdI.** Il documento nasce elettronico
 * (senza `e_invoice: true` su Fatture in Cloud non compare nemmeno il tasto per
 * mandarlo) e resta fermo: l'invio lo fa l'Ingegnere, a mano, dopo averlo
 * guardato. Subito dopo la creazione si chiama `verificaFormaleXml`, che e' una
 * GET in SOLA LETTURA (v. `fic-verifica-formale.ts`): chiede a Fatture in Cloud
 * se quell'XML passerebbe i controlli dello SdI. Se risponde «errori», il tool
 * NON dichiara successo — restituisce id ed errori testuali.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * 🚨 IL METODO: RISPECCHIARE, NON DEDURRE.
 *
 * Ogni campo di questo file viene da UNO DEI DUE DOCUMENTI VERI creati e
 * verificati sul gestionale il 15 settembre 2026:
 *
 *  - fattura 20/2026, cliente ITALIANO (`issued_documents/552778017`);
 *  - fattura 3/2026, cliente FRANCESE (`issued_documents/552770272`).
 *
 * Cio' che non sta in quei due documenti e non sta sulla documentazione
 * ufficiale di Fatture in Cloud non e' qui dentro: sta nel rapporto, sotto «da
 * verificare». I due modelli sono rispecchiati campo per campo in
 * `fic-fattura-ospite.rispecchiamento.test.ts`, che e' il posto dove la
 * differenza fra il caso italiano e quello estero si VEDE invece di doverla
 * ricordare.
 *
 * ⚠️ **Le tre trappole che i modelli hanno smentito**, e che senza di loro
 * avremmo sbagliato tutte e tre:
 *
 *  1. `payment_method` a livello di DOCUMENTO e' vuoto (`{id: null, name: ""}`).
 *     Il bonifico sta SOLO in `ei_data.payment_method: "MP05"`. La specifica
 *     diceva «metodo Bonifico, id dal modello»: il modello dice che non c'e'.
 *     Qui non si scrive, e il test di rispecchiamento fallisce se ricompare.
 *  2. `extra_data.revenue_detect` e' **`true`** — al contrario
 *     dell'integrazione TD17 (`RILEVAZIONI_INTEGRAZIONE` in
 *     `fic-write-tools.ts`), dove vale `false`. Una fattura al cliente E' un
 *     ricavo.
 *  3. `numeration` e' la STRINGA VUOTA (numerazione Principale), non
 *     «Principale».
 *
 * ⚠️ **E la quarta, letta sul modello estero**: `tax_code` sull'anagrafica
 * straniera NON c'e' proprio — non e' stringa vuota, e' la chiave assente.
 * Spedire `tax_code: ""` a Fatture in Cloud non e' «lascia stare»: e'
 * «cancella quello che c'e'» (stessa ragione di `identitaFiscale` in
 * `fic-write-tools.ts`).
 *
 * ────────────────────────────────────────────────────────────────────────────
 * 🚨 IL DIVIETO DEL GARANTE (provvedimento 29/04/2026).
 *
 * In Fatture in Cloud NON si scrivono MAI la data e il luogo di nascita degli
 * ospiti, e non si allegano copie di documenti. Le date di nascita servono solo
 * QUI IN MEMORIA, per contare quanti adulti e quanti bambini scrivere nella
 * descrizione della riga. Il punto in cui sarebbe comodo violarlo e'
 * `contaOspiti()`, e li' il divieto e' ripetuto per esteso.
 */

import { ficGet, getCompanyId, creaDocumentoFIC } from './fatture-in-cloud'
import { getSocieta, type CodiceSocieta } from './societa'
import { elencoAliquoteFic } from './fic-aliquote'
import { cercaFattureEmesse, elencoContiPagamentoFic } from './fic-pagamenti'
import { verificaFormaleXml, rigaVerificaFormale } from './fic-verifica-formale'
import { validaCodiceFiscale } from './checkin/valida-codice-fiscale'

/* ------------------------------------------------------------------ *
 * Le costanti LETTE DAI MODELLI
 * ------------------------------------------------------------------ */

/**
 * 🚨 Gli id che si leggono nei due documenti veri, e che NON vanno indovinati
 * altrove.
 *
 * Non sono un predefinito comodo: sono il RIPIEGO per quando Fatture in Cloud
 * non si lascia interrogare. La strada normale e' `risolviIdFic()`, che li
 * legge da `settings/vat_types` e `info/payment_accounts`. Se quella lettura
 * non riesce si usano questi — e l'esito lo DICE, perche' un id preso da un
 * documento di settembre potrebbe non essere piu' l'id di domani.
 */
export const ID_MODELLO = {
  /** Aliquota 10% — `vat.id 3` su entrambi i modelli. */
  aliquota10: 3,
  /** Natura N1 «Iva esclusa ex art. 15» — `vat.id 15819187`. */
  naturaArt15: 15819187,
  /** Conto BANCA MONTEPRUNO — dove arriva l'incasso Booking. */
  contoBanca: 1570742,
  /** Conto Contanti — dove entra l'imposta di soggiorno riscossa in struttura. */
  contoContanti: 1565608,
} as const

/** L'aliquota dell'alloggio in struttura ricettiva extralberghiera. */
export const ALIQUOTA_ALLOGGIO = 10

/**
 * Il metodo di pagamento SdI: MP05, bonifico. Sta SOLO in `ei_data`.
 * V. trappola 1 nell'intestazione.
 */
export const METODO_PAGAMENTO_SDI = 'MP05'

/**
 * 🚨 `revenue_detect: true` — v. trappola 2. Sull'integrazione TD17 vale
 * `false`; qui e' un RICAVO, e va rilevato.
 */
export const RILEVAZIONI_FATTURA_OSPITE = { debt_vat_detect: true, revenue_detect: true } as const

/** Il tipo FIC di una fattura di vendita. */
export const TIPO_FIC_FATTURA = 'invoice'

/** Il TipoDocumento SdI di una fattura ordinaria: si CONTROLLA nella rilettura. */
export const TIPO_DOCUMENTO_SDI_FATTURA = 'TD01'

/**
 * Codice destinatario di un cliente ESTERO. Letto dal modello francese.
 * (Quello di un privato italiano senza canale telematico e' `0000000`, sette
 * zeri, letto dal modello italiano: lo porta l'anagrafica, non questo file.)
 */
export const EI_CODE_ESTERO = 'XXXXXXX'

/**
 * Codice destinatario di un PRIVATO italiano senza canale telematico: sette
 * zeri, letti sul modello italiano.
 *
 * ⚠️ Lo schema di `fic_crea_cliente` (fic-anagrafica.ts) ne dichiara DIECI. Non
 * lo tocco da qui — non e' il mio tool — ma il documento vero ne porta sette, e
 * sette e' il codice destinatario di un privato. Sta nel rapporto.
 */
export const EI_CODE_PRIVATO_ITALIANO = '0000000'

/** CAP e provincia convenzionali di un'anagrafica estera. Letti dal modello. */
export const CAP_ESTERO = '00000'
export const PROVINCIA_ESTERO = 'EE'

/** Mezzo centesimo: la tolleranza con cui si confrontano gli importi. */
const TOLLERANZA = 0.005

/* ------------------------------------------------------------------ *
 * Formattazione — le parole che finiscono sul documento fiscale
 * ------------------------------------------------------------------ */

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function testo(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const t = value.trim()
  return t ? t : undefined
}

function numero(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value !== 'string') return null
  const pulito = value.trim().replace(/\s/g, '').replace(/\.(?=\d{3}\b)/g, '').replace(',', '.')
  if (!pulito) return null
  const n = Number(pulito)
  return Number.isFinite(n) ? n : null
}

function centesimi(n: number): number {
  return Math.round(n * 100) / 100
}

/** 'aaaa-mm-gg' -> 'gg/mm/aaaa'. Vuoto se la data non ha la forma attesa. */
export function ggmmaaaa(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || '').trim())
  return m ? `${m[3]}/${m[2]}/${m[1]}` : ''
}

/** Importo all'italiana con due decimali: 1.5 -> «1,50». */
export function euroIt(n: number): string {
  return centesimi(n).toFixed(2).replace('.', ',')
}

/**
 * «1 notte» / «3 notti».
 *
 * 🚨 Il singolare non e' cosmetico: la descrizione della riga e' testo che
 * finisce su un documento fiscale, e «1 notti» e' l'errore che si nota subito
 * quando lo legge il cliente e mai quando lo scrive un programma.
 */
export function plurale(n: number, singolare: string, plurale: string): string {
  return `${n} ${n === 1 ? singolare : plurale}`
}

const MS_GIORNO = 86_400_000

/** Notti fra check-in e check-out. `null` se le date non si leggono o non crescono. */
export function contaNotti(checkIn: string, checkOut: string): number | null {
  const a = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(checkIn || '').trim())
  const b = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(checkOut || '').trim())
  if (!a || !b) return null
  const da = Date.UTC(Number(a[1]), Number(a[2]) - 1, Number(a[3]))
  const al = Date.UTC(Number(b[1]), Number(b[2]) - 1, Number(b[3]))
  const notti = Math.round((al - da) / MS_GIORNO)
  return notti > 0 ? notti : null
}

/**
 * Conta adulti e bambini dalle date di nascita, alla data del CHECK-IN.
 *
 * 🚨🚨 **QUI SAREBBE COMODO VIOLARE IL DIVIETO DEL GARANTE.** Le date di
 * nascita arrivano fin qui perche' senza non si sa scrivere «2 adulti, 1
 * bambino». Da questa funzione esce SOLO una coppia di numeri: le date NON
 * entrano in nessun payload, in nessuna nota, in nessuna descrizione, e non
 * vanno aggiunte «per comodita' di controllo». Provvedimento del Garante del
 * 29/04/2026: in Fatture in Cloud non si scrivono data e luogo di nascita degli
 * ospiti, e non si allegano copie di documenti.
 *
 * ⚠️ «Adulto» qui vuol dire MAGGIORENNE AL CHECK-IN. E' una scelta di questo
 * file, non un dato letto dai modelli: i due documenti veri dicono «2 adulti, 1
 * bambino» e «2 adulti, 2 bambini» senza dire con quale soglia siano stati
 * contati. Chi passa direttamente `adulti` e `bambini` scavalca questa scelta.
 * ⚠️ E NON e' la soglia dell'imposta di soggiorno, che ha la sua (v.
 * `REGOLE_MARATEA.esenzioneEtaMax` in `checkin/imposta-soggiorno.ts`): le due
 * cose si somigliano e non sono la stessa, e confonderle metterebbe in fattura
 * un conteggio di persone diverso da quello dell'imposta.
 */
export function contaOspiti(dateNascita: string[], checkIn: string): { adulti: number; bambini: number } {
  const rif = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(checkIn || '').trim())
  let adulti = 0
  let bambini = 0
  for (const d of dateNascita) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(d || '').trim())
    // Una data illeggibile non diventa un bambino di nascosto: si conta adulto,
    // che e' il caso normale, e lo squilibrio si vede nell'anteprima.
    if (!m || !rif) { adulti++; continue }
    const nascita = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
    const diciottesimo = Date.UTC(Number(m[1]) + 18, Number(m[2]) - 1, Number(m[3]))
    void nascita
    if (Date.UTC(Number(rif[1]), Number(rif[2]) - 1, Number(rif[3])) >= diciottesimo) adulti++
    else bambini++
  }
  return { adulti, bambini }
}

/* ------------------------------------------------------------------ *
 * I dati in ingresso
 * ------------------------------------------------------------------ */

export interface OspiteFattura {
  nome: string
  /** Solo per i clienti ITALIANI. Sull'estero la chiave non si manda affatto. */
  codice_fiscale?: string
  indirizzo: string
  cap?: string
  citta: string
  provincia?: string
  /** Nazione per esteso, come nei modelli: «Italia», «Francia». */
  paese: string
  /** Numero di passaporto: finisce nelle NOTE, solo se chi chiama lo passa. */
  passaporto?: string
  /** Codice destinatario SdI. Per l'estero vale `XXXXXXX`. */
  codice_destinatario?: string
  email?: string
}

export interface ImpostaSoggiornoFattura {
  importo: number
  persone: number
  notti: number
  tariffa: number
}

export interface DatiFatturaOspite {
  unita: string
  indirizzo_unita: string
  check_in: string
  check_out: string
  notti: number
  prenotazione: string
  /** LORDO Booking: alloggio + pulizie, IVA inclusa, commissione INCLUSA. */
  prezzo: number
  adulti: number
  bambini: number
  /** Data del DOCUMENTO. */
  data: string
  ospite: OspiteFattura
  estero: boolean
  cliente_id?: number
  imposta: ImpostaSoggiornoFattura | null
}

function ospiti(d: { adulti: number; bambini: number }): number {
  return d.adulti + d.bambini
}

/** «2 adulti, 1 bambino». Le parti a zero non si scrivono. */
function composizione(d: { adulti: number; bambini: number }): string {
  const parti: string[] = []
  if (d.adulti > 0) parti.push(plurale(d.adulti, 'adulto', 'adulti'))
  if (d.bambini > 0) parti.push(plurale(d.bambini, 'bambino', 'bambini'))
  return parti.join(', ')
}

/** «Soggiorno Blue Maison 1 dal 19/08/2026 al 22/08/2026». */
export function nomeRigaSoggiorno(d: DatiFatturaOspite): string {
  return `Soggiorno ${d.unita} dal ${ggmmaaaa(d.check_in)} al ${ggmmaaaa(d.check_out)}`
}

/** L'oggetto VISIBILE del documento. `subject` resta vuoto: v. `costruisciPayload`. */
export function oggettoFattura(d: DatiFatturaOspite): string {
  return `${nomeRigaSoggiorno(d)} - prenotazione Booking.com n. ${d.prenotazione}`
}

export function descrizioneRigaSoggiorno(d: DatiFatturaOspite): string {
  const chi = composizione(d)
  return `Servizio di alloggio in casa vacanze ${d.unita}, ${d.indirizzo_unita} - `
    + `${plurale(d.notti, 'notte', 'notti')}, ${plurale(ospiti(d), 'ospite', 'ospiti')}`
    + `${chi ? ` (${chi})` : ''} - prenotazione Booking.com n. ${d.prenotazione}. `
    + 'Pulizia finale inclusa. Imposta di soggiorno esclusa.'
}

/** Il nome della riga 2, identico su entrambi i modelli. */
export const NOME_RIGA_IMPOSTA = 'Imposta di soggiorno Comune di Maratea'

/**
 * ⚠️ La frase finale («Somma esclusa dalla base imponibile...») compare su uno
 * dei due modelli e non sull'altro: l'Ingegnere ha ritoccato le descrizioni a
 * mano. Si TIENE — e' la formula corretta, e sta gia' nelle note del documento.
 */
export function descrizioneRigaImposta(d: DatiFatturaOspite, imposta: ImpostaSoggiornoFattura): string {
  return 'Imposta di soggiorno riscossa in struttura per conto del Comune di Maratea: '
    + `${plurale(imposta.persone, 'persona', 'persone')} x ${plurale(imposta.notti, 'notte', 'notti')} `
    + `x ${euroIt(imposta.tariffa)} euro - prenotazione Booking.com n. ${d.prenotazione}. `
    + 'Somma esclusa dalla base imponibile IVA ai sensi dell\'art. 15 c.1 n. 3 DPR 633/72.'
}

export function noteFattura(d: DatiFatturaOspite): string {
  const parti = [
    `Importo incassato tramite Booking.com (Pagamenti tramite Booking.com) - prenotazione n. ${d.prenotazione}.`,
    `Prestazione di alloggio in struttura ricettiva extralberghiera, IVA ${ALIQUOTA_ALLOGGIO}% inclusa nel prezzo.`,
  ]
  if (d.imposta && d.imposta.importo > 0) {
    parti.push(
      'Imposta di soggiorno riscossa in contanti in struttura e riversata al Comune di Maratea '
      + '(esclusa art. 15 DPR 633/72).',
    )
  }
  // ⚠️ DA VERIFICARE. La specifica dell'Ingegnere chiede il passaporto nelle
  // note del cliente estero; la rilettura del modello francese che ho in mano
  // NON espone il campo `notes`, quindi questa frase non e' rispecchiata da un
  // documento vero — e' costruita. Per questo si scrive SOLO se chi chiama
  // passa `passaporto`, e l'anteprima la mostra prima della conferma.
  // 🚨 Il passaporto e' un NUMERO di documento: non e' ne' la data ne' il luogo
  // di nascita, e non e' la COPIA di un documento. Il divieto del Garante non
  // lo tocca. Data e luogo di nascita restano fuori, sempre.
  const passaporto = d.ospite.passaporto
  if (passaporto) parti.push(`Cliente estero: passaporto n. ${passaporto}.`)
  return parti.join(' ')
}

/* ------------------------------------------------------------------ *
 * Gli id VERI di Fatture in Cloud
 * ------------------------------------------------------------------ */

export interface IdFic {
  aliquota10: number
  naturaArt15: number
  contoBanca: number
  contoContanti: number
  /** Cosa NON si e' potuto leggere da FIC. Va DETTO nell'anteprima e nell'esito. */
  avvisi: string[]
}

function aliquotaDi(row: Record<string, unknown>): number | null {
  return numero(row.value)
}

/**
 * 🚨 L'IVA E I CONTI NON SI INDOVINANO.
 *
 * Gli id stanno nei due modelli, ma un id e' una chiave di QUELL'azienda su
 * QUEL gestionale: si legge da Fatture in Cloud almeno una volta, e il modello
 * serve solo a riconoscere la riga giusta fra quelle lette.
 *
 * ⚠️ Due esiti diversi, tenuti distinti di proposito:
 *  - la LETTURA non riesce (token, rete, 429) -> si ripiega sugli id del
 *    modello e si DICHIARA. Fermarsi qui vorrebbe dire non saper fatturare un
 *    soggiorno perche' un endpoint di consultazione ha singhiozzato.
 *  - la lettura RIESCE ma la riga non c'e' -> si RIFIUTA. Qui il ripiego
 *    scriverebbe su un documento fiscale un'aliquota che quell'azienda non ha:
 *    e' il guasto che invece di chiudere APRE.
 */
export async function risolviIdFic(
  societa: CodiceSocieta,
): Promise<{ ok: true; ids: IdFic } | { ok: false; error: string }> {
  const avvisi: string[] = []
  let aliquota10: number = ID_MODELLO.aliquota10
  let naturaArt15: number = ID_MODELLO.naturaArt15
  let contoBanca: number = ID_MODELLO.contoBanca
  let contoContanti: number = ID_MODELLO.contoContanti

  const aliquote = await elencoAliquoteFic(societa)
  if (!aliquote.ok) {
    avvisi.push(
      `⚠️ Le aliquote IVA NON si sono lette da Fatture in Cloud (${aliquote.error}): uso gli id del modello `
      + `(${ALIQUOTA_ALLOGGIO}% = ${ID_MODELLO.aliquota10}, natura art. 15 = ${ID_MODELLO.naturaArt15}). `
      + 'Controlla sul gestionale che siano ancora quelli.',
    )
  } else {
    const dieci = aliquote.righe.filter((r) => {
      const v = aliquotaDi(r)
      return v !== null && Math.abs(v - ALIQUOTA_ALLOGGIO) < 0.001
    })
    if (dieci.length === 0) {
      const viste = aliquote.righe.map((r) => `${aliquotaDi(r) ?? '?'}%`).join(', ') || 'nessuna'
      return { ok: false, error: `su Fatture in Cloud non c'e' l'aliquota ${ALIQUOTA_ALLOGGIO}% (viste: ${viste}). Non compilo niente.` }
    }
    const preferita = dieci.find((r) => numero(r.id) === ID_MODELLO.aliquota10) ?? dieci[0]
    aliquota10 = numero(preferita.id) ?? ID_MODELLO.aliquota10

    // La natura N1 ha valore 0 come OGNI altra natura: si riconosce dalla
    // descrizione, non dal valore. Per questo l'elenco serve intero.
    const nature = aliquote.righe.filter((r) => {
      const v = aliquotaDi(r)
      if (v === null || Math.abs(v) > 0.001) return false
      const desc = `${testo(r.description) ?? ''}`.toLowerCase()
      return /art\.?\s*15/.test(desc)
    })
    if (nature.length === 0) {
      return {
        ok: false,
        error: 'su Fatture in Cloud non trovo la natura «Iva esclusa ex art. 15» (IVA 0 con «art. 15» nella descrizione): '
          + 'l\'imposta di soggiorno finirebbe con la natura sbagliata. Non compilo niente.',
      }
    }
    const naturaPreferita = nature.find((r) => numero(r.id) === ID_MODELLO.naturaArt15) ?? nature[0]
    naturaArt15 = numero(naturaPreferita.id) ?? ID_MODELLO.naturaArt15
  }

  const conti = await elencoContiPagamentoFic(societa)
  if (!conti.ok) {
    avvisi.push(
      `⚠️ I conti di pagamento NON si sono letti da Fatture in Cloud (${conti.error}): uso gli id del modello `
      + `(incasso ${ID_MODELLO.contoBanca}, contanti ${ID_MODELLO.contoContanti}). Controllali sul gestionale.`,
    )
  } else {
    const perId = (id: number) => conti.valore.find((c) => c.id === id)
    const perNome = (frammento: string) =>
      conti.valore.filter((c) => c.nome.toLowerCase().includes(frammento))
    const elenco = conti.valore.map((c) => `${c.nome} (id ${c.id})`).join(', ') || 'nessuno'

    const banca = perId(ID_MODELLO.contoBanca) ?? (perNome('montepruno').length === 1 ? perNome('montepruno')[0] : undefined)
    if (!banca) {
      return { ok: false, error: `il conto dell'incasso (id ${ID_MODELLO.contoBanca}, BANCA MONTEPRUNO) non e' fra i conti di Fatture in Cloud: ${elenco}. Non compilo niente.` }
    }
    contoBanca = banca.id

    const cassa = perId(ID_MODELLO.contoContanti) ?? (perNome('contanti').length === 1 ? perNome('contanti')[0] : undefined)
    if (!cassa) {
      return { ok: false, error: `il conto Contanti (id ${ID_MODELLO.contoContanti}) non e' fra i conti di Fatture in Cloud: ${elenco}. Non compilo niente.` }
    }
    contoContanti = cassa.id
  }

  return { ok: true, ids: { aliquota10, naturaArt15, contoBanca, contoContanti, avvisi } }
}

/* ------------------------------------------------------------------ *
 * IL PAYLOAD — la funzione che il test di rispecchiamento confronta
 * ------------------------------------------------------------------ */

/**
 * L'anagrafica come finisce SUL DOCUMENTO.
 *
 * 🚨 Sull'ESTERO `tax_code` non e' la stringa vuota: la chiave non c'e'. Letto
 * sul modello francese, e non e' un dettaglio — spedire un campo vuoto a FIC
 * vuol dire cancellare quello che c'e'.
 */
export function costruisciEntity(d: DatiFatturaOspite): Record<string, unknown> {
  const o = d.ospite
  const entity: Record<string, unknown> = {}
  if (d.cliente_id !== undefined) entity.id = d.cliente_id
  entity.name = o.nome
  if (!d.estero && o.codice_fiscale) entity.tax_code = o.codice_fiscale
  entity.address_street = o.indirizzo
  entity.address_postal_code = d.estero ? CAP_ESTERO : (o.cap ?? '')
  entity.address_city = o.citta
  entity.address_province = d.estero ? PROVINCIA_ESTERO : (o.provincia ?? '')
  entity.country = o.paese
  entity.ei_code = o.codice_destinatario ?? (d.estero ? EI_CODE_ESTERO : EI_CODE_PRIVATO_ITALIANO)
  return entity
}

/**
 * Il documento da spedire a `POST /issued_documents`.
 *
 * ⚠️ **`use_gross_prices: true` e `gross_price` sulle righe.** I prezzi di
 * Booking sono LORDI e FIC scorpora: si passa il lordo e si lascia calcolare a
 * lui il netto. Per questo qui NON si scrive `net_price` — quello che i modelli
 * riportano (469,36364 su 516,30) e' il netto CALCOLATO da Fatture in Cloud,
 * con una precisione che non si riproduce a mano senza indovinare il suo
 * arrotondamento. Che il conto sia tornato lo dice la RILETTURA, non noi.
 *
 * ⚠️ Quello che NON si manda, e che i modelli riportano perche' FIC lo scrive
 * da se': `amount_net`, `amount_vat`, `amount_gross`, `number`, `year`,
 * `currency`, `ei_raw` (TD01 lo deriva dal tipo), `ei_status`, `locked`,
 * `rc_center`, `stamp_duty` e la fila di `amount_*` a zero.
 */
export function costruisciPayloadFatturaOspite(
  d: DatiFatturaOspite,
  ids: IdFic,
): Record<string, unknown> {
  const items: Record<string, unknown>[] = [{
    name: nomeRigaSoggiorno(d),
    qty: 1,
    vat: { id: ids.aliquota10 },
    description: descrizioneRigaSoggiorno(d),
    gross_price: centesimi(d.prezzo),
  }]

  const pagamenti: Record<string, unknown>[] = [{
    amount: centesimi(d.prezzo),
    due_date: d.data,
    // Il soggiorno e' incassato al CHECK-OUT: e' la data che Booking usa per il
    // versamento, e sta cosi' su entrambi i modelli.
    paid_date: d.check_out,
    status: 'paid',
    payment_account: { id: ids.contoBanca },
  }]

  // 🚨 La riga 2 esiste SOLO se l'imposta c'e' davvero. Una riga da zero euro
  // su una fattura elettronica non e' innocua: e' una voce in piu' da spiegare.
  if (d.imposta && d.imposta.importo > 0) {
    items.push({
      name: NOME_RIGA_IMPOSTA,
      qty: 1,
      // ⚠️ Qui va la natura N1 («Iva esclusa ex art. 15»). Dall'interfaccia di
      // Fatture in Cloud la spunta «anticipazione» mette da sola **N4**, che e'
      // SBAGLIATO: N4 sono le operazioni ESENTI, l'imposta di soggiorno e'
      // ESCLUSA dalla base imponibile. Qui si passa l'id di N1 e la rilettura
      // CONTROLLA che sia rimasto N1 (v. `verificaRiletturaFatturaOspite`).
      vat: { id: ids.naturaArt15 },
      description: descrizioneRigaImposta(d, d.imposta),
      gross_price: centesimi(d.imposta.importo),
      not_taxable: true,
    })
    pagamenti.push({
      amount: centesimi(d.imposta.importo),
      due_date: d.data,
      // L'imposta si riscuote in contanti all'ARRIVO: paid_date = check-in.
      paid_date: d.check_in,
      status: 'paid',
      payment_account: { id: ids.contoContanti },
    })
  }

  return {
    type: TIPO_FIC_FATTURA,
    entity: costruisciEntity(d),
    date: d.data,
    // 🚨 Trappola 3: numerazione Principale = STRINGA VUOTA, non «Principale».
    numeration: '',
    // 🚨 Sui due modelli `subject` e' vuoto e il testo sta in
    // `visible_subject`. La specifica diceva di riempirli entrambi: vince il
    // modello. ⚠️ Di conseguenza l'anti-doppione cerca la prenotazione nel
    // VISIBLE_subject — cercarla in `subject` non troverebbe mai niente.
    subject: '',
    visible_subject: oggettoFattura(d),
    // Nasce ELETTRONICA: senza, su FIC non compare nemmeno il tasto per
    // trasmetterla. Elettronico NON vuol dire trasmesso.
    e_invoice: true,
    // I prezzi di Booking sono LORDI: FIC scorpora.
    use_gross_prices: true,
    notes: noteFattura(d),
    items_list: items,
    payments_list: pagamenti,
    // 🚨 Trappola 2: `revenue_detect: true`. Una fattura al cliente E' un ricavo.
    extra_data: { ...RILEVAZIONI_FATTURA_OSPITE },
    // 🚨 Trappola 1: il bonifico sta SOLO qui. `payment_method` a livello di
    // documento NON si scrive: sul modello e' vuoto.
    ei_data: { payment_method: METODO_PAGAMENTO_SDI },
  }
}

/* ------------------------------------------------------------------ *
 * ANTI-DOPPIONE
 * ------------------------------------------------------------------ */

/** Confronto fra numeri di prenotazione: via punteggiatura e maiuscole. */
export function chiavePrenotazione(n: string): string {
  return String(n || '').toUpperCase().replace(/[^A-Z0-9]/g, '')
}

export interface FatturaTrovata {
  id: number
  numero: string
  data: string
  importo: number
  oggetto: string
}

/**
 * 🚨 L'ANTI-DOPPIONE. Cerca su Fatture in Cloud una fattura EMESSA che citi
 * quella prenotazione.
 *
 * Due fatture per lo stesso soggiorno sono due volte lo stesso ricavo e due
 * volte la stessa IVA a debito, su documenti elettronici che una volta
 * trasmessi non si cancellano: si correggono con una nota di credito.
 *
 * 🚨 **Un elenco che non si legge, o che si legge a meta', non e' un «non
 * c'e'»: e' un «non lo so», e qui torna come RIFIUTO.** Su un elenco incompleto
 * non si puo' dire che il doppione non ci sia — ed e' esattamente il guasto che
 * invece di chiudere APRE.
 */
export async function cercaFatturaPrenotazione(
  prenotazione: string,
  anni: number[],
  societa: CodiceSocieta,
): Promise<{ ok: true; esistente: FatturaTrovata | null } | { ok: false; error: string }> {
  const cercata = chiavePrenotazione(prenotazione)
  // Una chiave cortissima farebbe falsi positivi dentro qualunque altro numero:
  // meglio rifiutare che dire «c'e' gia'» su una fattura di un altro ospite.
  if (cercata.length < 4) {
    return { ok: false, error: `«${prenotazione}» e' troppo corto per riconoscere un doppione: non posso escludere che la fattura ci sia gia'.` }
  }

  for (const anno of anni) {
    const r = await cercaFattureEmesse({ anno }, societa)
    if (!r.ok) {
      return {
        ok: false,
        error: `non riesco a leggere le fatture emesse del ${anno} su Fatture in Cloud (${r.error}), quindi non posso escludere il doppione`,
      }
    }
    if (r.valore.elenco_troncato) {
      return {
        ok: false,
        error: `l'elenco delle fatture emesse del ${anno} e' TRONCATO (${r.valore.pagine_lette} pagine lette e Fatture in Cloud ne dichiara altre): `
          + 'su un elenco incompleto non posso dire che questa fattura non ci sia gia\'',
      }
    }
    for (const doc of r.valore.documenti) {
      const oggetto = `${testo(doc.visible_subject) ?? ''} ${testo(doc.subject) ?? ''}`
      if (!chiavePrenotazione(oggetto).includes(cercata)) continue
      return {
        ok: true,
        esistente: {
          id: numero(doc.id) ?? 0,
          numero: `${testo(String(doc.number ?? '')) ?? ''}${testo(doc.numeration) ?? ''}` || '(senza numero)',
          data: testo(doc.date) ?? '',
          importo: centesimi(numero(doc.amount_gross) ?? 0),
          oggetto: testo(doc.visible_subject) ?? '',
        },
      }
    }
  }
  return { ok: true, esistente: null }
}

/* ------------------------------------------------------------------ *
 * LA RILETTURA — l'esito non e' la risposta della POST
 * ------------------------------------------------------------------ */

export interface AttesoRilettura {
  id: string
  prezzo: number
  imposta: number
  naturaArt15: number
  aliquota10: number
  clienteId?: number
}

export interface EsitoRilettura {
  /** Cio' che NON torna. Vuoto = la fattura e' come l'abbiamo confermata. */
  problemi: string[]
  /** Cio' che non si e' potuto guardare perche' FIC non lo espone. */
  nonVisti: string[]
}

/**
 * Confronta la fattura RILETTA con quella confermata.
 *
 * Pura: il confronto e' la parte che deve poter fallire in un test senza
 * parlare con Fatture in Cloud.
 *
 * ⚠️ «Non l'ho visto» e «non torna» non sono la stessa cosa. Un campo che FIC
 * non espone non rende la fattura sospetta — rende sospetto il controllo, e va
 * detto per quello che e'.
 */
export function verificaRiletturaFatturaOspite(
  doc: Record<string, unknown>,
  atteso: AttesoRilettura,
): EsitoRilettura {
  const problemi: string[] = []
  const nonVisti: string[] = []

  if (String(doc.id ?? '') !== String(atteso.id)) {
    problemi.push('la rilettura non ha restituito quel documento')
    return { problemi, nonVisti }
  }

  const tipo = testo(doc.type)
  if (tipo !== undefined && tipo !== TIPO_FIC_FATTURA) {
    problemi.push(`su Fatture in Cloud risulta di tipo «${tipo}», non ${TIPO_FIC_FATTURA}`)
  }

  if (doc.e_invoice !== undefined && doc.e_invoice !== true) {
    problemi.push('il documento NON risulta elettronico: cosi\' su Fatture in Cloud non compare il tasto per trasmetterlo')
  }

  // 1) Gli importi. `amount_net` e' la base IMPONIBILE: l'imposta di soggiorno
  //    ne resta fuori, ed e' proprio questo che prova che la natura art. 15 ha
  //    funzionato.
  const nettoAtteso = centesimi(atteso.prezzo / (1 + ALIQUOTA_ALLOGGIO / 100))
  const netto = numero(doc.amount_net)
  if (netto === null) nonVisti.push('amount_net')
  else if (Math.abs(netto - nettoAtteso) > 0.02) {
    problemi.push(`l'imponibile risulta ${euroIt(netto)} invece di ${euroIt(nettoAtteso)} (il lordo ${euroIt(atteso.prezzo)} scorporato al ${ALIQUOTA_ALLOGGIO}%): il prezzo NON e' stato scorporato come previsto`)
  }

  const ivaAttesa = centesimi(nettoAtteso * ALIQUOTA_ALLOGGIO / 100)
  const iva = numero(doc.amount_vat)
  if (iva === null) nonVisti.push('amount_vat')
  else if (Math.abs(iva - ivaAttesa) > 0.02) {
    problemi.push(`l'IVA risulta ${euroIt(iva)} invece di ${euroIt(ivaAttesa)}`)
  }

  const totaleAtteso = centesimi(atteso.prezzo + atteso.imposta)
  const totale = numero(doc.amount_gross)
  if (totale === null) nonVisti.push('amount_gross')
  else if (Math.abs(totale - totaleAtteso) > TOLLERANZA) {
    problemi.push(`il totale risulta ${euroIt(totale)} invece di ${euroIt(totaleAtteso)} (prezzo ${euroIt(atteso.prezzo)} + imposta ${euroIt(atteso.imposta)})`)
  }

  // 2) Le righe.
  const righe = Array.isArray(doc.items_list) ? (doc.items_list as unknown[]).map(asObject) : null
  if (righe === null) nonVisti.push('items_list')
  else {
    const attese = atteso.imposta > 0 ? 2 : 1
    if (righe.length !== attese) {
      problemi.push(`la fattura ha ${righe.length} righe invece di ${attese}`)
    }
    if (atteso.imposta > 0) {
      const riga = righe.find((r) => testo(r.name) === NOME_RIGA_IMPOSTA)
      if (!riga) {
        problemi.push(`manca la riga «${NOME_RIGA_IMPOSTA}»`)
      } else {
        const vat = asObject(riga.vat)
        const idVat = numero(vat.id)
        const valore = numero(vat.value)
        const descrizione = testo(vat.description) ?? ''
        if (idVat !== atteso.naturaArt15) {
          // 🚨 E' IL CONTROLLO PER CUI QUESTA FUNZIONE ESISTE. Dall'interfaccia
          // la spunta «anticipazione» riscrive la natura in N4 (operazioni
          // ESENTI), che su una somma ESCLUSA ex art. 15 e' sbagliata.
          problemi.push(
            `la riga dell'imposta di soggiorno ha la natura id ${idVat ?? '?'}${descrizione ? ` («${descrizione}»)` : ''} `
            + `invece di ${atteso.naturaArt15} («Iva esclusa ex art. 15»): controlla che Fatture in Cloud non l'abbia riscritta in N4`,
          )
        }
        if (valore !== null && Math.abs(valore) > 0.001) {
          problemi.push(`la riga dell'imposta di soggiorno risulta con IVA ${valore}% invece di 0`)
        }
        if (riga.not_taxable !== undefined && riga.not_taxable !== true) {
          problemi.push('la riga dell\'imposta di soggiorno NON risulta fuori base imponibile (not_taxable)')
        }
      }
    }
    const soggiorno = righe.find((r) => testo(r.name) !== NOME_RIGA_IMPOSTA)
    if (soggiorno) {
      const idVat = numero(asObject(soggiorno.vat).id)
      if (idVat !== null && idVat !== atteso.aliquota10) {
        problemi.push(`la riga del soggiorno ha l'aliquota id ${idVat} invece di ${atteso.aliquota10} (${ALIQUOTA_ALLOGGIO}%)`)
      }
    }
  }

  // 3) I pagamenti: quanti, tutti saldati, e che sommino il totale.
  const pagamenti = Array.isArray(doc.payments_list) ? (doc.payments_list as unknown[]).map(asObject) : null
  if (pagamenti === null) nonVisti.push('payments_list')
  else {
    const attesi = atteso.imposta > 0 ? 2 : 1
    if (pagamenti.length !== attesi) {
      problemi.push(`il piano pagamenti ha ${pagamenti.length} voci invece di ${attesi}`)
    }
    const nonPagate = pagamenti.filter((p) => testo(p.status) !== 'paid')
    if (nonPagate.length > 0) {
      problemi.push(`${nonPagate.length} voce/i del piano pagamenti NON risultano saldate: la fattura finirebbe nello scadenzario`)
    }
    const somma = centesimi(pagamenti.reduce((t, p) => t + (numero(p.amount) ?? 0), 0))
    if (Math.abs(somma - totaleAtteso) > TOLLERANZA) {
      problemi.push(`i pagamenti sommano ${euroIt(somma)} invece del totale ${euroIt(totaleAtteso)}`)
    }
  }

  // 4) L'anagrafica: che sia il cliente confermato e non un altro.
  if (atteso.clienteId !== undefined) {
    const idEntita = numero(asObject(doc.entity).id)
    if (idEntita === null) nonVisti.push('entity.id')
    else if (idEntita !== atteso.clienteId) {
      problemi.push(`la fattura e' intestata all'anagrafica ${idEntita} invece di ${atteso.clienteId}`)
    }
  }

  // 5) Il TipoDocumento SdI, SOLO se FIC lo espone: un dato che non si vede non
  //    e' un dato sbagliato.
  const tipoSdi = testo(asObject(asObject(asObject(asObject(doc.ei_raw).FatturaElettronicaBody).DatiGenerali).DatiGeneraliDocumento).TipoDocumento)
  if (tipoSdi === undefined) nonVisti.push('ei_raw.TipoDocumento')
  else if (tipoSdi !== TIPO_DOCUMENTO_SDI_FATTURA) {
    problemi.push(`il tipo documento SdI risulta «${tipoSdi}», non ${TIPO_DOCUMENTO_SDI_FATTURA}`)
  }

  return { problemi, nonVisti }
}

/** Rilegge il documento da Fatture in Cloud e ci applica sopra i controlli. */
export async function rileggiFatturaOspite(
  atteso: AttesoRilettura,
  societa: CodiceSocieta,
): Promise<{ ok: true; esito: EsitoRilettura; numero: string | null } | { ok: false; error: string }> {
  const company = await getCompanyId(societa)
  if (!company.ok) return { ok: false, error: company.error }

  const r = await ficGet(`/c/${company.id}/issued_documents/${encodeURIComponent(atteso.id)}`, { fieldset: 'detailed' }, societa)
  if (!r.ok) return { ok: false, error: r.error }

  const doc = asObject(r.data?.data ?? r.data)
  const esito = verificaRiletturaFatturaOspite(doc, atteso)
  // ⚠️ Su Fatture in Cloud `number` e' un INTERO, non una stringa: col solo
  // `testo()` il numero arrivava sempre nullo (difetto gia' pagato sul registro
  // delle integrazioni TD17).
  const num = typeof doc.number === 'number' && Number.isFinite(doc.number) ? String(doc.number) : testo(doc.number)
  const serie = testo(doc.numeration)
  return { ok: true, esito, numero: num ? `${num}${serie ? `/${serie}` : ''}` : null }
}

/* ------------------------------------------------------------------ *
 * LA CREAZIONE
 * ------------------------------------------------------------------ */

/** Cio' che il pending si porta dietro oltre al documento: serve ai controlli. */
export interface FatturaOspitePayload {
  documento: Record<string, unknown>
  prenotazione: string
  prezzo: number
  imposta: number
  anni: number[]
  ids: { aliquota10: number; naturaArt15: number; contoBanca: number; contoContanti: number }
  cliente_id?: number
  intestazione: string
  avvisi: string[]
}

export interface EsitoFatturaOspite {
  messaggio: string
  creata: boolean
  /** Creata su FIC ma NON confermata dalla rilettura o dalla verifica formale. */
  da_verificare: boolean
  /** true = NON si ritenta (o e' nata, o e' incerta, o e' gia' li'). */
  bloccato: boolean
  id: string | null
}

export function leggiFatturaOspitePayload(payload: unknown): FatturaOspitePayload | null {
  const p = asObject(payload)
  const documento = asObject(p.documento)
  if (Object.keys(documento).length === 0) return null
  const prenotazione = testo(p.prenotazione)
  if (!prenotazione) return null
  const ids = asObject(p.ids)
  const aliquota10 = numero(ids.aliquota10)
  const naturaArt15 = numero(ids.naturaArt15)
  const contoBanca = numero(ids.contoBanca)
  const contoContanti = numero(ids.contoContanti)
  if (aliquota10 === null || naturaArt15 === null || contoBanca === null || contoContanti === null) return null
  const clienteId = numero(p.cliente_id)
  return {
    documento,
    prenotazione,
    prezzo: numero(p.prezzo) ?? 0,
    imposta: numero(p.imposta) ?? 0,
    anni: Array.isArray(p.anni) ? (p.anni as unknown[]).map((a) => numero(a) ?? 0).filter((a) => a > 0) : [],
    ids: { aliquota10, naturaArt15, contoBanca, contoContanti },
    cliente_id: clienteId === null ? undefined : clienteId,
    intestazione: testo(p.intestazione) ?? prenotazione,
    avvisi: Array.isArray(p.avvisi) ? (p.avvisi as unknown[]).map((a) => String(a)) : [],
  }
}

/**
 * Crea la fattura: ANTI-DOPPIONE, POST, RILETTURA, VERIFICA FORMALE. In
 * quest'ordine, e ogni passo che fallisce ferma tutto.
 *
 * Tre esiti, mai confusi:
 *  - CREATA: nata, riletta e passata dalla verifica formale di FIC;
 *  - NON CREATA: su Fatture in Cloud non c'e' niente, col motivo;
 *  - DA VERIFICARE: esiste, ma la rilettura o la verifica formale non la
 *    confermano. NON e' un successo e NON si ritenta — un secondo tentativo
 *    creerebbe il doppione di un documento che c'e' gia'.
 */
export async function creaFatturaOspite(
  payload: unknown,
  societa: CodiceSocieta,
): Promise<EsitoFatturaOspite> {
  const s = getSocieta(societa)
  const dati = leggiFatturaOspitePayload(payload)
  if (!dati) {
    return {
      messaggio: 'FATTURA NON CREATA: il pending non contiene una fattura di soggiorno leggibile. Non ho creato niente.',
      creata: false,
      da_verificare: false,
      bloccato: true,
      id: null,
    }
  }

  const non = (motivo: string, bloccato = false, id: string | null = null): EsitoFatturaOspite => ({
    messaggio: `FATTURA NON CREATA su ${s.denominazione}: ${dati.intestazione}.\n\n${motivo}`,
    creata: false,
    da_verificare: false,
    bloccato,
    id,
  })

  // 🚨 L'anti-doppione si RIFA' qui, subito prima di creare. Quello della
  // compilazione serve a non far confermare un doppione; questo serve a non
  // CREARLO — fra le due cose c'e' una conferma, e in mezzo la stessa fattura
  // puo' essere nata da un altro canale (o dall'Ingegnere a mano sul gestionale).
  const doppione = await cercaFatturaPrenotazione(dati.prenotazione, dati.anni, societa)
  if (!doppione.ok) return non(`${doppione.error}. Non ho creato niente.`)
  if (doppione.esistente) {
    return non(
      `su Fatture in Cloud c'e' GIA' la fattura n. ${doppione.esistente.numero} del ${doppione.esistente.data} `
      + `(id ${doppione.esistente.id}, ${euroIt(doppione.esistente.importo)}) per la prenotazione ${dati.prenotazione}`
      + `${doppione.esistente.oggetto ? ` — «${doppione.esistente.oggetto}»` : ''}: `
      + 'non ne creo una seconda e non ritento. Controllala su Fatture in Cloud.',
      true,
      String(doppione.esistente.id),
    )
  }

  const creato = await creaDocumentoFIC(dati.documento, societa)
  if (!creato.ok) return non(`Fatture in Cloud ha rifiutato la creazione: ${creato.error}.`)

  const atteso: AttesoRilettura = {
    id: creato.id,
    prezzo: dati.prezzo,
    imposta: dati.imposta,
    naturaArt15: dati.ids.naturaArt15,
    aliquota10: dati.ids.aliquota10,
    clienteId: dati.cliente_id,
  }
  const riletta = await rileggiFatturaOspite(atteso, societa)

  const coda = (righe: (string | null)[]) => righe.filter(Boolean).join('\n')

  if (!riletta.ok) {
    return {
      messaggio: coda([
        `FATTURA DA VERIFICARE su ${s.denominazione}: ${dati.intestazione}.`,
        '',
        `Fatture in Cloud ha risposto con l'id ${creato.id}, ma la RILETTURA non si e' potuta fare: ${riletta.error}.`,
        'Non la conto fra le riuscite e non ritento: un secondo tentativo creerebbe il doppione di un documento che forse c\'e\' gia\'. '
        + 'Aprila su Fatture in Cloud e controllala a mano.',
        ...dati.avvisi,
      ]),
      creata: false,
      da_verificare: true,
      bloccato: true,
      id: creato.id,
    }
  }

  const nonVisti = riletta.esito.nonVisti.length > 0
    ? `⚠️ Non ho potuto controllare: ${riletta.esito.nonVisti.join(', ')} (Fatture in Cloud non li espone nella rilettura).`
    : null

  if (riletta.esito.problemi.length > 0) {
    return {
      messaggio: coda([
        `🚨 FATTURA CREATA MA NON CONFORME su ${s.denominazione}: ${dati.intestazione}.`,
        '',
        `Esiste su Fatture in Cloud (id ${creato.id}${riletta.numero ? `, n. ${riletta.numero}` : ''}${creato.url ? ` — ${creato.url}` : ''}), `
        + 'ma rileggendola NON torna:',
        ...riletta.esito.problemi.map((p) => `   · ${p}`),
        '',
        'NON la conto fra le riuscite e NON la rifaccio: il documento c\'e\' gia\', e un secondo tentativo sarebbe un doppione. '
        + 'Correggila o eliminala su Fatture in Cloud PRIMA di trasmetterla.',
        nonVisti,
        ...dati.avvisi,
      ]),
      creata: false,
      da_verificare: true,
      bloccato: true,
      id: creato.id,
    }
  }

  // 🚨 LA VERIFICA FORMALE. La rilettura dice che il documento esiste e che i
  // conti tornano. Non dice se il suo XML passerebbe lo SdI: e' una domanda che
  // sa rispondere solo Fatture in Cloud, e costa una GET (v.
  // `fic-verifica-formale.ts`, e i quattro TD17 del 15 settembre 2026 che
  // «erano 4 su 4» e sarebbero stati scartati tutti).
  const formale = await verificaFormaleXml(creato.id, societa)
  const riga = `id ${creato.id}${riletta.numero ? `, n. ${riletta.numero}` : ''}${creato.url ? ` — ${creato.url}` : ''}`

  if (formale.esito === 'errori') {
    return {
      messaggio: coda([
        `🚨 FATTURA CREATA MA NON VALIDA su ${s.denominazione}: ${dati.intestazione}.`,
        '',
        `Esiste su Fatture in Cloud (${riga}) e i conti tornano, ma:`,
        rigaVerificaFormale(formale),
        '',
        'NON la conto fra le riuscite e NON la rifaccio: correggila o eliminala su Fatture in Cloud. '
        + 'Cosi\' com\'e\' lo SdI la scarterebbe.',
        nonVisti,
        ...dati.avvisi,
      ]),
      creata: false,
      da_verificare: true,
      bloccato: true,
      id: creato.id,
    }
  }

  return {
    messaggio: coda([
      `FATTURA CREATA su ${s.denominazione}: ${dati.intestazione}.`,
      '',
      `✅ ${riga}`,
      `Riletta su Fatture in Cloud: imponibile e totale tornano, `
      + `${dati.imposta > 0 ? 'l\'imposta di soggiorno e\' fuori base imponibile con la natura art. 15, ' : ''}`
      + 'e il piano pagamenti risulta saldato.',
      rigaVerificaFormale(formale),
      nonVisti,
      ...dati.avvisi,
      '',
      '⛔ NON e\' stata trasmessa allo SdI: e\' compilata ed elettronica, l\'invio lo fai tu da Fatture in Cloud.',
    ]),
    creata: true,
    da_verificare: formale.esito === 'non_verificato',
    bloccato: true,
    id: creato.id,
  }
}

/* ------------------------------------------------------------------ *
 * LETTURA DEI PARAMETRI + le difese che fermano PRIMA di scrivere
 * ------------------------------------------------------------------ */

export type LetturaDati =
  | { ok: true; dati: DatiFatturaOspite }
  | { ok: false; error: string }

const ISO = /^\d{4}-\d{2}-\d{2}$/

/**
 * Legge i parametri del tool e si ferma al primo dato che non regge.
 *
 * ⚠️ Si rifiuta PRIMA di toccare Fatture in Cloud e PRIMA di creare
 * l'anagrafica: v. la regola del codice fiscale qui sotto.
 */
export function leggiDatiFatturaOspite(input: Record<string, unknown>): LetturaDati {
  const unita = testo(input.unita)
  if (!unita) return { ok: false, error: 'unita richiesta (il nome dell\'appartamento, es. «Blue Maison 1»): non lo invento' }

  const indirizzoUnita = testo(input.indirizzo_unita)
  if (!indirizzoUnita) {
    return { ok: false, error: 'indirizzo_unita richiesto (es. «Via Fiumicello, Maratea (PZ)»): finisce nella descrizione della riga, non lo deduco dal nome dell\'appartamento' }
  }

  const checkIn = testo(input.check_in)
  const checkOut = testo(input.check_out)
  if (!checkIn || !ISO.test(checkIn)) return { ok: false, error: 'check_in richiesto nel formato aaaa-mm-gg' }
  if (!checkOut || !ISO.test(checkOut)) return { ok: false, error: 'check_out richiesto nel formato aaaa-mm-gg' }
  const notti = contaNotti(checkIn, checkOut)
  if (notti === null) return { ok: false, error: `dal ${ggmmaaaa(checkIn)} al ${ggmmaaaa(checkOut)} non c'e' nessuna notte: controlla le date` }

  const prenotazione = testo(input.prenotazione)
  if (!prenotazione) return { ok: false, error: 'prenotazione richiesta (il numero Booking.com): senza, non so riconoscere un doppione' }

  const prezzo = numero(input.prezzo)
  if (prezzo === null || prezzo <= 0) {
    return { ok: false, error: 'prezzo richiesto: e\' il LORDO Booking (alloggio + pulizie, IVA inclusa, commissione INCLUSA), non il payout netto' }
  }

  const data = testo(input.data) ?? new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Rome' })
  if (!ISO.test(data)) return { ok: false, error: `data «${data}» non valida: serve aaaa-mm-gg` }

  // Ospiti: o i due numeri, o le date di nascita (che NON escono da qui).
  const o = asObject(input.ospite)
  let adulti = numero(input.adulti)
  let bambini = numero(input.bambini)
  const date = Array.isArray(input.date_nascita) ? (input.date_nascita as unknown[]).map((x) => String(x ?? '')) : []
  if ((adulti === null || bambini === null) && date.length > 0) {
    const contati = contaOspiti(date, checkIn)
    adulti = adulti ?? contati.adulti
    bambini = bambini ?? contati.bambini
  }
  adulti = adulti ?? 0
  bambini = bambini ?? 0
  if (adulti + bambini <= 0) {
    return { ok: false, error: 'quanti ospiti? passa adulti e bambini (oppure date_nascita, che uso solo per contarli e NON finiscono su Fatture in Cloud)' }
  }

  const nome = testo(o.nome)
  if (!nome) return { ok: false, error: 'ospite.nome richiesto: e\' l\'intestatario della fattura' }
  const indirizzo = testo(o.indirizzo)
  const citta = testo(o.citta)
  if (!indirizzo || !citta) {
    return { ok: false, error: 'ospite.indirizzo e ospite.citta richiesti: una fattura elettronica senza indirizzo del cliente non e\' un documento valido' }
  }
  const paese = testo(o.paese) ?? 'Italia'
  const estero = paese.toLowerCase() !== 'italia'

  const codiceFiscale = testo(o.codice_fiscale)
  if (!estero) {
    // 🚨 IL CODICE FISCALE SI VALIDA, E SI VALIDA QUI — prima di toccare
    // l'anagrafica e prima di creare qualsiasi cosa. Nel file vero degli ospiti
    // due CF su 47 erano malformati: un CF storto non da' errore, entra in
    // fattura, e torna indietro come SCARTO dallo SdI giorni dopo, quando
    // l'ospite e' ripartito e la correzione costa una nota di credito.
    // Si riusa `validaCodiceFiscale` (checkin/valida-codice-fiscale.ts), che
    // conosce il carattere di controllo e l'omocodia: riscriverlo qui vorrebbe
    // dire tenere due validatori che divergono.
    if (!codiceFiscale) {
      return { ok: false, error: 'ospite.codice_fiscale richiesto per un cliente italiano. Se e\' straniero, passa ospite.paese con la nazione per esteso (es. «Francia»).' }
    }
    const v = validaCodiceFiscale(codiceFiscale)
    if (!v.valido) {
      return { ok: false, error: `codice fiscale «${codiceFiscale}» non valido: ${v.errore}. Non ho creato ne' l'anagrafica ne' la fattura: controllalo sul documento dell'ospite.` }
    }
  }

  // L'imposta di soggiorno. Se non c'e', la riga 2 non nasce.
  const grezzaImposta = input.imposta_soggiorno
  let imposta: ImpostaSoggiornoFattura | null = null
  if (grezzaImposta !== undefined && grezzaImposta !== null) {
    const i = asObject(grezzaImposta)
    const importo = numero(i.importo)
    const persone = numero(i.persone)
    const nottiImposta = numero(i.notti)
    const tariffa = numero(i.tariffa)
    if (importo === null || importo < 0) return { ok: false, error: 'imposta_soggiorno.importo non e\' un numero' }
    if (importo > 0) {
      if (persone === null || nottiImposta === null || tariffa === null) {
        return {
          ok: false,
          error: 'imposta_soggiorno vuole importo, persone, notti e tariffa: la descrizione della riga dice «N persone x N notti x T euro», '
            + 'e quei tre numeri non si deducono dall\'importo.',
        }
      }
      // 🚨 Il conto DEVE tornare. Se persone x notti x tariffa non fa l'importo,
      // la riga direbbe una cosa e ne addebiterebbe un'altra — su denaro di
      // terzi, che va riversato al Comune.
      const atteso = centesimi(persone * nottiImposta * tariffa);
      if (Math.abs(atteso - centesimi(importo)) > TOLLERANZA) {
        return {
          ok: false,
          error: `l'imposta di soggiorno non torna: ${persone} x ${nottiImposta} x ${euroIt(tariffa)} fa ${euroIt(atteso)}, `
            + `ma l'importo passato e' ${euroIt(importo)}. Non scrivo una riga che dice una cosa e ne addebita un'altra.`,
        }
      }
      imposta = { importo: centesimi(importo), persone, notti: nottiImposta, tariffa }
    }
  }

  const clienteIdGrezzo = input.cliente_id
  const clienteId = clienteIdGrezzo === undefined || clienteIdGrezzo === null || clienteIdGrezzo === ''
    ? undefined
    : numero(clienteIdGrezzo)
  if (clienteIdGrezzo !== undefined && clienteIdGrezzo !== null && clienteIdGrezzo !== '' && clienteId === null) {
    return { ok: false, error: 'cliente_id non e\' un numero' }
  }

  return {
    ok: true,
    dati: {
      unita,
      indirizzo_unita: indirizzoUnita,
      check_in: checkIn,
      check_out: checkOut,
      notti,
      prenotazione,
      prezzo: centesimi(prezzo),
      adulti,
      bambini,
      data,
      estero,
      cliente_id: clienteId ?? undefined,
      imposta,
      ospite: {
        nome,
        codice_fiscale: estero ? undefined : codiceFiscale,
        indirizzo,
        cap: testo(o.cap),
        citta,
        provincia: testo(o.provincia),
        paese,
        passaporto: testo(o.passaporto),
        codice_destinatario: testo(o.codice_destinatario),
        email: testo(o.email),
      },
    },
  }
}

/** Gli anni in cui la fattura del soggiorno potrebbe essere stata registrata. */
export function anniDaCercare(d: DatiFatturaOspite): number[] {
  const anni = new Set<number>()
  for (const iso of [d.data, d.check_out, d.check_in]) {
    const a = Number(String(iso).slice(0, 4))
    if (Number.isFinite(a) && a > 2000) anni.add(a)
  }
  return [...anni]
}

/** La riga che l'Ingegnere legge sopra tutto il resto. */
export function intestazioneFatturaOspite(d: DatiFatturaOspite): string {
  const totale = centesimi(d.prezzo + (d.imposta?.importo ?? 0))
  return `${d.ospite.nome} — ${oggettoFattura(d)} — ${euroIt(totale)}`
}
