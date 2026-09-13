/**
 * src/lib/tools/delega-tools.ts — LA PORTA. Come il coordinatore chiama uno
 * specialista.
 *
 * ⚠️ **SPENTA DI DEFAULT.** Senza `DECOLLO=1` il tool esiste nel registro ma
 * rifiuta, e spiega perché. È la stessa forma di `TOOL_DEFER`: si accende con
 * una variabile su Vercel: non si tocca il codice, ma il deployment va rifatto
 * (`npx vercel redeploy <url>`) — su Vercel le variabili d'ambiente sono legate
 * al DEPLOYMENT, non al progetto. Non e' un secondo.
 *
 * Il tool resta nel registro anche da spento **di proposito**: un tool che
 * compare e scompare a seconda di una variabile d'ambiente sfuggirebbe a
 * qualunque guardia che legge il registro, e si spegnerebbe la sorveglianza
 * insieme alla funzione — che è il modo in cui un interruttore diventa un buco.
 *
 * ⚠️ Una versione precedente di questa nota diceva «romperebbe le guardie
 * anti-buco della **mappa**»: impreciso, e l'audit del 13 set 2026 l'ha
 * rilevato come contraddizione. Da quella guardia questo tool è **esentato**
 * (`TOOL_DEL_COORDINATORE`): non appartiene a nessun mestiere. A sorvegliarlo
 * sono i tre test dell'esenzione in `mappa-officina.test.ts`, primo fra tutti
 * quello che lega l'esenzione a `DELEGA_TOOLS`.
 *
 * ⚠️ **E il coordinatore non delega mai un'azione irreversibile.** Non perché
 * gli sia vietato qui, ma perché lo specialista non ha quegli attrezzi in mano:
 * v. `perimetroDiLavoro` in `delega.ts`, dove la regola di Raffaele sta nel
 * valore predefinito. La contabile **prepara**; a chiedere «invio?» è il
 * coordinatore, e a rispondere è l'Ingegnere.
 */
/**
 * ⚠️ **NIENTE import di `delega`, `claude` o `prompts` qui in cima.**
 *
 * Esiste un ciclo: `tools.ts` → questo file → `delega.ts` → `claude.ts` →
 * `tools.ts`. Con gli import statici, al momento del caricamento `DELEGA_TOOLS`
 * risulta `undefined` proprio mentre `tools.ts` prova a spanderlo dentro
 * `ALL_TOOLS`, e il registro esplode con «DELEGA_TOOLS is not iterable».
 *
 * L'ha fatto vedere subito un test, il 13 set 2026. Se fosse passato, sarebbe
 * stato il peggior tipo di guasto: si manifesta o no a seconda di quale file
 * viene caricato per primo, quindi puo' funzionare in locale e non su Vercel,
 * o funzionare per settimane e rompersi il giorno che qualcuno aggiunge un
 * import altrove.
 *
 * Le definizioni restano statiche — servono al registro subito — e
 * l'ESECUTORE carica quello che gli serve quando viene chiamato, che e' molto
 * dopo che tutti i moduli si sono assestati.
 */
import type { ToolDefinition } from './types'
// ⚠️ `specialisti` e `mappa-officina` NON sono nel ciclo: il primo importa solo
// il secondo, e il secondo solo `interruttori` (che non importa niente). Un test cammina il grafo degli
// import da questo file e verifica che non raggiunga MAI `tools.ts` — e' quella
// la regola, non un elenco di nomi vietati.
import { specialistiConPorta, specialistaDellaPorta, type Specialista } from '../specialisti'
import { interruttoreAcceso } from '../interruttori'

/** L'interruttore. Spento finché non vale '1' (gli spazi ai bordi non contano, v. `interruttori.ts`). */
export function decolloAcceso(): boolean {
  return interruttoreAcceso('DECOLLO')
}

