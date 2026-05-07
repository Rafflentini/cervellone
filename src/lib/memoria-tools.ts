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

// ─── richiama_memoria ────────────────────────────────────────────────────────

export async function richiama_memoria(input: RichiamaInput): Promise<RichiamaResult> {
  const query = input.query?.trim()
  if (!query) return { ok: false, results: [], error: 'query obbligatoria' }

  const limit = input.limit ?? 10
  const filtro = input.tipo_filtro ?? 'tutto'
  const results: RichiamaResult['results'] = []

  // L1: memoria_esplicita (full-text ILIKE)
  if (filtro === 'tutto' || filtro === 'esplicita') {
    const { data, error } = await supabase
      .from('cervellone_memoria_esplicita')
      .select('id, contenuto, tag, created_at')
      .ilike('contenuto', `%${query}%`)
      .order('created_at', { ascending: false })
      .limit(limit)
    if (error) return { ok: false, results: [], error: error.message }
    for (const row of data ?? []) {
      results.push({
        livello: 'esplicita',
        testo: row.contenuto,
        data: row.created_at,
        tag: row.tag ?? undefined,
      })
    }
  }

  // L2: summary_giornaliero (ILIKE su summary_text)
  if (filtro === 'tutto' || filtro === 'summary') {
    const { data, error } = await supabase
      .from('cervellone_summary_giornaliero')
      .select('data, summary_text')
      .ilike('summary_text', `%${query}%`)
      .order('data', { ascending: false })
      .limit(limit)
    if (error) return { ok: false, results: [], error: error.message }
    for (const row of data ?? []) {
      results.push({
        livello: 'summary',
        testo: row.summary_text,
        data: row.data,
      })
    }
  }

  // L3: entita_menzionate (ILIKE su name)
  if (filtro === 'tutto' || filtro === 'entita') {
    const { data, error } = await supabase
      .from('cervellone_entita_menzionate')
      .select('name, type, last_seen_at, mention_count')
      .ilike('name', `%${query}%`)
      .order('last_seen_at', { ascending: false })
      .limit(limit)
    if (error) return { ok: false, results: [], error: error.message }
    for (const row of data ?? []) {
      results.push({
        livello: 'entita',
        testo: `${row.type}: ${row.name} (visto ${row.mention_count}x, ultimo ${row.last_seen_at})`,
        data: row.last_seen_at,
      })
    }
  }

  return { ok: true, results }
}
