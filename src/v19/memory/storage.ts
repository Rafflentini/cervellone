/**
 * Cervellone V19 — Memory storage backend (Supabase Storage bucket "memories")
 *
 * Spec: docs/superpowers/specs/2026-05-09-cervellone-v19-rifondazione.md sez. 7
 *
 * Tutte le path sono relative al bucket (es. "raffaele/identita.md"), MAI con
 * prefix "/memories/" — quello è solo nella surface tool. Conversione fatta
 * in handler.ts.
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js'

const BUCKET = 'memories'

let cached: SupabaseClient | null = null

function getSupabase(): SupabaseClient {
  if (cached) return cached
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) {
    throw new Error('Supabase env mancanti per memory storage')
  }
  cached = createClient(url, key, { auth: { persistSession: false } })
  return cached
}

/** Per test: inietta un client mockato. */
export function _setSupabaseClientForTest(client: SupabaseClient | null): void {
  cached = client
}

export async function viewFile(relPath: string): Promise<string | null> {
  const sb = getSupabase()
  const { data, error } = await sb.storage.from(BUCKET).download(relPath)
  if (error || !data) return null
  return await data.text()
}

export async function viewDir(relPathPrefix: string): Promise<string[]> {
  const sb = getSupabase()
  // Supabase list richiede dir + prefix vuoto, oppure dir parent + prefix.
  // Normalizziamo: relPathPrefix può essere "raffaele/" o "raffaele/preferenze".
  const dir = relPathPrefix.endsWith('/') ? relPathPrefix.slice(0, -1) : relPathPrefix
  const { data, error } = await sb.storage.from(BUCKET).list(dir, { limit: 1000 })
  if (error || !data) return []
  return data.map((f) => `${dir}/${f.name}`)
}

export async function createFile(relPath: string, content: string): Promise<void> {
  const sb = getSupabase()
  const { error } = await sb.storage
    .from(BUCKET)
    .upload(relPath, new Blob([content], { type: 'text/markdown' }), {
      upsert: true,
      contentType: 'text/markdown',
    })
  if (error) throw new Error(`memory create failed: ${error.message}`)
}

export async function strReplace(relPath: string, oldStr: string, newStr: string): Promise<void> {
  const current = await viewFile(relPath)
  if (current === null) {
    throw new Error(`file not found: ${relPath}`)
  }
  if (!current.includes(oldStr)) {
    throw new Error(`old_str not found in file ${relPath}`)
  }
  const updated = current.replace(oldStr, newStr)
  await createFile(relPath, updated)
}

export async function insertLine(relPath: string, line: number, text: string): Promise<void> {
  const current = (await viewFile(relPath)) ?? ''
  const lines = current.split('\n')
  const safeLine = Math.max(0, Math.min(line, lines.length))
  lines.splice(safeLine, 0, text)
  await createFile(relPath, lines.join('\n'))
}

export async function deleteFile(relPath: string): Promise<void> {
  const sb = getSupabase()
  const { error } = await sb.storage.from(BUCKET).remove([relPath])
  if (error) throw new Error(`memory delete failed: ${error.message}`)
}

export async function renameFile(oldRelPath: string, newRelPath: string): Promise<void> {
  const sb = getSupabase()
  const { error } = await sb.storage.from(BUCKET).move(oldRelPath, newRelPath)
  if (error) throw new Error(`memory rename failed: ${error.message}`)
}
