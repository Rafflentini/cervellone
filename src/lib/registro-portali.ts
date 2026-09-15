/**
 * src/lib/registro-portali.ts — IL REGISTRO A STATI delle commissioni dei portali.
 *
 * Il difetto che chiude, 15 settembre 2026. Per quattro fatture Booking
 * nessuno sapeva se un documento esistesse: l'id `552625594` e' stato
 * inseguito per un'ora su Fatture in Cloud — documenti emessi, ricevuti,
 * elenco per anno, e perfino l'altra societa' — prima di capire che non era
 * MAI stato creato. La POST era fallita con un 422 e il tool aveva restituito
 * un id rimasto da un tentativo precedente.
 *
 * Con una riga per fattura e uno stato, quella domanda ha un posto solo dove
 * si risponde.
 *
 * 🚨 LE TRE REGOLE CHE QUESTO FILE INCARNA
 *
 * 1. UNO STATO AVANZA SOLO SU UN FATTO VERIFICATO. Questa funzione non chiama
 *    Fatture in Cloud e non decide niente: la chiamano i tool che scrivono i
 *    documenti, e SOLO dopo che la RILETTURA ha confermato. Se la rilettura non
 *    conferma, chi chiama passa `stato: 'da_verificare'` col motivo — non
 *    l'avanzamento.
 *
 * 2. UN REGISTRO CHE MENTE E' PEGGIO DI NESSUN REGISTRO. Se la scrittura qui
 *    fallisce DOPO che il documento su FIC e' nato, non si finge: l'esito torna
 *    `ok: false` e `avvisoRegistroNonScritto` compone la riga che il tool deve
 *    dire all'Ingegnere, con l'id del documento VERO. Un documento esistente
 *    con il registro che dice «non fatto» si ripara a mano; il contrario no.
 *
 * 3. IL REGISTRO NON E' LA VERITA'. Fatture in Cloud lo e'. Per questo esiste
 *    `registro_portali_riconcilia`: una riga che cita un documento cancellato a
 *    mano dev'essere scoperta, non creduta.
 */
import { supabase } from './supabase'

export const TABELLA_REGISTRO = 'cervellone_registro_portali'

/** I portali che hanno una fattura di commissioni da adempiere. */
export const PORTALI = ['booking', 'airbnb'] as const
export type Portale = (typeof PORTALI)[number]

/**
 * Gli stati di AVANZAMENTO, in ordine. La posizione nell'array e' il rango: e'
 * quello che impedisce a un fatto arrivato tardi (la spesa registrata dopo
 * l'integrazione) di far tornare INDIETRO la riga.
 *
 * ⚠️ `pdf_archiviato` e `controlli_ok` della specifica non ci sono, e non e'
 * una dimenticanza: il PDF non lo archiviamo su Drive (sta allegato al
 * documento di spesa su FIC) e i controlli sono dentro i tool. Nessuno dei due
 * corrisponde a un atto che qualcuno compie e che si possa verificare — uno
 * stato cosi' non avanza mai, e una riga ferma su uno stato inventato fa
 * sembrare in ritardo un adempimento concluso.
 */
export const STATI_AVANZAMENTO = [
  'nuova',
  'spesa_registrata',
  'td17_generata',
  'td17_inviata',
  'sdi_consegnata',
  'chiusa',
] as const
export type StatoAvanzamento = (typeof STATI_AVANZAMENTO)[number]

/** Il RAMO: qualcosa non torna, e il motivo sta in `note`. Non e' un avanzamento. */
export const DA_VERIFICARE = 'da_verificare'
export type StatoRegistro = StatoAvanzamento | typeof DA_VERIFICARE

export function rangoStato(stato: string): number {
  const i = (STATI_AVANZAMENTO as readonly string[]).indexOf(stato)
  return i < 0 ? -1 : i
}

/**
 * Quale portale e' questo fornitore. `null` = non e' un portale, e allora il
 * registro NON si tocca affatto.
 *
 * 🚨 E' la guardia che tiene il registro pulito: `registra_spesa_fornitore` e
 * `compila_autofattura` servono a QUALUNQUE fornitore estero, non solo ai
 * portali. Senza questa riga, la prima fattura di un consulente irlandese
 * finirebbe nel registro delle commissioni, e la risposta a «a che punto
 * siamo con Booking?» conterebbe righe che con Booking non c'entrano nulla.
 */
