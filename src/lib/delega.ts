/**
 * src/lib/delega.ts — IL CONFINE. Il coordinatore chiede, lo specialista lavora.
 *
 * ⚠️ **Tutto quello che questo file protegge sta in una frase:** uno
 * specialista che fallisce deve **dirlo**, e deve dirlo in modo che il
 * coordinatore non possa scambiarlo per una risposta.
 *
 * È il difetto peggiore che questo progetto conosce — l'errore travestito da
 * risultato — e la delega è il posto in cui tornerebbe per primo: fra il
 * coordinatore e lo specialista non c'è un umano che si accorga di qualcosa che
 * non torna.
 *
 * Le quattro regole, e nessuna è negoziabile:
 *
 * 1. **`ok` si deriva dal MOTORE**, da `EsitoTurno.outcome` e `.troncato`, **mai
 *    dal testo del modello**. Un modello che si dichiara riuscito è la stessa
 *    autoaccusa che il 12 set 2026 ha fatto contare un difetto che non c'era.
 * 2. **Sink muto.** Lo specialista non parla all'Ingegnere: la voce è una sola,
 *    quella del coordinatore. Altrimenti due messaggi per un evento.
 * 3. **Perimetro.** Ha in mano i suoi attrezzi e nessun altro, bloccato
 *    all'esecuzione e non solo alla vista.
 * 4. **Try/catch sempre.** Uno specialista può non rispondere affatto —
 *    eccezione, timeout della funzione serverless, FIC che non torna. Un
 *    `reject` salterebbe il tipo di ritorno e risalirebbe al turno del
 *    coordinatore, dove diventa «il bot è rotto».
 */
import { runAgentTurn, sinkMuto, type EsitoTurno } from './claude'
import { toolDi, type Specialista } from './specialisti'

/**
 * Quello che il coordinatore passa allo specialista.
 *
 * ⚠️ **IDENTIFICATIVI, NON RIASSUNTI IN PROSA.** Se il coordinatore scrivesse
 * «le 5 fatture Limongi non pagate trovate prima», lo specialista **rifarebbe
 * la query** e potrebbe trovare un insieme diverso — una fattura registrata nel
 * frattempo, un filtro applicato in modo un po' diverso. L'Ingegnere
 * riceverebbe due risposte plausibili su due insiemi diversi **senza saperlo**:
 * è la forma esatta di «l'insieme presentato non è l'insieme descritto», il
 * difetto più grave del 12 set 2026.
 *
 * Per questo `riferimenti` esiste come campo separato e un test prova che
 * finisce nel messaggio: un conteggio non è un identificativo.
 */
export interface Incarico {
  /** Il compito, in una frase. Non un manuale. */
  compito: string
  /**
   * Gli identificativi esatti di ciò a cui il compito si riferisce: id
   * documento, numero fattura, id cliente. **Mai** «quelle di prima».
   */
  riferimenti?: readonly string[]
  /** Quale delle due società. Lo specialista non deve indovinarlo. */
  societa?: string
  /** Per la telemetria e il registro chiamate: è la conversazione dell'Ingegnere. */
  conversationId?: string
}

export type EsitoSpecialista =
  | {
      ok: true
      risposta: string
      /** I tool che ha ESEGUITO. Da `EsitoTurno.tool_chiamati`, mai dal testo. */
      azioni_fatte: readonly string[]
    }
  | {
      ok: false
      motivo: string
      /**
       * Cosa ha provato, con gli attrezzi veri.
       *
       * **Non è un di più.** Uno specialista che dice solo «non ci sono
       * riuscito» riporta il coordinatore al buio, e il coordinatore riporta al
       * buio l'Ingegnere: è il silenzio che per sei settimane ha tenuto nascosta
       * l'autodiagnosi, riprodotto una scala più in basso.
       */
      cosa_ho_provato: readonly string[]
    }

/**
 * Il messaggio che lo specialista riceve.
 *
 * Separato e esportato perché è la cosa che un test deve poter guardare: il
 * difetto che questo formato previene (identificativi persi in prosa) non si
 * vede dal risultato, si vede solo dal payload.
 */
export function componiMessaggio(incarico: Incarico): string {
  const righe = [incarico.compito]
  if (incarico.societa) righe.push(`Società: ${incarico.societa}`)
  if (incarico.riferimenti?.length) {
    righe.push(
      'Riferimenti esatti su cui lavorare (usa QUESTI, non rifare la ricerca):',
      ...incarico.riferimenti.map((r) => `- ${r}`),
    )
  }
  return righe.join('\n')
}

