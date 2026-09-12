/**
 * src/lib/guardia-autorizzazioni.ts — la via d'uscita dal blocco sui dati
 * societari: un codice tappabile, una volta, per QUEL documento.
 *
 * PERCHE' ESISTE. `messaggioBlocco` (guardia-societa.ts) prometteva «se e'
 * voluto, dimmelo e lo genero comunque», ma quel modo di procedere non
 * esisteva: se l'Ingegnere rispondeva a voce, il modello ritentava, la
 * guardia bloccava di nuovo, e si otteneva un giro a vuoto — la stessa
 * frustrazione di cui si e' lamentato il 12 set 2026 («mi ha chiesto
 * conferma 4 volte senza inviarla davvero»). Il caso e' reale, non teorico:
 * le due societa' fanno affari fra loro, e un preventivo con l'altra come
 * committente porta legittimamente la sua P.IVA nel corpo.
 *
 * LE CINQUE SCELTE CHE RENDONO QUESTA VIA D'USCITA SICURA (task-12-brief.md):
 *
 *  1. Legata all'IMPRONTA del contenuto (md5), non alla conversazione:
 *     autorizzare "questa conversazione" spegnerebbe la guardia per tutto il
 *     resto della giornata — il primo documento controllato, i dieci dopo
 *     no. Un'autorizzazione che vale per tutto e' la guardia disattivata con
 *     un nome gentile.
 *  2. Scade (`AUTORIZZAZIONE_TTL_MS`, 30 minuti): il tempo di leggere e
 *     tappare, non il tempo di dimenticarsene.
 *  3. La concede l'INGEGNERE tappando, non il modello: nessun tool puo'
 *     chiamare `concediAutorizzazione`, perche' se potesse la guardia
 *     dipenderebbe dal giudizio che la guardia esiste per non dover usare.
 *     Il ramo che la consuma sta nei route dei canali, dove il modello non
 *     arriva.
 *  4. Dice cosa autorizza: `chiediAutorizzazione` registra le partite IVA
 *     che comparirebbero (`esito.trovate`), cosi' il messaggio con il
 *     codice le puo' nominare — si autorizza una cosa che si e' letta.
 *  5. Si usa una volta: `autorizzazioneValida` la CONSUME atomicamente alla
 *     prima verifica che la trova valida. Una autorizzazione riutilizzabile
 *     e' un'autorizzazione dimenticata.
 *
 * Tabella `cervellone_guardia_autorizzazioni`, chiave `uuid` (testo), NON
 * `id` — e' il difetto A2 (mail in sospeso, tre mesi in produzione).
 */
import { randomUUID, createHash } from 'crypto'
import { getSupabaseServer } from './supabase-server'
import type { EsitoGuardia } from './guardia-societa'

const TABELLA = 'cervellone_guardia_autorizzazioni'

/** Trenta minuti: il tempo di leggere e tappare, non di dimenticarsene. */
export const AUTORIZZAZIONE_TTL_MS = 30 * 60 * 1000

/**
 * La forma concettuale di un'autorizzazione. Non e' il tipo della riga nel
 * database (li' i campi sono snake_case e la scadenza e i due momenti del
 * ciclo di vita — concessa, usata — sono colonne separate, non un solo
 * numero): e' il contratto pubblico di questo modulo, dato dal brief.
 */
export type Autorizzazione = {
  uuid: string
  conversationId: string
  /** md5 del contenuto autorizzato: autorizza QUEL documento, non «tutti». */
  impronta: string
  /** Le partite IVA che l'Ingegnere ha accettato di vedere nel documento. */
  piveAccettate: string[]
  scadenza: number
}

type RigaAutorizzazione = {
  uuid: string
  conversation_id: string
  impronta: string
  pive_accettate: string[] | null
  scadenza: string
  concessa_at: string | null
  usata_at: string | null
}

function impronta(contenuto: string): string {
  return createHash('md5').update(contenuto).digest('hex')
}

function scaduta(row: Pick<RigaAutorizzazione, 'scadenza'>): boolean {
  return new Date(row.scadenza).getTime() < Date.now()
}

/**
 * Registra un blocco in attesa e restituisce il codice da mostrare.
 *
 * Un fallimento della scrittura non ha un ripiego onesto: senza la riga il
 * codice che stiamo per mostrare non sarebbe mai risolvibile. Si logga, e si
 * restituisce comunque un uuid — il chiamante mostra il messaggio di
 * blocco, anche se in quel caso raro la via d'uscita non funzionerebbe
 * davvero. Meglio di far esplodere l'intera generazione per un guasto sulla
 * tabella di servizio.
 */
