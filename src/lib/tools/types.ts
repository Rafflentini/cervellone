// Tipo condiviso delle definizioni tool esposte a Claude.
export interface ToolDefinition {
  name: string
  description: string
  input_schema: Record<string, unknown>
  // Marcato true, il tool resta DICHIARATO nella richiesta ma non entra nel
  // contesto del modello finche' non lo trova cercandolo. L'esecuzione non
  // cambia: executeTool non guarda le definizioni.
  defer_loading?: boolean
}

export interface OpzioniTool {
  /** I tool che restano sempre caricati. Gli altri vengono differiti. */
  nucleo?: ReadonlySet<string>
  /** Dichiara il tool server con cui il modello cerca da se' quelli differiti. */
  ricerca?: boolean
  /**
   * **SOLO questi.** Gli altri non vengono differiti: non vengono proprio
   * dichiarati.
   *
   * Serve agli specialisti del Decollo: la contabile deve avere in mano gli
   * attrezzi della contabilita' e **nient'altro**. Differirli non basterebbe —
   * un tool differito e' comunque raggiungibile con `tool_search_tool_bm25`,
   * quindi uno specialista «limitato» cosi' potrebbe cercarsi la posta e
   * mandarla.
   *
   * ⚠️ **Questa meta' e' solo la vista, e la vista non e' una guardia.** Il
   * modello puo' chiedere un tool che non gli e' stato dichiarato — basta che
   * ne indovini il nome. Il blocco vero e' all'ESECUZIONE, in `claude.ts`, e
   * senza quello questo campo e' cosmesi.
   *
   * Quando c'e', `nucleo` e `ricerca` non si applicano: gli attrezzi di uno
   * specialista sono pochi e stanno tutti caricati, e non c'e' nulla da
   * cercare.
   */
  soloQuesti?: ReadonlySet<string>
}
