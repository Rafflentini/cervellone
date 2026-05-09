/**
 * Cervellone V19 — E2B sandbox persistence helpers
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js'

let cached: SupabaseClient | null = null

function getSupabase(): SupabaseClient {
  if (cached) return cached
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) {
    throw new Error('Supabase env mancanti per E2B persist')
  }
  cached = createClient(url, key, { auth: { persistSession: false } })
  return cached
}

export async function loadSandboxId(conversationId: string): Promise<string | null> {
  try {
    const sb = getSupabase()
    const { data } = await sb
      .from('e2b_sandboxes')
      .select('sandbox_id, killed_at')
      .eq('conversation_id', conversationId)
      .maybeSingle()
    if (!data || data.killed_at) return null
    return data.sandbox_id
  } catch {
    return null
  }
}

export async function saveSandboxId(conversationId: string, sandboxId: string): Promise<void> {
  try {
    const sb = getSupabase()
    await sb.from('e2b_sandboxes').upsert(
      {
        conversation_id: conversationId,
        sandbox_id: sandboxId,
        last_used: new Date().toISOString(),
      },
      { onConflict: 'conversation_id' },
    )
  } catch (err) {
    console.warn('[v19/sandbox/persist] saveSandboxId failed:', err)
  }
}

export async function markSandboxKilled(conversationId: string): Promise<void> {
  try {
    const sb = getSupabase()
    await sb
      .from('e2b_sandboxes')
      .update({ killed_at: new Date().toISOString() })
      .eq('conversation_id', conversationId)
  } catch (err) {
    console.warn('[v19/sandbox/persist] markSandboxKilled failed:', err)
  }
}