/**
 * La descrizione che il modello legge per decidere se delegare.
 *
 * ⚠️ **Generata, non scritta a mano.** Le parti che valgono per TUTTI gli
 * specialisti — gli identificativi esatti, il «prepara ma non esegue», la
 * società attiva — stanno scritte **una volta sola**, qui. Quello che cambia da
 * uno all'altro è solo `usala_per`, e sta nel registro accanto ai suoi attrezzi.
 *
 * Con una copia per specialista, la seconda porta sarebbe nata già disallineata
 * dalla prima: è lo stesso marciume che `specialisti.ts` esiste per impedire,
 * un piano più in basso.
 */
function descrizione(s: Specialista): string {
  return (
    `Gira un lavoro a ${s.nome}, uno specialista che ha in mano SOLO gli attrezzi del suo mestiere ` +
    `(${s.quando}) e che quindi ci lavora senza distrarsi. ` +
    `Usalo per: ${s.porta!.usala_per}. ` +
    "IMPORTANTE: passagli gli IDENTIFICATIVI esatti (numero fattura, id documento, codice voce), MAI descrizioni " +
    "tipo 'quelle di prima': senza gli id rifara' la ricerca e potrebbe trovare un insieme diverso dal tuo. " +
    "PREPARA ma non esegue azioni irreversibili: se serve confermare, inviare o trasmettere qualcosa, " +
    "torna a te e la conferma la chiedi TU all'Ingegnere. " +
    "LAVORA SEMPRE sulla societa' ATTIVA della conversazione, e non la puoi cambiare da qui: se il lavoro " +
    "riguarda l'altra societa', cambia prima societa' attiva con imposta_societa_attiva, poi chiamalo."
  )
}

/**
 * Una porta per ogni specialista che ne ha una.
 *
 * ⚠️ **Derivate dal registro.** Aggiungere uno specialista al Decollo costa una
 * riga in `specialisti.ts` (il campo `porta`): la definizione, il testo e
 * l'instradamento vengono da lì. Questo è il punto del passo 5 — non «un
 * secondo specialista scritto a mano», ma **la prova che il secondo costa
 * quanto una riga**.
 */
export const DELEGA_TOOLS: ToolDefinition[] = specialistiConPorta().map((s) => ({
  name: s.porta!.tool,
  description: descrizione(s),
  input_schema: {
    type: 'object',
    properties: {
      compito: {
        type: 'string',
        description: "Il lavoro, in una frase. Es: 'quali fatture Limongi 2026 non sono pagate'.",
      },
      riferimenti: {
        type: 'array',
        items: { type: 'string' },
        description:
          "Gli identificativi esatti su cui lavorare: numeri fattura ('2/1144'), id documento, codici voce. " +
          "OBBLIGATORI quando il compito si riferisce a cose che hai gia' trovato tu.",
      },
    },
    required: ['compito'],
  },
}))

