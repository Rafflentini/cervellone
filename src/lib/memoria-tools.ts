// src/lib/memoria-tools.ts — Memoria persistente cross-sessione
import { supabase } from '@/lib/supabase'

// ─── Types ───────────────────────────────────────────────────────────────────

export interface RicordaInput {
  testo: string
  tag?: string
  source?: 'telegram' | 'web' | 'tool' | 'cron'
  conversation_id?: string
}

export interface RicordaResult {
  ok: boolean
  id?: string
  error?: string
}

export interface RichiamaInput {
  query: string
  tipo_filtro?: 'esplicita' | 'summary' | 'entita' | 'tutto'
  limit?: number
}

export interface RichiamaResult {
  ok: boolean
  results: Array<{
    livello: 'esplicita' | 'summary' | 'entita' | 'rag'
    testo: string
    data?: string
    tag?: string
  }>
  error?: string
}

export interface RiepilogoInput {
  data: string // 'oggi', 'ieri', 'YYYY-MM-DD', 'lunedi-scorso', ecc.
}

export interface RiepilogoResult {
  ok: boolean
  data_iso?: string
  summary_text?: string
  message_count?: number
  error?: string
}

export interface ListaEntitaInput {
  tipo?: 'cliente' | 'cantiere' | 'fornitore'
  limit?: number
}

export interface ListaEntitaResult {
  ok: boolean
  entita: Array<{
    name: string
    type: string
    last_seen_at: string
    mention_count: number
  }>
  error?: string
}

// ─── ricorda ────────────────────────────────────────────────────────────────

export async function ricorda(input: RicordaInput): Promise<RicordaResult> {
  if (!input.testo || input.testo.trim() === '') {
    return { ok: false, error: 'Il campo testo è obbligatorio e non può essere vuoto.' }
  }

  const { data, error } = await supabase.from('cervellone_memoria_esplicita').insert({
    contenuto: input.testo.trim(),
    tag: input.tag ?? null,
    source: input.source ?? 'tool',
    conversation_id: input.conversation_id ?? null,
  }).select('id')

  if (error) {
    return { ok: false, error: error.message }
  }

  return { ok: true, id: data?.[0]?.id }
}
