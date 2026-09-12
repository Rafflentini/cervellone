/**
 * src/lib/comandi-risolvi.ts — da 16 cifre alla bozza, una volta sola per i due
 * canali.
 *
 * PERCHE' ESISTE: il codice nei comandi e' passato da 32 cifre a 16, perche'
 * Telegram riconosce come comando `/` + al massimo 32 caratteri e `/invia_` +
 * 32 cifre ne fa 38 — non cliccabile. Sedici bastano a distinguere le bozze in
 * attesa, ma non sono piu' l'identificativo: vanno RISOLTE contro il database.
 *
 * PERCHE' STA IN UN MODULO SUO, E NON DENTRO OGNI RAMO: i rami dei comandi sono
 * 18, divisi su due route. Risolvere il codice in ognuno sarebbe la 15-copie di
 * `comandi-uuid.ts` un'altra volta. Qui la risoluzione si fa **una volta, in
 * testa al dispatcher**: il testo `/invia_<16>` viene riscritto in
 * `/invia_<uuid canonico>` e tutti i rami esistenti continuano a funzionare
 * senza sapere niente del codice corto.
 *
 * 🚨 E qui sta la guardia: se 16 cifre corrispondono a PIU' di una bozza non si
 * sceglie la piu' recente — si dichiara l'ambiguita' e si chiede il codice
 * lungo. Vedi `risolviPrefisso` in `comandi-uuid.ts`.
 */
import { getSupabaseServer } from '@/lib/supabase-server'
import {
  COMANDI_CON_CODICE,
  ORIGINE_CODICE,
  comandoPrefisso,
  intervalloPrefisso,
  risolviPrefisso,
  type ComandoConCodice,
} from '@/lib/comandi-uuid'

/**
 * L'esito dell'espansione.
 *
 * Tre varianti e non un `string | null`: «il testo non conteneva un codice
 * corto», «eccolo espanso» e «mi fermo e lo dico» sono tre fatti diversi, e un
 * tipo che li tiene separati obbliga il chiamante a decidere per ognuno. E' la
 * voce A1 della lista di controllo tarata: *un guasto non deve poter passare per
 * un'assenza*.
 */
export type EsitoEspansione =
  | { stato: 'invariato' }
  | { stato: 'espanso'; testo: string; nome: ComandoConCodice; uuid: string }
  | { stato: 'fermo'; messaggio: string }

/** Quante righe si guardano al massimo: le bozze contemporanee sono una manciata. */
const MASSIMO_CANDIDATI = 50

function messaggioAmbiguo(prefisso: string, quanti: number): string {
  return [
    `⚠️ NON ho fatto niente: il codice ${prefisso} corrisponde a ${quanti} bozze diverse`,
    'e non voglio indovinare quale intendeva — sceglierne una a caso significherebbe',
    'agire sulla bozza sbagliata.',
    '',
    'Mi rimandi il comando col codice LUNGO (32 cifre) della bozza giusta,',
    'oppure mi dica a voce quale delle due.',
  ].join('\n')
}

function messaggioAssente(prefisso: string): string {
  return [
    `📭 Non trovo nessuna bozza col codice ${prefisso}.`,
    'Puo\' essere che sia scaduta o gia\' processata — oppure che sia io a non',
    'riuscire a vederla. Mi ridica cosa deve fare e la ripreparo.',
  ].join('\n')
}

function messaggioErrore(dettaglio: string): string {
  return [
    '⚠️ NON ho fatto niente: non riesco a leggere le bozze per risolvere il codice',
    `(errore nel database: ${dettaglio}).`,
    'Non e\' detto che la bozza non ci sia — e\' il controllo che non funziona.',
    'Riprovi fra poco col comando che le ho mandato.',
  ].join('\n')
}

/**
 * Se il messaggio comincia con un nostro comando in forma CORTA, riscrive quel
 * comando con l'uuid intero. Altrimenti dice `invariato` senza toccare il
 * database.
 *
 * ⚠️ La lettura del database avviene SOLO quando il testo combacia con
 * `/<famiglia>_<16 cifre>`: un messaggio normale, e un comando in forma lunga,
 * non costano una query.
 */
export async function espandiCodiceBreve(testo: string): Promise<EsitoEspansione> {
  for (const nome of COMANDI_CON_CODICE) {
    const origine = ORIGINE_CODICE[nome]
    if (!origine) continue // famiglia non risolvibile (i `fic_*`): non emette codici corti
    const prefisso = comandoPrefisso(testo, nome)
    if (!prefisso) continue

    const { tabella, colonna } = origine
    const { da, a } = intervalloPrefisso(prefisso)
    let candidati: string[]
    try {
      const { data, error } = await getSupabaseServer()
        .from(tabella)
        .select(colonna)
        .gte(colonna, da)
        .lte(colonna, a)
        .limit(MASSIMO_CANDIDATI)
      // 🚨 A1: l'errore NON diventa un'assenza. Dire «non trovo la bozza»
      // quando il database non risponde manda l'Ingegnere a cercare una bozza
      // scaduta che invece e' li'.
      if (error) {
        console.error('[comandi] risoluzione codice corto fallita', {
          nome,
          tabella,
          prefisso,
          error: error.message,
        })
        return { stato: 'fermo', messaggio: messaggioErrore(error.message) }
      }
      candidati = ((data ?? []) as unknown as Array<Record<string, unknown>>).map((r) =>
        String(r?.[colonna] ?? ''),
      )
    } catch (err: unknown) {
      const dettaglio = err instanceof Error ? err.message : String(err)
      console.error('[comandi] risoluzione codice corto in eccezione', { nome, tabella, dettaglio })
      return { stato: 'fermo', messaggio: messaggioErrore(dettaglio) }
    }

    const esito = risolviPrefisso(prefisso, candidati)
    if (!esito.ok) {
      // La lettura vuota resta loggata: senza `SUPABASE_SERVICE_ROLE_KEY` il
      // client ripiega su anonimo, RLS nega e la lettura torna VUOTA — un
      // guasto travestito da «non c'e' niente». Vedi
      // [[cervellone-lettura-negata-torna-vuota]].
      if (esito.motivo === 'assente') {
        console.warn('[comandi] nessuna bozza col prefisso', { nome, tabella, prefisso })
        return { stato: 'fermo', messaggio: messaggioAssente(prefisso) }
      }
      console.warn('[comandi] prefisso AMBIGUO, non scelgo', {
        nome,
        tabella,
        prefisso,
        quanti: esito.quanti,
      })
      return { stato: 'fermo', messaggio: messaggioAmbiguo(prefisso, esito.quanti) }
    }

    const lungo = `/${nome}_${esito.uuid}`
    const resto = testo.slice(`/${nome}_${prefisso}`.length)
    return { stato: 'espanso', testo: lungo + resto, nome, uuid: esito.uuid }
  }
  return { stato: 'invariato' }
}
