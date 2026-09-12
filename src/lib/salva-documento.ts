/**
 * src/lib/salva-documento.ts — l'unica strada per scrivere in `documents` il
 * contenuto di un documento che Cervellone compila.
 *
 * Nasce da una misura: il 12 set 2026 `grep "from('documents')"` dava VENTOTTO
 * punti, DIECI dei quali inserivano. Cinque scrivevano il contenuto di un
 * documento compilato, ognuno a modo suo, e nessuno controllava che la partita
 * IVA stampata fosse quella della societa' attiva. Il preventivo, che e' il
 * documento piu' importante, era fra questi.
 *
 * Un secondo modo di scrivere un documento e' un difetto, non una comodita':
 * sarebbe senza guardia, e nessuno se ne accorgerebbe. Il `grep` A7 nella lista
 * tarata sorveglia questa invariante.
 */
import { getSupabaseServer } from './supabase-server'
import { societaPerDocumento } from './societa-documenti'
import { verificaDatiSocietari, messaggioBlocco, type EsitoGuardia } from './guardia-societa'
import { autorizzazioneValida, chiediAutorizzazione } from './guardia-autorizzazioni'

export type EsitoSalvataggio =
  | { ok: true; id: string }
  | { ok: false; motivo: 'dati_societari'; messaggio: string; esito: Extract<EsitoGuardia, { ok: false }> }
  | { ok: false; motivo: 'societa_ignota'; messaggio: string }
  | { ok: false; motivo: 'errore'; messaggio: string }

/**
 * La guardia vera e propria, condivisa da insert e update: risolve la societa'
 * attesa per questa conversazione e confronta il contenuto contro di essa.
 * Un fallimento qui e' o un guasto nel sapere quale societa' e' attiva
 * (`societa_ignota`, un guasto da riferire) o un'incoerenza nei dati stessi
 * (`dati_societari`, un blocco che l'Ingegnere puo' sciogliere). Nessuno dei
 * due indovina: se non sappiamo, non scriviamo.
 *
 * Esportata (non piu' privata) per chi deve salvare PIU' documenti insieme,
 * come `genera_preventivo_completo`: verificarli TUTTI prima di scriverne
 * anche uno solo e' l'unico modo per cui "nessuno dei tre e' stato scritto"
 * resti vero quando lo si dichiara. Verificare un documento alla volta
 * dentro `salvaDocumento`, mescolato alla scrittura, e' quello che permetteva
 * al primo documento di essere gia' salvato mentre il messaggio su un
 * fallimento del secondo o terzo diceva "nessuno".
 */
export async function verificaSalvabile(
  contenuto: string,
  conversationId: string,
): Promise<{ ok: true } | { ok: false; esito: Extract<EsitoSalvataggio, { ok: false }> }> {
  const s = await societaPerDocumento(conversationId)
  if (!s.ok) {
    return {
      ok: false,
      esito: {
        ok: false,
        motivo: 'societa_ignota',
        messaggio: `Non so quale societa' e' attiva (${s.errore}): non genero il documento senza saperlo.`,
      },
    }
  }

  const esito = verificaDatiSocietari(contenuto, s.societa)
  if (!esito.ok) {
    // Task 12 — la via d'uscita: se l'Ingegnere ha gia' tappato
    // /doc_ok_<codice> per QUESTO contenuto, in QUESTA conversazione, non e'
    // un secondo blocco — e' il documento che finalmente si genera.
    // `autorizzazioneValida` la CONSUMA: da qui in poi non vale piu'.
    if (await autorizzazioneValida(conversationId, contenuto)) {
      return { ok: true }
    }
    const { uuid } = await chiediAutorizzazione(conversationId, contenuto, esito)
    return {
      ok: false,
      esito: { ok: false, motivo: 'dati_societari', messaggio: messaggioBlocco(esito, uuid), esito },
    }
  }

  return { ok: true }
}

/**
 * L'UNICO modo per scrivere il contenuto di un documento in `documents`.
 * Un secondo modo e' un difetto: la guardia sui dati societari sta qui.
 */
export async function salvaDocumento(d: {
  nome: string
  contenuto: string
  conversationId: string
  tipo: string
  metadata?: Record<string, unknown>
}): Promise<EsitoSalvataggio> {
  const controllo = await verificaSalvabile(d.contenuto, d.conversationId)
  if (!controllo.ok) return controllo.esito

  try {
    const supabase = getSupabaseServer()
    const { data, error } = await supabase
      .from('documents')
      .insert({
        name: d.nome,
        content: d.contenuto,
        conversation_id: d.conversationId,
        type: d.tipo,
        metadata: d.metadata ?? {},
      })
      .select('id')
      .single()

    const id = (data as { id?: string } | null)?.id
    if (error || !id) {
      return {
        ok: false,
        motivo: 'errore',
        messaggio: `Errore salvando il documento: ${error?.message ?? 'nessun id restituito'}`,
      }
    }
    return { ok: true, id }
  } catch (err) {
    return {
      ok: false,
      motivo: 'errore',
      messaggio: `Errore salvando il documento: ${err instanceof Error ? err.message : String(err)}`,
    }
  }
}

/** Aggiorna il contenuto di una bozza esistente, con la stessa guardia. */
export async function aggiornaContenutoDocumento(
  id: string,
  contenuto: string,
  conversationId: string,
): Promise<EsitoSalvataggio> {
  const controllo = await verificaSalvabile(contenuto, conversationId)
  if (!controllo.ok) return controllo.esito

  try {
    const supabase = getSupabaseServer()

    // Prova con updated_at; se la colonna non esiste, riprova col solo content.
    // Stesso ripiego che aveva draft-tools.ts prima di questa migrazione.
    let { error } = await supabase
      .from('documents')
      .update({ content: contenuto, updated_at: new Date().toISOString() })
      .eq('id', id)

    if (error) {
      const retry = await supabase
        .from('documents')
        .update({ content: contenuto })
        .eq('id', id)
      error = retry.error
    }

    if (error) {
      return { ok: false, motivo: 'errore', messaggio: `Errore aggiornando il documento ${id}: ${error.message}` }
    }
    return { ok: true, id }
  } catch (err) {
    return {
      ok: false,
      motivo: 'errore',
      messaggio: `Errore aggiornando il documento ${id}: ${err instanceof Error ? err.message : String(err)}`,
    }
  }
}
