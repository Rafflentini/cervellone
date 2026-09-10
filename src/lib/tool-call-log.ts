// src/lib/tool-call-log.ts
import { supabase } from './supabase'

/**
 * Registra UNA chiamata a un tool. Fire-and-forget deliberato: il registro serve
 * a osservare, non a funzionare. Se Supabase e giu il turno dell'Ingegnere non
 * deve accorgersene — per questo non ritorna una promessa e non lancia mai.
 */
export function registraChiamataTool(
  nome: string,
  conversationId: string | undefined,
  durataMs: number,
  riconosciuto: boolean,
): void {
  try {
    const p = supabase.from('cervellone_tool_calls').insert({
      nome,
      conversation_id: conversationId ?? null,
      durata_ms: durataMs,
      riconosciuto,
    })
    void Promise.resolve(p).catch(() => {})
  } catch {
    // volutamente muto
  }
}
