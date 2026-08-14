// Tipo condiviso delle definizioni tool esposte a Claude.
export interface ToolDefinition {
  name: string
  description: string
  input_schema: Record<string, unknown>
}