export function portaleDelFornitore(nome: string): Portale | null {
  const n = (nome ?? '').toLowerCase()
  if (n.includes('booking')) return 'booking'
  if (n.includes('airbnb')) return 'airbnb'
  return null
}

/**
 * Due numeri di fattura sono lo STESSO numero se differiscono solo per
 * punteggiatura o maiuscole. E' la stessa normalizzazione di
 * `chiaveNumeroFattura` in `fic-write-tools.ts`, e deve restare la stessa:
 * il vincolo UNIQUE del database e' costruito su questa identica espressione
 * (`upper(regexp_replace(numero_fattura, '[^A-Za-z0-9]', '', 'g'))`).
 */
export function chiaveNumeroPortale(numero: string): string {
  return (numero ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '')
}

const ISO = /^\d{4}-\d{2}-\d{2}$/

/**
 * La scadenza dell'invio: giorno 15 del mese SUCCESSIVO alla ricezione.
 *
 * 🚨 Torna `null` se la data di ricezione non c'e' o non e' leggibile, e non
 * ripiega su oggi. Una scadenza calcolata su una data inventata sposterebbe in
 * avanti un termine vero: il registro direbbe «in tempo» proprio quando non lo
 * e'. Meglio una scadenza ASSENTE, che si vede.
 */
export function scadenzaInvio(dataRicezione: string | null | undefined): string | null {
  if (!dataRicezione || !ISO.test(dataRicezione)) return null
  const anno = Number(dataRicezione.slice(0, 4))
  const mese = Number(dataRicezione.slice(5, 7))
  if (!Number.isFinite(anno) || mese < 1 || mese > 12) return null
  const annoDopo = mese === 12 ? anno + 1 : anno
  const meseDopo = mese === 12 ? 1 : mese + 1
  return `${annoDopo}-${String(meseDopo).padStart(2, '0')}-15`
}

/** I dati che un tool ha in mano quando un FATTO e' stato verificato. */
export interface AggiornamentoRegistro {
  societa: string
  /** Denominazione del fornitore: da qui si ricava il portale. */
  fornitore: string
  /** Numero della fattura DEL PORTALE (non dell'autofattura). */
  numero: string
  /** Data della fattura del portale, YYYY-MM-DD. */
  data: string
  dataRicezione?: string | null
  imponibile?: number | null
  iva?: number | null
  regime?: 'RC' | 'IVA-IT' | null
  struttura?: string | null
  strutturaId?: string | null
  periodoDal?: string | null
  periodoAl?: string | null
  /** Lo stato che il fatto verificato giustifica. */
  stato: StatoRegistro
  spesaFicId?: string | null
  td17FicId?: string | null
  td17Numero?: string | null
  /** Il motivo, obbligatorio nei fatti quando `stato` e' `da_verificare`. */
  nota?: string | null
}

export type EsitoRegistro =
  | { ok: true; scritto: true; id: string; stato: StatoRegistro; avanzato: boolean }
  | { ok: true; scritto: false; motivo: string }
  | { ok: false; errore: string }

type RigaRegistro = {
  id: string
  stato: string
  note: string | null
  spesa_fic_id: string | null
  td17_fic_id: string | null
  data_ricezione: string | null
}

function pulisci(v: string | null | undefined): string | null {
  if (typeof v !== 'string') return null
  const t = v.trim()
  return t.length > 0 ? t : null
}

/** I campi che si scrivono SOLO se il chiamante li sa: `undefined` non tocca niente. */
function campiNoti(a: AggiornamentoRegistro): Record<string, unknown> {
  const campi: Record<string, unknown> = {}
  const forse = (chiave: string, valore: unknown) => {
    if (valore !== undefined && valore !== null) campi[chiave] = valore
  }
  forse('struttura', pulisci(a.struttura))
  forse('struttura_id_portale', pulisci(a.strutturaId))
  forse('periodo_dal', pulisci(a.periodoDal))
  forse('periodo_al', pulisci(a.periodoAl))
  forse('imponibile', a.imponibile)
  forse('iva', a.iva)
  forse('regime', a.regime)
  forse('spesa_fic_id', pulisci(a.spesaFicId))
  forse('td17_fic_id', pulisci(a.td17FicId))
  forse('td17_numero', pulisci(a.td17Numero))
  const ricezione = pulisci(a.dataRicezione)
  if (ricezione) {
    campi.data_ricezione = ricezione
    const scadenza = scadenzaInvio(ricezione)
    if (scadenza) campi.scadenza_invio = scadenza
  }
  return campi
}