export async function executeDelegaTool(
  name: string,
  input: Record<string, unknown>,
  conversationId?: string,
): Promise<string | null> {
  // Instradamento DERIVATO: il registro sa di chi è questa porta. Un `if` per
  // nome sarebbe la terza copia dello stesso elenco.
  const chi = specialistaDellaPorta(name)
  if (!chi) return null

  if (!decolloAcceso()) {
    // ⚠️ Il rifiuto dice al coordinatore COSA FARE, non solo che non si puo'.
    // Un «non disponibile» secco lo farebbe rispondere «non posso farlo»
    // all'Ingegnere — la frase che questo progetto combatte da mesi — mentre gli
    // attrezzi per farlo da solo ce li ha tutti.
    return JSON.stringify({
      ok: false,
      motivo: 'La delega agli specialisti non e\' attiva (interruttore DECOLLO spento).',
      cosa_faccio_adesso: 'Fai tu il lavoro con i tuoi attrezzi, come hai sempre fatto. Non dire che non si puo\'.',
    })
  }

  // Import dinamici: v. la nota in cima al file. Qui il ciclo non esiste più,
  // perché siamo a runtime e i moduli sono tutti caricati.
  const [{ delega, perimetroDiLavoro }, { getPromptSpecialista }, { leggiSocietaAttiva }, { listaSocieta }] =
    await Promise.all([
      import('../delega'),
      import('../prompts'),
      import('../societa-attiva'),
      import('../societa'),
    ])

  // 🚨 LA SOCIETA' SI LEGGE, NON SI RICEVE A PAROLE.
  //
  // La prima stesura aveva un parametro `societa` che il coordinatore
  // riempiva. Non commutava NIENTE: gli attrezzi della contabile passano tutti
  // dal wrapper `contabile()` in `tools.ts`, che ricava la societa' da
  // `societaDellaConversazione(conversationId)` e non guarda mai l'input.
  //
  // Lo scenario, trovato dall'audit del 13 set 2026: conversazione su
  // Restruktura, l'Ingegnere chiede «e per La Real Estate?», il coordinatore
  // obbedisce alla descrizione e passa `societa: 'La Real Estate'`. La
  // contabile riceve un messaggio che dice La Real Estate, legge le fatture di
  // **Restruktura**, e le riferisce come La Real Estate. Non se ne accorge
  // nessuno: ne' lei, ne' il coordinatore, ne' l'Ingegnere.
  //
  // E' testualmente il difetto che `tools.ts` dichiara chiuso — «il bot
  // dichiarerebbe di lavorare per un'azienda mentre legge e scrive i dati
  // dell'altra» — riaperto un piano piu' su. Il parametro e' stato TOLTO: la
  // societa' si legge dalla stessa fonte che useranno i suoi attrezzi, quindi
  // quello che le si dice e quello che leggera' non possono divergere.
  //
  // Se non si riesce a leggerla NON si tira a indovinare e non si delega: un
  // lavoro contabile sulla societa' sbagliata e' peggio di un lavoro non fatto.
  //
  // ⚠️ Senza conversazione non si delega AFFATTO, e non e' pedanteria: gli
  // attrezzi che toccano dati societari passano dal wrapper `contabile()` in
  // `tools.ts`, che senza `conversationId` rifiuta uno per uno — e un documento
  // ha comunque bisogno dell'intestazione giusta. Delegare lo stesso vorrebbe
  // dire bruciare un turno intero — modello, token, secondi — per farsi dire
  // dieci volte «non so su quale societa' stiamo lavorando». Meglio dirlo
  // subito e gratis. Rilevato dall'audit del 13 set 2026.
  if (!conversationId) {
    return JSON.stringify({
      ok: false,
      motivo: `Non posso delegare senza conversazione: ${chi.nome} non saprebbe su quale societa' lavorare.`,
      cosa_faccio_adesso: 'Fai tu il lavoro con i tuoi attrezzi.',
    })
  }
  const attiva = await leggiSocietaAttiva(conversationId)
  if (!attiva.ok) {
    return JSON.stringify({
      ok: false,
      motivo: `Non riesco a leggere quale societa' e' attiva (${attiva.errore}). Non delego senza saperlo.`,
      cosa_faccio_adesso: "Chiedi all'Ingegnere su quale societa' state lavorando, poi riprova.",
    })
  }
  const nomeSocieta = listaSocieta().find((s) => s.codice === attiva.codice)?.denominazione ?? attiva.codice

  const esito = await delega(
    chi,
    {
      compito: String(input.compito ?? ''),
      riferimenti: Array.isArray(input.riferimenti) ? input.riferimenti.map(String) : undefined,
      societa: nomeSocieta,
      conversationId,
    },
    getPromptSpecialista({
      nome: chi.nome,
      quando: chi.quando,
      toolDisponibili: [...perimetroDiLavoro(chi)],
    }),
  )

  // ⚠️ Su un fallimento si aggiunge l'istruzione per il coordinatore, e serve.
  // Senza, un `ok: false` verrebbe riferito all'Ingegnere come «la contabile
  // non ce l'ha fatta» — che per lui e' un muro, non una risposta. Il
  // coordinatore ha ancora tutti gli attrezzi: puo' farlo lui.
  if (!esito.ok) {
    return JSON.stringify({
      ...esito,
      cosa_faccio_adesso:
        'Riprova tu con i tuoi attrezzi. Se nemmeno tu ci riesci, dillo all\'Ingegnere spiegando ' +
        'cosa e\' stato provato — mai un "non si puo\' fare" secco.',
    })
  }
  return JSON.stringify(esito)
}