/**
 * Traduce com'è andato il turno in un esito che il coordinatore può leggere.
 *
 * ⚠️ Guarda `outcome` e `troncato`, **mai il testo**. È l'unico punto in cui si
 * decide se uno specialista ha funzionato, e deve restare l'unico.
 */
export function leggiEsito(turno: EsitoTurno, chi: string): EsitoSpecialista {
  const provati = turno.tool_chiamati
  if (turno.troncato) {
    return {
      ok: false,
      motivo: `${chi} si è fermata a metà: il lavoro ha superato il budget o il numero di passi previsti.`,
      cosa_ho_provato: provati,
    }
  }
  if (turno.outcome !== 'success') {
    // I motivi sono scritti per il COORDINATORE, non per l'Ingegnere: dicono
    // cosa fare, non si scusano.
    const motivi: Record<string, string> = {
      api_error: `${chi} non ha potuto lavorare: errore del modello. Riprova o fallo tu.`,
      empty: `${chi} non ha prodotto nessuna risposta.`,
      force_text: `${chi} ha dovuto chiudere di forza: quello che ha scritto è un riassunto, non un lavoro finito.`,
      hallucination: `${chi} ha promesso un'azione senza averla fatta: NON fidarti di quel testo.`,
      timeout: `${chi} non ha risposto in tempo.`,
      run_aborted: `${chi} si è fermata a metà.`,
    }
    return {
      ok: false,
      motivo: motivi[turno.outcome] ?? `${chi} non è riuscita a concludere (${turno.outcome}).`,
      cosa_ho_provato: provati,
    }
  }
  // ⚠️ Anche con outcome 'success' il testo può essere vuoto: il motore
  // classifica il TURNO, e un turno tecnicamente riuscito che non dice niente
  // non è una risposta. Senza questo controllo il coordinatore riferirebbe il
  // vuoto all'Ingegnere come se fosse un esito.
  if (turno.testo.trim() === '') {
    return {
      ok: false,
      motivo: `${chi} ha chiuso senza scrivere niente.`,
      cosa_ho_provato: provati,
    }
  }
  return { ok: true, risposta: turno.testo, azioni_fatte: provati }
}

/**
 * Gira un incarico a uno specialista e torna **sempre** con un esito.
 *
 * `promptDiSistema` lo passa il chiamante: qui non si costruisce, perché i
 * prompt vivono in `prompts.ts` e averne un secondo posto vorrebbe dire averne
 * due che divergono.
 */
export async function delega(
  chi: Specialista,
  incarico: Incarico,
  promptDiSistema: string,
): Promise<EsitoSpecialista> {
  const messaggio = componiMessaggio(incarico)
  try {
    const turno = await runAgentTurn(
      {
        systemPrompt: promptDiSistema,
        userQuery: incarico.compito,
        messages: [{ role: 'user', content: messaggio }],
        conversationId: incarico.conversationId,
      },
      // Muto: la voce che parla all'Ingegnere è una sola.
      sinkMuto(),
      // `persistUserMessage: false`: l'incarico è un messaggio fra due macchine,
      // non una cosa che l'Ingegnere ha detto. Scriverlo in `messages` gli
      // riempirebbe la cronologia di monologhi interni, e la memoria semantica
      // se li ritroverebbe come se fossero conoscenza.
      { tag: `spec:${chi.chiave}`, entryPoint: `specialista:${chi.chiave}`, persistUserMessage: false },
      { toolConsentiti: new Set(toolDi(chi)) },
    )
    return leggiEsito(turno, chi.nome)
  } catch (err) {
    // ⚠️ Il catch NON è una formalità: è il quinto criterio di riuscita del
    // pilota. Un timeout della funzione serverless o un throw dentro il motore
    // risalirebbe al turno del coordinatore, che morirebbe — e all'Ingegnere
    // arriverebbe «il bot è rotto» invece di «la contabile non ce l'ha fatta,
    // ecco cosa aveva provato».
    //
    // `cosa_ho_provato` qui è VUOTO ed è la verità: il turno non è tornato,
    // quindi non sappiamo cosa abbia eseguito. Riempirlo con un'ipotesi sarebbe
    // esattamente la bugia che questo file esiste per impedire.
    console.error(`[delega:${chi.chiave}] non ha risposto:`, err instanceof Error ? err.message : err)
    return {
      ok: false,
      motivo: `${chi.nome} non ha risposto affatto.`,
      cosa_ho_provato: [],
    }
  }
}