export async function chiediAutorizzazione(
  conversationId: string,
  contenuto: string,
  esito: Extract<EsitoGuardia, { ok: false }>,
): Promise<{ uuid: string }> {
  const uuid = randomUUID()
  const scadenza = new Date(Date.now() + AUTORIZZAZIONE_TTL_MS).toISOString()

  const { error } = await getSupabaseServer()
    .from(TABELLA)
    .insert({
      uuid,
      conversation_id: conversationId,
      impronta: impronta(contenuto),
      pive_accettate: esito.trovate.map((t) => t.piva),
      scadenza,
    })

  if (error) {
    console.error('[guardia-autorizzazioni] registrazione fallita:', error.message)
  }

  return { uuid }
}

/**
 * L'Ingegnere ha tappato il codice: da qui in poi l'autorizzazione E'
 * concessa (non ancora usata — quello succede alla generazione).
 *
 * Tre modi di fallire, e tre motivi diversi: non trovata, scaduta, gia'
 * concessa. Un rifiuto muto costringerebbe a indovinare, ed e' il difetto
 * che questo intero lavoro esiste per chiudere.
 */
export async function concediAutorizzazione(
  uuid: string,
): Promise<{ ok: true } | { ok: false; motivo: string }> {
  const supabase = getSupabaseServer()

  const { data, error } = await supabase
    .from(TABELLA)
    .select('uuid, scadenza, concessa_at, usata_at')
    .eq('uuid', uuid)
    .maybeSingle()

  if (error) return { ok: false, motivo: `errore nel database: ${error.message}` }
  if (!data) return { ok: false, motivo: 'codice non trovato: puo\' essere scaduto da tempo' }

  const row = data as RigaAutorizzazione
  if (row.usata_at) return { ok: false, motivo: 'questo codice e\' gia\' stato usato' }
  if (scaduta(row)) return { ok: false, motivo: 'questo codice e\' scaduto' }
  if (row.concessa_at) return { ok: false, motivo: 'questo codice e\' gia\' stato concesso' }

  // `.eq('concessa_at', null)` non esiste in PostgREST (va `.is`): la
  // condizione atomica evita che due tap quasi simultanei concedano
  // entrambi con successo.
  const { data: aggiornata, error: errAgg } = await supabase
    .from(TABELLA)
    .update({ concessa_at: new Date().toISOString() })
    .eq('uuid', uuid)
    .is('concessa_at', null)
    .select('uuid')

  if (errAgg) return { ok: false, motivo: `errore nel database: ${errAgg.message}` }
  if (!aggiornata || aggiornata.length === 0) {
    return { ok: false, motivo: 'questo codice e\' gia\' stato concesso' }
  }
  return { ok: true }
}

/**
 * Chi genera chiede: questo contenuto e' gia' autorizzato?
 *
 * Vera SOLO se esiste una riga per QUESTA conversazione con l'IMPRONTA di
 * QUESTO contenuto, concessa, non scaduta e non ancora usata — e in quel
 * caso la CONSUME atomicamente prima di rispondere: una seconda chiamata con
 * lo stesso contenuto trova la riga gia' usata e torna `false`. E' la scelta
 * 5 del disegno: un'autorizzazione riutilizzabile e' un'autorizzazione
 * dimenticata.
 */
export async function autorizzazioneValida(conversationId: string, contenuto: string): Promise<boolean> {
  const supabase = getSupabaseServer()
  const cercata = impronta(contenuto)

  const { data, error } = await supabase
    .from(TABELLA)
    .select('uuid, scadenza, concessa_at, usata_at')
    .eq('conversation_id', conversationId)
    .eq('impronta', cercata)
    .is('usata_at', null)
    .order('created_at', { ascending: false })
    .limit(1)

  if (error) {
    console.error('[guardia-autorizzazioni] lettura fallita:', error.message)
    return false
  }
  const righe = (data ?? []) as RigaAutorizzazione[]
  const row = righe[0]
  if (!row) return false
  if (!row.concessa_at) return false
  if (scaduta(row)) return false

  const { data: consumata, error: errCons } = await supabase
    .from(TABELLA)
    .update({ usata_at: new Date().toISOString() })
    .eq('uuid', row.uuid)
    .is('usata_at', null)
    .select('uuid')

  if (errCons) {
    console.error('[guardia-autorizzazioni] consumo fallito:', errCons.message)
    return false
  }
  return !!consumata && consumata.length > 0
}
