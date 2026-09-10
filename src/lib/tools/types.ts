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
}
