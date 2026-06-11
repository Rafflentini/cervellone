// src/lib/document-templates.ts — Modelli documento (binario A): tipi + CRUD
import { getSupabaseServer } from '@/lib/supabase-server'

export type CampoTipo = 'testo' | 'data' | 'numero' | 'tabella' | 'scelta'

export interface CampoColonna { nome: string; tipo: CampoTipo }

export interface CampoModello {
  nome: string
  label: string
  tipo: CampoTipo
  obbligatorio: boolean
  default?: unknown
  descrizione?: string
  colonne?: CampoColonna[] // solo tipo 'tabella'
}

export type MetodoModello = 'B_html' | 'builtin_cigo'

export interface DocumentTemplate {
  slug: string
  titolo: string
  parole_chiave: string[]
  tipo_sorgente: string
  metodo: MetodoModello
  master_drive_id?: string | null
  html_template?: string | null
  campi: CampoModello[]
  dati_fissi: Record<string, unknown>
  formati_output: string[]
  dove_salvare?: string | null
  mai_inviare: boolean
}

export interface CreateTemplateInput {
  slug: string
  titolo: string
  parole_chiave?: string[]
  tipo_sorgente: string
  metodo: MetodoModello
  master_drive_id?: string | null
  html_template?: string | null
  campi: CampoModello[]
  dati_fissi?: Record<string, unknown>
  formati_output?: string[]
  dove_salvare?: string | null
  mai_inviare?: boolean
}

/**
 * Strips unsafe HTML constructs from a template before storage:
 * - <script ...>...</script> blocks (including multiline)
 * - on* inline event handlers (onclick=, onload=, etc.)
 * - javascript: URL schemes
 */
export function stripUnsafeHtml(html: string): string {
  // Remove <script>...</script> blocks (case-insensitive, dotall)
  let out = html.replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, '')
  // Remove on* inline event handler attributes: on[alpha]+=...  (single/double quoted or unquoted up to space/>)
  out = out.replace(/\bon\w+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]*)/gi, '')
  // Replace javascript: URLs with #
  out = out.replace(/javascript\s*:/gi, '#')
  return out
}

export function normalizeSlug(raw: string): string {
  return raw
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // accenti
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')     // non-alfanumerico -> underscore
    .replace(/_+/g, '_')             // collassa underscore
    .replace(/^_|_$/g, '')           // taglia ai bordi
}

const SELECT_COLS =
  'slug, titolo, parole_chiave, tipo_sorgente, metodo, master_drive_id, html_template, campi, dati_fissi, formati_output, dove_salvare, mai_inviare'

function rowToTemplate(row: Record<string, unknown>): DocumentTemplate {
  return {
    slug: row.slug as string,
    titolo: row.titolo as string,
    parole_chiave: (row.parole_chiave as string[]) ?? [],
    tipo_sorgente: row.tipo_sorgente as string,
    metodo: row.metodo as MetodoModello,
    master_drive_id: (row.master_drive_id as string | null) ?? null,
    html_template: (row.html_template as string | null) ?? null,
    campi: (row.campi as CampoModello[]) ?? [],
    dati_fissi: (row.dati_fissi as Record<string, unknown>) ?? {},
    formati_output: (row.formati_output as string[]) ?? ['pdf'],
    dove_salvare: (row.dove_salvare as string | null) ?? null,
    mai_inviare: (row.mai_inviare as boolean) ?? true,
  }
}

