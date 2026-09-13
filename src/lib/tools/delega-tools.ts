/**
 * src/lib/tools/delega-tools.ts — LA PORTA. Come il coordinatore chiama uno
 * specialista.
 *
 * ⚠️ **SPENTA DI DEFAULT.** Senza `DECOLLO=1` il tool esiste nel registro ma
 * rifiuta, e spiega perché. È la stessa forma di `TOOL_DEFER`: si accende con
 * una variabile su Vercel e si spegne in un secondo, senza toccare il codice.
 *
 * Il tool resta nel registro anche da spento **di proposito**. Un tool che
 * compare e scompare a seconda di una variabile romperebbe le due guardie
 * anti-buco della mappa dell'officina, che sono la ragione per cui il Decollo
 * può esistere: si spegnerebbe la difesa insieme alla funzione.
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

/** L'interruttore. Spento finché non vale esattamente '1'. */
export function decolloAcceso(): boolean {
  return process.env.DECOLLO === '1'
}

export const DELEGA_TOOLS: ToolDefinition[] = [
  {
    name: 'chiedi_alla_contabile',
    description:
      "Gira un lavoro di contabilita' alla contabile, uno specialista che ha in mano SOLO Fatture in Cloud, " +
      'prima nota, movimenti e riconciliazioni, e che quindi ci lavora senza distrarsi. ' +
      "Usala per: quali fatture non sono pagate, cosa c'e' scritto sull'allegato di una fattura, " +
      'modalita di pagamento dichiarate dal fornitore, movimenti, riconciliazioni, prima nota. ' +
      "IMPORTANTE: passale gli IDENTIFICATIVI esatti (numero fattura, id documento), MAI descrizioni " +
      "tipo 'quelle di prima': senza gli id rifara' la ricerca e potrebbe trovare un insieme diverso dal tuo. " +
      "La contabile PREPARA ma non esegue azioni irreversibili: se serve confermare o inviare qualcosa, " +
      "torna a te e la conferma la chiedi TU all'Ingegnere.",
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
            "Gli identificativi esatti su cui lavorare: numeri fattura ('2/1144'), id documento. " +
            "OBBLIGATORI quando il compito si riferisce a cose che hai gia' trovato tu.",
        },
        societa: {
          type: 'string',
          description: "Quale societa': 'Restruktura' o 'La Real Estate'. Prendila dal contesto, non farla indovinare.",
        },
      },
      required: ['compito'],
    },
  },
]

export async function executeDelegaTool(
  name: string,
  input: Record<string, unknown>,
  conversationId?: string,
): Promise<string | null> {
  if (name !== 'chiedi_alla_contabile') return null

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
  const [{ delega, perimetroDiLavoro }, { specialista }, { getPromptSpecialista }] = await Promise.all([
    import('../delega'),
    import('../specialisti'),
    import('../prompts'),
  ])

  const contabile = specialista('contabile')
  const esito = await delega(
    contabile,
    {
      compito: String(input.compito ?? ''),
      riferimenti: Array.isArray(input.riferimenti) ? input.riferimenti.map(String) : undefined,
      societa: input.societa ? String(input.societa) : undefined,
      conversationId,
    },
    getPromptSpecialista({
      nome: contabile.nome,
      quando: contabile.quando,
      toolDisponibili: [...perimetroDiLavoro(contabile)],
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
