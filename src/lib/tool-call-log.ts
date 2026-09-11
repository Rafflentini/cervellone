// src/lib/tool-call-log.ts
import { supabase } from './supabase'

// Un registro che fallisce in silenzio e' peggio di nessun registro: sembra
// funzionare. Avvisiamo UNA volta per processo — abbastanza per vederlo nei log
// di Vercel, non abbastanza da inondarli a ogni chiamata di tool.
let giaAvvisato = false
function avvisaUnaVolta(motivo: unknown): void {
  if (giaAvvisato) return
  giaAvvisato = true
  console.warn(`tool_call_log: scrittura fallita, il registro non sta registrando — ${motivo}`)
}

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
    // Il `.catch` da solo era codice IRRAGGIUNGIBILE: il builder PostgREST con
    // `shouldThrowOnError` spento — il default, e quello in uso qui — non
    // rigetta MAI. Lancia solo col flag acceso, e intercetta perfino gli errori
    // di rete convertendoli in una promessa RISOLTA `{ data: null, error }`.
    // Tabella mancante, RLS negata, Supabase giu': tutti e tre risolvono, e
    // l'avviso non poteva scattare. Si guarda il campo `error`; il `.catch`
    // resta per i rigetti veri (flag acceso, o un errore prima della risposta).
    void Promise.resolve(p)
      .then((r) => {
        const e = (r as { error?: { message?: string } } | null)?.error
        if (e) avvisaUnaVolta(e.message ?? e)
      })
      .catch(avvisaUnaVolta)
  } catch (e) {
    avvisaUnaVolta(e)
  }
}