/**
 * Lo stato NUOVO della riga, date la vecchia e il fatto appena verificato.
 *
 * 🚨 Tre regole, e nessuna e' un dettaglio:
 * - un fatto verificato non fa mai tornare INDIETRO la riga (rango);
 * - `da_verificare` VINCE sempre: e' un cartello, non un gradino;
 * - `da_verificare` e' APPICCICOSO. Un fatto nuovo, anche verificato, scrive i
 *   suoi campi ma non toglie il cartello: chi l'ha messo aveva visto qualcosa
 *   che nessuno ha ancora guardato. Toglierlo automaticamente vorrebbe dire
 *   far sparire dal registro l'unico posto in cui quel problema era scritto.
 */
export function statoRisultante(attuale: string, richiesto: StatoRegistro): { stato: string; avanzato: boolean } {
  if (richiesto === DA_VERIFICARE) return { stato: DA_VERIFICARE, avanzato: attuale !== DA_VERIFICARE }
  if (attuale === DA_VERIFICARE) return { stato: DA_VERIFICARE, avanzato: false }
  return rangoStato(richiesto) > rangoStato(attuale)
    ? { stato: richiesto, avanzato: true }
    : { stato: attuale, avanzato: false }
}

/** La nota nuova in coda alla vecchia, senza cancellare niente. Max 4.000 caratteri. */
export function accodaNota(vecchia: string | null, nuova: string | null | undefined, quando: string): string | null {
  const testo = pulisci(nuova ?? null)
  if (!testo) return vecchia
  const riga = `[${quando}] ${testo}`
  const unita = vecchia ? `${vecchia}\n${riga}` : riga
  return unita.length > 4000 ? unita.slice(unita.length - 4000) : unita
}

/**
 * Scrive nel registro il fatto appena VERIFICATO. La chiamano
 * `registra_spesa_fornitore` e `compila_autofattura`: una funzione sola, in un
 * file suo, perche' un registro aggiornato da due copie di codice diverse
 * diverge in tre settimane — ed e' esattamente cosi' che e' morta la memoria
 * di lavoro di questo progetto.
 *
 * Non lancia mai: un guasto del registro non deve far fallire un tool che ha
 * gia' creato un documento fiscale vero.
 */