export async function createTemplate(
  input: CreateTemplateInput,
): Promise<{ ok: boolean; slug?: string; error?: string }> {
  const slug = normalizeSlug(input.slug)
  if (!slug) return { ok: false, error: 'slug non valido' }
  if (!input.titolo?.trim()) return { ok: false, error: 'titolo obbligatorio' }
  if (!Array.isArray(input.campi)) return { ok: false, error: 'campi deve essere un array' }

  // FIX 5: B_html requires html_template; enforce size limit; sanitize
  if (input.metodo === 'B_html' && !input.html_template) {
    return { ok: false, error: 'Il metodo B_html richiede un html_template' }
  }
  if (input.html_template && input.html_template.length > 500_000) {
    return { ok: false, error: 'html_template troppo grande (max 500KB)' }
  }
  const safeHtmlTemplate = input.html_template ? stripUnsafeHtml(input.html_template) : null

  const supabase = getSupabaseServer()
  const { error } = await supabase
    .from('document_templates')
    .upsert(
      {
        slug,
        titolo: input.titolo.trim(),
        parole_chiave: input.parole_chiave ?? [],
        tipo_sorgente: input.tipo_sorgente,
        metodo: input.metodo,
        master_drive_id: input.master_drive_id ?? null,
        html_template: safeHtmlTemplate,
        campi: input.campi,
        dati_fissi: input.dati_fissi ?? {},
        formati_output: input.formati_output ?? ['pdf'],
        dove_salvare: input.dove_salvare ?? null,
        mai_inviare: input.mai_inviare ?? true,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'slug' },
    )

  if (error) return { ok: false, error: error.message }
  return { ok: true, slug }
}

export async function getTemplate(slug: string): Promise<DocumentTemplate | null> {
  const supabase = getSupabaseServer()
  const { data, error } = await supabase
    .from('document_templates')
    .select(SELECT_COLS)
    .eq('slug', normalizeSlug(slug))
    .maybeSingle()
  if (error || !data) return null
  return rowToTemplate(data as Record<string, unknown>)
}

export async function listTemplates(): Promise<
  Array<{ slug: string; titolo: string; parole_chiave: string[] }>
> {
  const supabase = getSupabaseServer()
  const { data, error } = await supabase
    .from('document_templates')
    .select('slug, titolo, parole_chiave')
    .order('updated_at', { ascending: false })
    .limit(50)
  if (error || !data) return []
  return (data as Array<Record<string, unknown>>).map((r) => ({
    slug: r.slug as string,
    titolo: r.titolo as string,
    parole_chiave: (r.parole_chiave as string[]) ?? [],
  }))
}

/**
 * Ritorna i dati minimi di tutti i modelli (slug, titolo, parole_chiave, campi, dati_fissi)
 * per la costruzione del blocco di injection nel system prompt.
 * Best-effort: ritorna [] su errore o tabella vuota.
 */
export async function listTemplatesForInjection(): Promise<
  Array<{
    slug: string
    titolo: string
    parole_chiave: string[]
    campi: CampoModello[]
    dati_fissi: Record<string, unknown>
  }>
> {
  try {
    const supabase = getSupabaseServer()
    const { data, error } = await supabase
      .from('document_templates')
      .select('slug, titolo, parole_chiave, campi, dati_fissi')
      .limit(50)
    if (error || !data) return []
    return (data as Array<Record<string, unknown>>).map((r) => ({
      slug: r.slug as string,
      titolo: r.titolo as string,
      parole_chiave: (r.parole_chiave as string[]) ?? [],
      campi: (r.campi as CampoModello[]) ?? [],
      dati_fissi: (r.dati_fissi as Record<string, unknown>) ?? {},
    }))
  } catch {
    return []
  }
}

/**
 * Merges the given keys into the existing dati_fissi for the given template.
 * Read-modify-write: existing keys not in `valori` are preserved.
 */
export async function setDatiFissi(
  slug: string,
  valori: Record<string, unknown>,
): Promise<{ ok: boolean; error?: string }> {
  const normalizedSlug = normalizeSlug(slug)
  if (!normalizedSlug) return { ok: false, error: 'slug non valido' }

  const supabase = getSupabaseServer()

  // Read current dati_fissi
  const { data, error: readErr } = await supabase
    .from('document_templates')
    .select('dati_fissi')
    .eq('slug', normalizedSlug)
    .maybeSingle()

  if (readErr) return { ok: false, error: readErr.message }
  if (!data) return { ok: false, error: `Modello "${normalizedSlug}" non trovato` }

  const current = (data as Record<string, unknown>).dati_fissi as Record<string, unknown> ?? {}
  const merged = { ...current, ...valori }

  const { error: writeErr } = await supabase
    .from('document_templates')
    .update({ dati_fissi: merged, updated_at: new Date().toISOString() })
    .eq('slug', normalizedSlug)

  if (writeErr) return { ok: false, error: writeErr.message }
  return { ok: true }
}
