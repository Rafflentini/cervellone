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
  formati_output?: string[]
  dove_salvare?: string | null
  mai_inviare?: boolean
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
  'slug, titolo, parole_chiave, tipo_sorgente, metodo, master_drive_id, html_template, campi, formati_output, dove_salvare, mai_inviare'

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
        html_template: input.html_template ?? null,
        campi: input.campi,
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