export async function aggiornaRegistroPortali(a: AggiornamentoRegistro): Promise<EsitoRegistro> {
  const portale = portaleDelFornitore(a.fornitore)
  if (!portale) {
    return { ok: true, scritto: false, motivo: `${a.fornitore} non e' un portale (Booking/Airbnb): il registro delle commissioni non lo riguarda.` }
  }
  const numero = pulisci(a.numero)
  const societa = pulisci(a.societa)
  const data = pulisci(a.data)
  if (!numero || !societa || !data) {
    return { ok: false, errore: 'servono societa, numero e data della fattura del portale: senza non so su quale riga scrivere.' }
  }
  const chiave = chiaveNumeroPortale(numero)
  const adesso = new Date().toISOString()

  try {
    // 1) La riga c'e' gia'? Si cerca sulla chiave NORMALIZZATA, la stessa su
    //    cui poggia il vincolo UNIQUE del database.
    const trovata = await supabase
      .from(TABELLA_REGISTRO)
      .select('id, stato, note, spesa_fic_id, td17_fic_id, data_ricezione')
      .eq('societa', societa)
      .eq('portale', portale)
      .eq('numero_chiave', chiave)
      .maybeSingle()

    if (trovata.error) {
      // 🚨 Una lettura fallita NON e' un «non c'e'»: inserire qui creerebbe il
      // doppione che il registro esiste per evitare. Si dichiara il guasto.
      return { ok: false, errore: `non riesco a leggere il registro (${trovata.error.message}), quindi non ci scrivo: non posso escludere di creare una riga doppia.` }
    }

    if (trovata.data) {
      return aggiorna(trovata.data as RigaRegistro, a, adesso)
    }

    // 2) Non c'e': si crea. `numero_chiave` NON si scrive — e' generata dal
    //    database, e una colonna generata non si puo' far divergere a mano.
    const inserita = await supabase
      .from(TABELLA_REGISTRO)
      .insert({
        societa,
        portale,
        numero_fattura: numero,
        data_fattura: data,
        stato: a.stato,
        note: accodaNota(null, a.nota, adesso),
        ...campiNoti(a),
        created_at: adesso,
        updated_at: adesso,
      })
      .select('id')
      .maybeSingle()

    if (!inserita.error && inserita.data) {
      return { ok: true, scritto: true, id: String((inserita.data as { id: string }).id), stato: a.stato, avanzato: true }
    }

    // 3) 🚨 IL VINCOLO DEL DATABASE HA MORSO (23505): fra la lettura e questa
    //    scrittura qualcun altro ha creato la riga. Non e' un errore da
    //    riferire: e' il doppione RIFIUTATO, ed e' il motivo per cui la chiave
    //    unica sta nel database e non in un `if`. Si rilegge e si aggiorna
    //    quella riga.
    const codice = (inserita.error as { code?: string } | null)?.code
    if (codice !== '23505') {
      return { ok: false, errore: inserita.error?.message ?? 'il registro non ha restituito la riga appena creata' }
    }

    const riletta = await supabase
      .from(TABELLA_REGISTRO)
      .select('id, stato, note, spesa_fic_id, td17_fic_id, data_ricezione')
      .eq('societa', societa)
      .eq('portale', portale)
      .eq('numero_chiave', chiave)
      .maybeSingle()
    if (riletta.error || !riletta.data) {
      return { ok: false, errore: `il registro ha rifiutato una riga doppia (vincolo unico) ma poi non me l'ha fatta rileggere: ${riletta.error?.message ?? 'riga non trovata'}` }
    }
    return aggiorna(riletta.data as RigaRegistro, a, adesso)
  } catch (err) {
    return { ok: false, errore: err instanceof Error ? err.message : String(err) }
  }
}

async function aggiorna(riga: RigaRegistro, a: AggiornamentoRegistro, adesso: string): Promise<EsitoRegistro> {
  const { stato, avanzato } = statoRisultante(riga.stato, a.stato)
  const nota = a.stato === DA_VERIFICARE || a.nota
    ? accodaNota(riga.note, a.nota, adesso)
    : riga.note

  const scritta = await supabase
    .from(TABELLA_REGISTRO)
    .update({ stato, note: nota, ...campiNoti(a), updated_at: adesso })
    .eq('id', riga.id)
    .select('id')
    .maybeSingle()

  if (scritta.error || !scritta.data) {
    return { ok: false, errore: scritta.error?.message ?? 'la riga del registro non si e\' fatta aggiornare' }
  }
  return { ok: true, scritto: true, id: riga.id, stato: stato as StatoRegistro, avanzato }
}

/**
 * 🚨 LA RIGA CHE IL TOOL DEVE DIRE quando il registro NON si e' scritto.
 *
 * Il documento su Fatture in Cloud e' NATO: tacere il guasto del registro
 * vorrebbe dire lasciare l'Ingegnere con un registro che dice «non fatto» su
 * un adempimento fatto — e nessuno andrebbe a ripararlo, perche' nessuno
 * saprebbe. Con l'id vero in mano, si allinea a mano in un minuto.
 */
export function avvisoRegistroNonScritto(esito: EsitoRegistro, cosa: { descrizione: string; ficId: string | null }): string | null {
  if (esito.ok) return null
  return `🚨 REGISTRO PORTALI NON AGGIORNATO per ${cosa.descrizione}: ${esito.errore}. `
    + `Il documento su Fatture in Cloud C'E'${cosa.ficId ? ` (id ${cosa.ficId})` : ''} — NON rifarlo. `
    + 'Allinea il registro a mano, oppure richiama il tool quando il registro torna leggibile.'
}
