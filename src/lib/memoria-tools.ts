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

// ─── parseDateInput ──────────────────────────────────────────────────────────

// Mappa giorni italiani → offset JS (0=dom, 1=lun, ..., 6=sab)
const GIORNO_TO_JS: Record<string, number> = {
  'lunedi': 1, 'martedi': 2, 'mercoledi': 3,
  'giovedi': 4, 'venerdi': 5, 'sabato': 6, 'domenica': 0,
}

export function parseDateInput(input: string): string {
  const now = new Date()
  const todayISO = now.toLocaleDateString('sv-SE', { timeZone: 'Europe/Rome' }) // YYYY-MM-DD

  if (input === 'oggi') return todayISO

  if (input === 'ieri') {
    const d = new Date(now)
    d.setDate(d.getDate() - 1)
    return d.toLocaleDateString('sv-SE', { timeZone: 'Europe/Rome' })
  }

  // "lunedi-scorso", "venerdi-scorso", ecc.
  const giornoMatch = input.match(/^([a-z]+)-scorso$/)
  if (giornoMatch) {
    const giornoNorm = giornoMatch[1]
      .normalize('NFD').replace(/[̀-ͯ]/g, '') // rimuovi accenti
      .toLowerCase()
    const targetDay = GIORNO_TO_JS[giornoNorm]
    if (targetDay !== undefined) {
      const d = new Date(now)
      const currentDay = d.getDay() // 0=dom
      let diff = currentDay - targetDay
      if (diff <= 0) diff += 7 // sempre la settimana scorsa
      d.setDate(d.getDate() - diff)
      return d.toLocaleDateString('sv-SE', { timeZone: 'Europe/Rome' })
    }
  }

  // ISO pass-through YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}$/.test(input)) return input

  // Fallback: oggi
  return todayISO
}

// ─── riepilogo_giorno ────────────────────────────────────────────────────────

export async function riepilogo_giorno(input: RiepilogoInput): Promise<RiepilogoResult> {
  const dataISO = parseDateInput(input.data)

  const { data, error } = await supabase
    .from('cervellone_summary_giornaliero')
    .select('data, summary_text, message_count')
    .eq('data', dataISO)
    .maybeSingle()

  if (error) return { ok: false, error: error.message }
  if (!data) return { ok: true, data_iso: dataISO, summary_text: undefined, message_count: 0 }

  return {
    ok: true,
    data_iso: data.data,
    summary_text: data.summary_text,
    message_count: data.message_count,
  }
}
